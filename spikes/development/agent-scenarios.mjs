import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { privateJSON } from './environment.mjs';
import { agentControl, agentDiagnosticState, saveAgentArtifact } from './agent-control.mjs';
import { scenarioBrowser } from './agent-scenario-browser.mjs';
import { SCENARIOS, scenarioPrompts, assertScenarioReceipt } from './agent-scenario-oracle.mjs';

const failureCodes = new Set(['AGENT_SCENARIO_INVALID', 'AGENT_SCENARIO_DOCTOR_REQUIRED', 'AGENT_SCENARIO_REQUEST_INVALID', 'AGENT_SCENARIO_REQUEST_MISSING',
  'AGENT_SCENARIO_ENDPOINT_MISMATCH', 'AGENT_SCENARIO_HISTORY_MISMATCH', 'AGENT_SCENARIO_HISTORY_MISSING',
  'AGENT_SCENARIO_HISTORY_LIMIT', 'AGENT_SCENARIO_UNEXPECTED_SEND', 'AGENT_SCENARIO_TRACE_LIMIT',
  'AGENT_SCENARIO_PROVIDER_REJECTED', 'AGENT_SCENARIO_PROVIDER_NOT_READY', 'AGENT_SCENARIO_RESPONSE_MISSING', 'AGENT_SCENARIO_UI_CHANGED', 'AGENT_SCENARIO_ROUTE_MISMATCH',
  'AGENT_SCENARIO_STEERING_UNAVAILABLE', 'AGENT_SCENARIO_THINKING_UNAVAILABLE', 'AGENT_SCENARIO_BUDGET_EXHAUSTED', 'AGENT_SCENARIO_RESTART_FAILED',
  'AGENT_SCENARIO_STOP_FAILED', 'AGENT_RUN_TIMED_OUT', 'AGENT_RUN_INTERRUPTED']);
for (const code of ['AGENT_WAIT_TIMED_OUT', 'AGENT_ASSERTION_FAILED', 'AGENT_RUNTIME_CHANGED',
  'AGENT_CDP_INVALID', 'AGENT_CDP_UNAVAILABLE', 'AGENT_CDP_TIMED_OUT', 'AGENT_CDP_REJECTED',
  'AGENT_API_TIMED_OUT', 'AGENT_API_LIMIT', 'AGENT_API_INVALID', 'AGENT_API_REJECTED', 'AGENT_API_UNAVAILABLE']) failureCodes.add(code);

export async function scenarioHistory(control) {
  const rows = [], ids = new Set(); let total;
  for (let offset = 0; offset < 10000; offset += 200) {
    const history = await control('history', [String(offset)]);
    total ??= history?.counts?.prompts;
    if (!Number.isSafeInteger(total) || total < 0 || total > 10000) throw Error('AGENT_SCENARIO_HISTORY_LIMIT');
    if (history.counts.prompts !== total || history.page?.total !== total || history.page.offset !== offset
        || !Array.isArray(history.prompts)) throw Error('AGENT_SCENARIO_HISTORY_MISMATCH');
    for (const row of history.prompts) {
      if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) || ids.has(row.id)) {
        throw Error('AGENT_SCENARIO_HISTORY_MISMATCH');
      }
      rows.push(row); ids.add(row.id);
    }
    if (rows.length === total) return rows;
    if (rows.length > total || history.prompts.length !== 200) throw Error('AGENT_SCENARIO_HISTORY_MISMATCH');
  }
  throw Error('AGENT_SCENARIO_HISTORY_LIMIT');
}

// Only this explicitly selected private command drives provider UI. There is
// no arbitrary prompt, URL, profile, sponsor, shell, publication or retry input.
export async function runAgentScenarios(paths, { sendBudget, doctor, start, stop, signal,
  control: execute = agentControl, browser: openBrowser = scenarioBrowser, save = saveAgentArtifact,
  metadata = () => privateJSON(join(paths.control, 'cdp.json')), wait = delay, now = () => performance.now(),
} = {}) {
  if (sendBudget !== 3) throw Error('AGENT_SCENARIO_INVALID');
  const lock = join(paths.control, 'scenario.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw Error('AGENT_SCENARIO_INVALID'); }
  const report = { profile: 'pap-agent-scenarios/1', runId: randomUUID(), status: 'RUNNING',
    budgets: { providerSends: sendBudget, attemptedSends: 0, anchorTransactions: 0, sponsor: 'DISABLED' },
    mainnet: false, publication: false, deployment: false, phase: 'doctor', trace: [], scenarios: [],
    evidence: 'RETAINED', runtime: 'STOPPED' };
  const prompts = scenarioPrompts(report.runId), requests = [], selected = [];
  let browser, ownedRuntime = false, artifact;
  const check = () => { signal?.throwIfAborted(); browser?.check(); };
  const control = async (action, args = []) => { check(); return execute(paths, action, args); };
  const snapshot = async () => { artifact = await save(paths, 'scenario', report); };
  const requireReady = value => value?.status === 'READY' && value.providerSend === true && value.sponsor === false
    && value.mainnet === false && value.publication === false && value.deployment === false;
  const startRuntime = async () => {
    check();
    const result = await start();
    ownedRuntime = result?.started === true; report.runtime = ownedRuntime ? 'RUNNING' : 'LEFT_INSPECTABLE';
    check();
    if (!requireReady(result) || !ownedRuntime) {
      report.startFailure = { status: ['READY', 'OWNER_ACTION_REQUIRED'].includes(result?.status) ? result.status : 'FAILED' };
      if (typeof result?.reason === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(result.reason)) report.startFailure.reason = result.reason;
      throw Error('AGENT_SCENARIO_RESTART_FAILED');
    }
  };
  try {
    check();
    const ready = await doctor();
    // A cached preflight or an offline doctor cannot authorize live scenarios.
    if (!requireReady(ready) || ready.runtime !== 'STOPPED'
        || !ready.checks?.includes('EXACT_CHROME_CDP_NATIVE_PAIRING') || !ready.checks.includes('RUNTIME_RESTART')) {
      report.status = 'OWNER_ACTION_REQUIRED';
      report.reason = 'AGENT_SCENARIO_DOCTOR_REQUIRED';
      // Doctor reasons are already bounded by the agent command layer.
      report.doctor = { status: ready?.status === 'READY' ? 'READY' : 'OWNER_ACTION_REQUIRED' };
      if (typeof ready?.reason === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(ready.reason)) report.doctor.reason = ready.reason;
      throw Error('AGENT_SCENARIO_DOCTOR_REQUIRED');
    }
    report.doctor = { status: 'READY', restart: true, paired: true };
    check(); report.phase = 'start'; await startRuntime();
    report.phase = 'baseline';
    await control('debug', ['on']);
    const baseline = new Set((await scenarioHistory(control)).map(row => row.id));
    report.baselinePrompts = baseline.size;
    const epoch = (await control('state')).runtimeEpoch;
    await control('recording', ['on']);
    browser = await openBrowser(await metadata(), { trace: report.trace, signal });
    await control('wait', ['sources-ready', '15000']);
    for (let index = 0; index < SCENARIOS.length; index++) {
      check(); report.phase = SCENARIOS[index];
      const request = await browser.send(index, prompts[index], async () => {
        check();
        if (report.budgets.attemptedSends >= sendBudget) throw Error('AGENT_SCENARIO_BUDGET_EXHAUSTED');
        report.budgets.attemptedSends++;
        await snapshot(); check();
      });
      requests.push(request);
      const deadline = now() + 15000;
      let row;
      for (;;) {
        check();
        const rows = await scenarioHistory(control), fresh = rows.filter(value => !baseline.has(value.id) && !selected.includes(value.id));
        if (rows.length !== baseline.size + selected.length + fresh.length || fresh.length > 1) {
          throw Error('AGENT_SCENARIO_HISTORY_MISMATCH');
        }
        if (fresh.length) { [row] = fresh; break; }
        if (now() >= deadline) throw Error('AGENT_SCENARIO_HISTORY_MISSING');
        await wait(100);
      }
      assertScenarioReceipt(row, await control('receipt', [row.id]), prompts[index], request);
      selected.push(row.id);
      report.scenarios.push({ scenario: SCENARIOS[index], requestSequence: index + 1,
        exactText: true, signedRequestIdentity: true, localSave: 'SAVED', survivesRestart: false });
      // Verify the existing Send's receipt now, but let steering input start
      // before waiting for its response. The browser still gates the click on
      // a successful open response, and both responses are checked afterward.
      if (index === 2) await browser.accepted(1);
      if (index !== 1) await browser.accepted(index);
    }
    check(); report.phase = 'restart';
    await control('recording', ['off']);
    await browser.close(); browser = null;
    await stop(); ownedRuntime = false; report.runtime = 'STOPPED';
    await startRuntime();
    if ((await control('state')).runtimeEpoch === epoch) throw Error('AGENT_SCENARIO_RESTART_FAILED');
    const reopened = await scenarioHistory(control);
    if (reopened.length !== baseline.size + 3 || [...baseline].some(id => !reopened.some(row => row.id === id))) {
      throw Error('AGENT_SCENARIO_HISTORY_MISMATCH');
    }
    for (let index = 0; index < 3; index++) {
      const row = reopened.find(value => value.id === selected[index]);
      assertScenarioReceipt(row, await control('receipt', [selected[index]]), prompts[index], requests[index]);
      report.scenarios[index].survivesRestart = true;
    }
    report.status = 'PASS'; report.phase = 'complete';
  } catch (error) {
    if (report.status !== 'OWNER_ACTION_REQUIRED') report.status = 'FAILED';
    report.reason = failureCodes.has(error?.message) ? error.message : 'AGENT_SCENARIO_FAILED';
  } finally {
    if (ownedRuntime || report.status !== 'PASS') {
      // Cleanup and export ignore the run's cancellation signal but keep the
      // underlying APIs' deadlines. Neither action can send or anchor prompts.
      report.state = agentDiagnosticState(await execute(paths, 'dashboard').catch(() => null));
      report.debug = await execute(paths, 'debug', ['export']).catch(() => ({ unavailable: true }));
      if (!ownedRuntime && report.state.available) report.runtime = 'LEFT_INSPECTABLE';
    }
    if (ownedRuntime) {
      await execute(paths, 'recording', ['off']).catch(() => {});
      await execute(paths, 'debug', ['off']).catch(() => {});
      await browser?.close().catch(() => {});
      try { await stop(); report.runtime = 'STOPPED'; }
      catch { report.runtime = 'LEFT_INSPECTABLE'; report.status = 'FAILED'; report.reason ??= 'AGENT_SCENARIO_STOP_FAILED'; }
    }
    try { await snapshot(); } finally { await rmdir(lock); }
  }
  return { ...report, artifact };
}
