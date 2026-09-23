import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgentScenarios, scenarioHistory } from '../spikes/development/agent-scenarios.mjs';
import { scenarioBrowser } from '../spikes/development/agent-scenario-browser.mjs';
import { providerEndpoint, inspectScenarioRequest, assertScenarioReceipt } from '../spikes/development/agent-scenario-oracle.mjs';
import { agentCommand } from '../spikes/development/agent.mjs';
import { agentControl } from '../spikes/development/agent-control.mjs';
import { publishRuntimeState } from '../spikes/development/runtime-state.mjs';
import { OwnerDebugSession } from '../spikes/development/debug-session.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';
import { recordingFixture, until } from './recording-fixture.mjs';

const ready = () => ({ status: 'READY', providerSend: true, sponsor: false, mainnet: false, publication: false,
  deployment: false, started: true, runtime: 'STOPPED', checks: ['EXACT_CHROME_CDP_NATIVE_PAIRING', 'RUNTIME_RESTART'] });
const request = index => ({ path: index === 2 ? '/backend-api/f/steer_turn' : '/backend-api/f/conversation',
  messageId: `synthetic-message-${index}`, conversationId: index ? 'synthetic-conversation' : null });
const body = (text, index = 0) => ({ action: 'next', conversation_id: request(index).conversationId,
  messages: [{ id: request(index).messageId, author: { role: 'user' }, content: { content_type: 'text', parts: [text] } }] });
const row = index => ({ id: `receipt-${index}`, localSave: 'SAVED' });
function preview(index, text) {
  const verified = { structure: 'VALID', integrity: 'VALID', keyAttribution: 'SIGNATURE_VALID', evidence: 'COMPLETE' };
  return { texts: [{ receiptId: row(index).id, preview: text, truncated: false, derivative: false }],
    report: { records: [{ ...verified, localAssertions: [] }, { ...verified, localAssertions: [{
      kind: 'normal-request-observed', request: request(index), textAssociation: 'SIGNED_TEXT_REFERENCE' }] }] } };
}
async function fixture(t) {
  const root = await realpath(await mkdtemp('/private/tmp/agent-scenarios-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { root, control: join(root, 'control') }; await mkdir(paths.control, { mode: 0o700 });
  const texts = [], events = []; let epoch = 0, clock = 0;
  const dependencies = { sendBudget: 3, doctor: async () => { events.push('doctor'); return ready(); },
    start: async () => { events.push('start'); epoch++; return ready(); },
    stop: async () => { events.push('stop'); }, metadata: async () => ({}),
    now: () => clock, wait: async ms => { clock += ms; },
    control: async (_paths, action, args = []) => {
      events.push(action);
      if (action === 'history') return { counts: { prompts: texts.length }, page: { total: texts.length, offset: 0 }, prompts: texts.map((_, index) => row(index)) };
      if (action === 'receipt') { const index = Number(args[0].split('-')[1]); return preview(index, texts[index]); }
      if (action === 'state') return { runtimeEpoch: String(epoch) };
      if (action === 'dashboard') return { available: true, recording: true, SECRET: 'do not export', history: { counts: { prompts: texts.length } } };
      if (action === 'debug') return { unavailable: true };
      return {};
    },
    browser: async (_metadata, { trace }) => ({ check() {}, accepted: async () => {}, close: async () => { events.push('browser-close'); },
      send: async (index, text, consume) => {
        await consume(); texts.push(text); events.push('send');
        trace.push({ method: 'POST', sequence: index + 1, endpoint: request(index).path, exactSyntheticText: true });
        return request(index);
      } }),
  };
  return { paths, dependencies, texts, events };
}

test('live scenario CLI requires exact explicit scope and budget; modules never ship', async () => {
  for (const args of [[], ['--live-provider-send'], ['--agent-mode'], ['--agent-mode', '--live-provider-send', '--mainnet']]) {
    const report = await agentCommand(['scenarios', 'unused', 'build', '3', ...args]);
    assert.equal(report.status, 'OWNER_ACTION_REQUIRED');
  }
  for (const budget of ['0', '2', '4', '03', '-1']) {
    assert.equal((await agentCommand(['scenarios', 'unused', 'build', budget, '--agent-mode', '--live-provider-send'])).status, 'OWNER_ACTION_REQUIRED');
  }
  for (const module of ['agent-scenarios', 'agent-scenario-browser', 'agent-scenario-oracle']) {
    assert.equal(copyApplicationResource(`spikes/development/${module}.mjs`), false);
  }
});

test('doctor must prove a live restart and pairing before any sends or runtime start', async t => {
  const f = await fixture(t);
  for (const doctor of [{ status: 'OWNER_ACTION_REQUIRED', reason: 'PROVIDER_LOGIN_REQUIRED' },
    { ...ready(), providerSend: false }, { ...ready(), sponsor: true }, { ...ready(), checks: [] }]) {
    const result = await runAgentScenarios(f.paths, { ...f.dependencies, doctor: async () => doctor });
    assert.equal(result.status, 'OWNER_ACTION_REQUIRED'); assert.equal(result.budgets.attemptedSends, 0);
    assert.equal(f.events.includes('start'), false); assert.equal(f.texts.length, 0);
    assert.equal((await lstat(result.artifact)).mode & 0o777, 0o600);
  }
});

test('three exact sends are checked again after a fresh epoch; artifacts exclude prompts and private state', async t => {
  const f = await fixture(t), result = await runAgentScenarios(f.paths, f.dependencies);
  assert.equal(result.status, 'PASS'); assert.equal(result.runtime, 'STOPPED');
  assert.equal(result.budgets.attemptedSends, 3); assert.equal(result.budgets.anchorTransactions, 0);
  assert.equal(result.scenarios.length, 3); assert.ok(result.scenarios.every(value => value.survivesRestart));
  assert.equal(f.events.filter(value => value === 'receipt').length, 6);
  assert.equal(f.events.filter(value => value === 'start').length, 2);
  const evidence = await readFile(result.artifact, 'utf8');
  assert.doesNotMatch(evidence, /ATTESTAMP_SYNTHETIC|SECRET|synthetic-message|synthetic-conversation|receipt-/);
  assert.equal((await lstat(result.artifact)).mode & 0o777, 0o600);
});

test('missing capture, extra rows, restart loss and cancellation fail with evidence and no resend', async t => {
  for (const fault of ['missing', 'extra', 'restart-loss', 'ambiguous-send', 'aborted']) {
    const f = await fixture(t), abort = new AbortController(); let restarted = false;
    const original = f.dependencies.control;
    f.dependencies.signal = abort.signal;
    f.dependencies.control = async (paths, action, args) => {
      if (action === 'history' && fault === 'missing' && f.texts.length) return { counts: { prompts: 0 }, page: { total: 0, offset: 0 }, prompts: [] };
      if (action === 'history' && fault === 'extra' && f.texts.length) return { counts: { prompts: 2 }, page: { total: 2, offset: 0 }, prompts: [row(0), row(1)] };
      const result = await original(paths, action, args);
      if (action === 'receipt' && restarted && fault === 'restart-loss') result.texts[0].preview = 'WRONG_BYTES';
      return result;
    };
    const browser = f.dependencies.browser;
    f.dependencies.browser = async (...args) => {
      const value = await browser(...args), send = value.send;
      value.send = async (...args) => {
        const result = await send(...args);
        if (fault === 'ambiguous-send') throw Error('PRIVATE_BROWSER_ERROR');
        if (fault === 'aborted') abort.abort(Error('AGENT_RUN_INTERRUPTED'));
        return result;
      };
      return value;
    };
    f.dependencies.stop = async () => { restarted = true; f.events.push('stop'); };
    const result = await runAgentScenarios(f.paths, f.dependencies);
    assert.equal(result.status, 'FAILED', fault); assert.equal(result.runtime, 'STOPPED');
    assert.equal(result.budgets.attemptedSends, fault === 'restart-loss' ? 3 : 1, fault);
    assert.ok(result.debug); assert.ok(result.state); assert.ok(result.artifact);
    assert.doesNotMatch(await readFile(result.artifact, 'utf8'), /PRIVATE_BROWSER_ERROR|WRONG_BYTES|ATTESTAMP_SYNTHETIC/);
  }
});

test('provider rejection still checks local evidence, stops before the second send and exports diagnostics', async t => {
  const f = await fixture(t), original = f.dependencies.browser;
  f.dependencies.browser = async (...args) => ({ ...await original(...args),
    accepted: async () => { throw Error('AGENT_SCENARIO_PROVIDER_REJECTED'); } });
  const result = await runAgentScenarios(f.paths, f.dependencies);
  assert.equal(result.status, 'FAILED'); assert.equal(result.reason, 'AGENT_SCENARIO_PROVIDER_REJECTED');
  assert.equal(result.budgets.attemptedSends, 1); assert.equal(result.scenarios[0].exactText, true);
  assert.equal(result.scenarios[0].survivesRestart, false); assert.equal(result.runtime, 'STOPPED');
  assert.ok(result.debug); assert.ok(result.artifact);
});

test('a non-started runtime is never stopped on the runner\'s behalf; concurrent runs fail closed', async t => {
  const f = await fixture(t);
  f.dependencies.start = async () => ({ status: 'OWNER_ACTION_REQUIRED', reason: 'STOP_PREVIOUS_AGENT_SESSION' });
  const result = await runAgentScenarios(f.paths, f.dependencies);
  assert.equal(result.status, 'FAILED'); assert.equal(result.budgets.attemptedSends, 0);
  assert.equal(f.events.includes('stop'), false);
  await mkdir(join(f.paths.control, 'scenario.lock'), { mode: 0o700 });
  await assert.rejects(runAgentScenarios(f.paths, f.dependencies), /SCENARIO_INVALID/);
});

test('oracle rejects substring matches, wrong endpoints, wrong identity, truncated previews and invalid signatures', () => {
  const text = 'SYNTHETIC_EXACT_e\u0301 ☕';
  assert.deepEqual(inspectScenarioRequest(JSON.stringify(body(text)), request(0).path, text), request(0));
  assert.throws(() => inspectScenarioRequest(JSON.stringify(body(`${text} extra`)), request(0).path, text));
  assert.throws(() => inspectScenarioRequest(JSON.stringify({ ...body(text), action: 'regenerate' }), request(0).path, text));
  for (const url of ['https://outside.invalid/backend-api/f/conversation', 'https://chatgpt.com/backend-api/f/conversation?x=1',
    'https://chatgpt.com/backend-api/f/unknown', 'https://user@chatgpt.com/backend-api/f/conversation']) assert.equal(providerEndpoint(url, 'POST'), null);
  const valid = preview(0, text); assert.equal(assertScenarioReceipt(row(0), valid, text, request(0)), true);
  for (const mutate of [value => { value.texts[0].truncated = true; }, value => { value.report.records[0].integrity = 'INVALID'; },
    value => { value.report.records[1].localAssertions[0].request.messageId = 'different'; },
    value => { value.report.records[1].localAssertions[0].textAssociation = 'MISSING_OR_INVALID'; }]) {
    const value = structuredClone(valid); mutate(value);
    assert.throws(() => assertScenarioReceipt(row(0), value, text, request(0)), /HISTORY_MISMATCH/);
  }
});

test('history baseline is paginated, bounded and rejects changed totals or duplicate rows', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => row(index));
  const control = async (_action, [offset]) => ({ counts: { prompts: 201 }, page: { total: 201, offset: Number(offset) },
    prompts: rows.slice(Number(offset), Number(offset) + 200) });
  assert.equal((await scenarioHistory(control)).length, 201);
  await assert.rejects(scenarioHistory(async () => ({ counts: { prompts: 10001 } })), /HISTORY_LIMIT/);
  await assert.rejects(scenarioHistory(async () => ({ counts: { prompts: 2 }, page: { total: 2, offset: 0 }, prompts: [row(0), row(0)] })), /HISTORY_MISMATCH/);
});

test('CDP browser uses ordinary input once and keeps secrets out of network traces', async () => {
  const trace = [], calls = []; let events, inserted, sends = 0;
  const connect = async (_metadata, { onEvent }) => {
    events = onEvent;
    return { close() {}, async call(method, params, sessionId) {
      calls.push(method);
      if (method === 'Target.createTarget') return { targetId: 'test-page' };
      if (method === 'Target.attachToTarget') return { sessionId: 'test-session' };
      if (method === 'Runtime.evaluate') return { result: { value: { provider: true,
        route: sends ? 'conversation' : 'new', composer: true, empty: !inserted, active: sends === 2, send: true } } };
      if (method === 'Input.insertText') inserted = params.text;
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
        const index = sends++;
        const requestBody = JSON.stringify(body(inserted, index)); inserted = null;
        onEvent({ sessionId, method: 'Network.requestWillBeSent', params: { requestId: `req-${index}`,
          request: { url: `https://chatgpt.com${request(index).path}`, method: 'POST', headers: { Cookie: 'SECRET' }, postData: requestBody } } });
        onEvent({ sessionId, method: 'Network.responseReceived', params: { requestId: `req-${index}`, response: { status: 200, headers: { SECRET: 'SECRET' } } } });
      }
      return {};
    } };
  };
  const browser = await scenarioBrowser({}, { trace, connect }); let consumed = 0;
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await browser.send(index, `SYNTHETIC_${index}`, async () => { consumed++; }), { ...request(index), index });
    await browser.accepted(index);
  }
  assert.equal(consumed, 3); assert.equal(sends, 3);
  await assert.rejects(browser.send(3, 'not allowed', async () => { consumed++; }));
  events({ sessionId: 'unrelated-tab', method: 'Network.requestWillBeSent', params: { request: { url: 'SECRET' } } });
  await browser.close();
  assert.doesNotMatch(JSON.stringify(trace), /SYNTHETIC_|SECRET|req-|synthetic-message|synthetic-conversation/);
  assert.ok(calls.includes('Network.enable')); assert.ok(!calls.some(value => /replay|Fetch\.|getResponseBody/.test(value)));
});

test('scenario oracle reads real signed encrypted History and survives actual vault reopen', async t => {
  const f = await fixture(t), debug = new OwnerDebugSession(f.paths.control), network = restrictFixtureNetwork(f.paths.root);
  let runtime, starts = 0;
  try {
    runtime = await recordingFixture(f.paths.root, { network, debugSession: debug, diagnostics: debug.diagnostics, tabs: 1,
      installation: { status: async () => ({ integration: 'ENABLED', releaseClass: 'DEVELOPMENT' }) } });
    const result = await runAgentScenarios(f.paths, { sendBudget: 3, doctor: async () => ready(),
      start: async () => {
        if (starts++) await runtime.restart();
        await publishRuntimeState(f.paths.control, runtime.runtime); return ready();
      },
      stop: async () => { await rm(join(f.paths.control, 'runtime.json')); },
      control: agentControl, metadata: async () => ({}),
      browser: async () => {
        await runtime.recording(true);
        return { check() {}, accepted: async () => {}, close: async () => {}, async send(index, text, consume) {
          await consume();
          await runtime.pages.get(17).fetch(`https://chatgpt.com${request(index).path}`,
            { method: 'POST', body: JSON.stringify(body(text, index)) });
          await until(() => runtime.runtime.session.receipts.list().length === index + 1);
          return request(index);
        } };
      },
    });
    assert.equal(result.status, 'PASS', JSON.stringify(result));
    assert.equal(runtime.runtime.session.receipts.list().length, 3);
    assert.ok(result.scenarios.every(value => value.survivesRestart));
    assert.doesNotMatch(await readFile(result.debug.artifact, 'utf8'), /ATTESTAMP_SYNTHETIC|synthetic-conversation/);
  } finally { await runtime?.close(); debug.close(); network.restore(); }
});
