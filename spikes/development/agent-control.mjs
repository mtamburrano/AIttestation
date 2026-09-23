import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AGENT_PROFILE } from './agent-environment.mjs';
import { exists, ownerDirectory, privateJSON, writeNewJSON } from './environment.mjs';
import { validateRuntimeState } from './runtime-state.mjs';
import { agentRequest } from './agent-http.mjs';

export const CONTROL_ACTIONS = ['state', 'dashboard', 'history', 'receipt', 'recording', 'debug', 'wait', 'assert', 'failure-bundle'];
const number = value => /^(0|[1-9][0-9]{0,7})$/.test(value) ? Number(value) : NaN;
const invalid = () => { throw Error('AGENT_COMMAND_INVALID'); };

export function agentCondition(condition) {
  if (condition === 'engine-ready') return state => state.available === true;
  if (condition === 'paired') return state => state.integration?.connected === true;
  if (condition === 'sources-ready') return state => state.integration?.code === 'SOURCES_READY';
  if (condition === 'anchors-settled') return state => state.history?.counts.pendingAnchors === 0;
  if (/^recording=(ON|OFF)$/.test(condition)) return state => state.recording === (condition === 'recording=ON');
  if (/^prompt-count=(0|[1-9][0-9]{0,7})$/.test(condition)) {
    const count = number(condition.split('=')[1]);
    return state => state.history?.counts.prompts === count;
  }
  return invalid();
}

export async function saveAgentArtifact(paths, kind, value) {
  if (!['debug', 'failure', 'scenario'].includes(kind)) return invalid();
  const directory = join(paths.control, 'artifacts');
  await ownerDirectory(paths.control);
  if (!await exists(directory)) await mkdir(directory, { mode: 0o700 });
  await ownerDirectory(directory);
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw Error('AGENT_API_LIMIT');
  const path = join(directory, `${kind}-${randomUUID()}.json`);
  await writeNewJSON(path, value);
  return path;
}

// Failure reports deliberately exclude locators, source URLs, receipt bodies,
// browser console/network data, and arbitrary error messages.
export function agentDiagnosticState(state) {
  return { available: state?.available === true, recording: state?.recording === true,
    paired: state?.integration?.connected === true,
    readySources: Number.isSafeInteger(state?.integration?.readySources) ? state.integration.readySources : 0,
    prompts: Number.isSafeInteger(state?.history?.counts.prompts) ? state.history.counts.prompts : 0,
    pendingAnchors: Number.isSafeInteger(state?.history?.counts.pendingAnchors) ? state.history.counts.pendingAnchors : 0 };
}

export async function agentControl(paths, action, args = [], { request = agentRequest, wait = delay, now = Date.now, signal } = {}) {
  let locator;
  const call = async (route, body = {}) => {
    signal?.throwIfAborted();
    const current = validateRuntimeState(await privateJSON(join(paths.control, 'runtime.json'))).dashboardURL;
    if (locator && current !== locator) throw Error('AGENT_RUNTIME_CHANGED');
    locator = current;
    const result = await request(locator, route, body);
    signal?.throwIfAborted();
    return result;
  };
  const dashboard = () => call('/dashboard/state');
  if (action === 'state' && !args.length) return call('/engine/state');
  if (['dashboard', 'history'].includes(action) && args.length <= 1) {
    const offset = args.length ? number(args[0]) : 0;
    if (!Number.isSafeInteger(offset)) return invalid();
    const state = await call('/dashboard/state', { offset });
    return action === 'history' ? state.history : state;
  }
  if (action === 'receipt' && args.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(args[0])) {
    return call('/receipts/preview', { ids: args, includeEvidence: true });
  }
  if (action === 'recording' && args.length === 1 && ['on', 'off'].includes(args[0])) {
    const state = await call('/engine/state');
    return call('/engine/command', { profile: 'pap-resident-command/2', adapterProfile: state.adapterProfile,
      runtimeEpoch: state.runtimeEpoch, expectedRevision: state.revision, commandId: randomUUID(),
      kind: 'SET_RECORDING', enabled: args[0] === 'on' });
  }
  if (action === 'debug') {
    if (args.length === 1 && args[0] === 'status') return (await dashboard()).debugSession;
    if (args.length === 1 && ['on', 'off'].includes(args[0])) return call('/debug-session/recording', { enabled: args[0] === 'on' });
    if (args.length === 1 && args[0] === 'export') {
      const { content } = await call('/debug-session/export');
      return { artifact: await saveAgentArtifact(paths, 'debug', JSON.parse(content)) };
    }
    if (args.length === 4 && args[0] === 'new' && args[3] === 'acknowledge'
        && args.slice(1, 3).every(value => /^[a-f0-9]{32}$/.test(value))) {
      return call('/debug-session/new', { sessionId: args[1], revision: args[2], acknowledged: true });
    }
  }
  if (['wait', 'assert'].includes(action) && args.length === (action === 'wait' ? 2 : 1)) {
    const check = agentCondition(args[0]), timeoutMs = action === 'wait' ? number(args[1]) : 0;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 120000) return invalid();
    const deadline = now() + timeoutMs;
    for (;;) {
      const state = await dashboard();
      if (check(state)) return { satisfied: true, condition: args[0], state: agentDiagnosticState(state) };
      if (now() >= deadline) throw Error(action === 'wait' ? 'AGENT_WAIT_TIMED_OUT' : 'AGENT_ASSERTION_FAILED');
      await wait(Math.min(200, Math.max(0, deadline - now())));
    }
  }
  if (action === 'failure-bundle' && !args.length) {
    const state = await dashboard().catch(() => null);
    const report = { profile: AGENT_PROFILE, evidence: 'RETAINED', runtimeReachable: state !== null,
      state: agentDiagnosticState(state) };
    return { ...report, artifact: await saveAgentArtifact(paths, 'failure', report) };
  }
  return invalid();
}
