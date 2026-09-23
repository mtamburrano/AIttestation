import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { runAgentScenarios, scenarioHistory } from '../spikes/development/agent-scenarios.mjs';
import { scenarioBrowser } from '../spikes/development/agent-scenario-browser.mjs';
import { scenarioReadiness, scenarioResponse, scenarioUI } from '../spikes/development/agent-scenario-readiness.mjs';
import { scenarioPrompts, providerEndpoint, inspectScenarioRequest, assertScenarioReceipt } from '../spikes/development/agent-scenario-oracle.mjs';
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
  for (const module of ['agent-scenarios', 'agent-scenario-browser', 'agent-scenario-oracle', 'agent-scenario-readiness']) {
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

test('steering input is not delayed by awaiting the existing response, while all three responses remain required', async t => {
  const f = await fixture(t), openBrowser = f.dependencies.browser, accepted = [];
  f.dependencies.browser = async (...args) => ({ ...await openBrowser(...args), accepted: async index => {
    accepted.push({ index, sends: f.texts.length, receipts: f.events.filter(value => value === 'receipt').length });
  } });
  const result = await runAgentScenarios(f.paths, f.dependencies);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(accepted, [{ index: 0, sends: 1, receipts: 1 }, { index: 1, sends: 3, receipts: 3 },
    { index: 2, sends: 3, receipts: 3 }]);
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
  assert.deepEqual(result.startFailure, { status: 'OWNER_ACTION_REQUIRED', reason: 'STOP_PREVIOUS_AGENT_SESSION' });
  assert.equal(result.phase, 'start');
  assert.equal(f.events.includes('stop'), false);
  await mkdir(join(f.paths.control, 'scenario.lock'), { mode: 0o700 });
  await assert.rejects(runAgentScenarios(f.paths, f.dependencies), /SCENARIO_INVALID/);
});

test('a changed startup prerequisite retains its bounded reason without exporting arbitrary errors or stopping another session', async t => {
  for (const reason of ['CLOSE_OTHER_CHROME_COPY', 'SECRET browser contents']) {
    const f = await fixture(t);
    f.dependencies.start = async () => ({ status: 'OWNER_ACTION_REQUIRED', reason });
    const result = await runAgentScenarios(f.paths, f.dependencies);
    assert.equal(result.startFailure.reason, reason.startsWith('SECRET') ? undefined : reason);
    assert.equal(result.budgets.attemptedSends, 0); assert.equal(f.events.includes('stop'), false);
    assert.doesNotMatch(await readFile(result.artifact, 'utf8'), /SECRET browser contents/);
  }
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

async function scenarioCDPFixture({ bodyMode = 'inline', deferExistingResponse = false, existingResponseStatus = 200 } = {}) {
  const trace = [], calls = []; let events, inserted, sends = 0, clock = 0, steeringPolls = 0, thinking = false, sendDisabled = false;
  const postData = new Map();
  const connect = async (_metadata, { onEvent }) => {
    events = onEvent;
    return { close() {}, async call(method, params, sessionId) {
      calls.push(method);
      if (method === 'Target.createTarget') return { targetId: 'test-page' };
      if (method === 'Target.attachToTarget') return { sessionId: 'test-session' };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'test-frame' } } };
      if (method === 'Page.navigate') {
        onEvent({ sessionId, method: 'Network.requestWillBeSent', params: { requestId: 'document', frameId: 'test-frame', type: 'Document',
          request: { url: 'https://chatgpt.com/', method: 'GET' } } });
        onEvent({ sessionId, method: 'Network.responseReceived', params: { requestId: 'document', response: { status: 200 } } });
        onEvent({ sessionId, method: 'Network.loadingFinished', params: { requestId: 'document' } });
      }
      if (method === 'Runtime.evaluate') {
        if (inserted && sends === 2) steeringPolls++;
        const composer = { value: inserted ?? '', isContentEditable: true, focus() {}, closest: () => form, getClientRects: () => [{}] };
        const attributes = { type: 'button', innerText: '', hasAttribute: () => true };
        const stop = { ...attributes, disabled: false, getClientRects: () => sends === 2 && !inserted ? [{}] : [], getAttribute: key => key === 'data-testid' ? 'stop-button' : 'Stop streaming' };
        const send = { ...attributes, disabled: sendDisabled || !inserted || sends === 2 && steeringPolls < 3,
          getClientRects: () => [{}], getAttribute: key => key === 'aria-label' ? 'Send prompt' : null,
          getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 40 }), contains: node => node === send };
        const think = { ...attributes, innerText: 'Think', disabled: false, getClientRects: () => [{}],
          getAttribute: key => key === 'aria-pressed' ? String(thinking) : null,
          getBoundingClientRect: () => ({ x: 100, y: 20, width: 30, height: 40 }), contains: node => node === think };
        const form = { querySelectorAll: () => [stop, send, think] };
        const document = { readyState: 'complete', visibilityState: 'visible', hasFocus: () => true,
          querySelector: selector => selector === '#prompt-textarea' ? composer : stop,
          querySelectorAll: selector => selector === 'button' ? [stop, send, think] : [], elementFromPoint: x => x > 100 ? think : send };
        return { result: { value: runInNewContext(params.expression, { document, location: {
          origin: 'https://chatgpt.com', pathname: sends ? '/c/synthetic-conversation' : '/' }, URL }) } };
      }
      if (method === 'Input.insertText') {
        inserted = params.text;
        if (sends === 2 && deferExistingResponse && existingResponseStatus !== null) onEvent({ sessionId, method: 'Network.responseReceived',
          params: { requestId: 'req-1', response: { status: existingResponseStatus } } });
      }
      if (method === 'Network.getRequestPostData') {
        assert.equal(params.requestId, 'req-2'); assert.equal(sessionId, 'test-session');
        if (bodyMode === 'unavailable') throw Error('SECRET_REQUEST_ERROR');
        if (bodyMode === 'wrong-text') return { postData: JSON.stringify(body('SECRET_WRONG_TEXT', 2)) };
        if (bodyMode === 'oversize') return { postData: 'x'.repeat(512 * 1024 + 1) };
        if (bodyMode === 'bad-base64') return { postData: '%%%', base64Encoded: true };
        if (bodyMode === 'invalid-utf8') return { postData: '/w==', base64Encoded: true };
        const text = postData.get(params.requestId);
        return bodyMode === 'base64' ? { postData: Buffer.from(text).toString('base64'), base64Encoded: true } : { postData: text };
      }
      if (method === 'Input.dispatchMouseEvent' && params.x > 100) {
        if (params.type === 'mouseReleased') thinking = !thinking;
        return {};
      }
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown'
          || method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        assert.equal(method, sends === 2 ? 'Input.dispatchMouseEvent' : 'Input.dispatchKeyEvent');
        if (sends === 2) assert.ok(steeringPolls >= 3);
        const index = sends++;
        const requestBody = JSON.stringify(body(inserted, index)); inserted = null;
        postData.set(`req-${index}`, requestBody);
        onEvent({ sessionId, method: 'Network.requestWillBeSent', params: { requestId: `req-${index}`,
          request: { url: `https://chatgpt.com${request(index).path}`, method: 'POST', headers: { Cookie: 'SECRET' },
            hasPostData: true, ...(index === 2 && bodyMode !== 'inline' ? {} : { postData: requestBody }) } } });
        if (!(index === 1 && deferExistingResponse)) onEvent({ sessionId, method: 'Network.responseReceived',
          params: { requestId: `req-${index}`, response: { status: 200, headers: { SECRET: 'SECRET' } } } });
      }
      return {};
    } };
  };
  const browser = await scenarioBrowser({}, { trace, connect, now: () => clock, wait: async ms => { clock += ms; } });
  return { browser, trace, calls, events, get sends() { return sends; },
    finishTurn: () => events({ sessionId: 'test-session', method: 'Network.loadingFinished', params: { requestId: 'req-1' } }),
    disableSend: () => { sendDisabled = true; } };
}

test('CDP browser uses ordinary input once and keeps secrets out of network traces', async () => {
  const f = await scenarioCDPFixture(), { browser, trace, calls, events } = f;
  const prompts = scenarioPrompts('00000000-0000-4000-8000-000000000000'); let consumed = 0;
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await browser.send(index, prompts[index], async () => { consumed++; }), { ...request(index), index });
    await browser.accepted(index);
  }
  assert.equal(consumed, 3); assert.equal(f.sends, 3);
  await assert.rejects(browser.send(3, 'not allowed', async () => { consumed++; }));
  events({ sessionId: 'unrelated-tab', method: 'Network.requestWillBeSent', params: { request: { url: 'SECRET' } } });
  await browser.close();
  assert.doesNotMatch(JSON.stringify(trace), /SYNTHETIC_|SECRET|req-|synthetic-message|synthetic-conversation/);
  assert.ok(calls.includes('Network.enable')); assert.ok(!calls.some(value => /replay|Fetch\.|getResponseBody/.test(value)));
  assert.ok(trace.filter(value => value.event === 'provider-page-settled').length === 2);
  assert.ok(trace.find(value => value.event === 'ui-dispatch').elapsedMs >= 10000);
  assert.equal(trace.filter(value => value.exactSyntheticText === true).length, 3);
  assert.ok(!trace.some(value => value.exactSyntheticText === false));
  assert.equal(trace.find(value => value.event === 'ui-dispatch' && value.scenario === 2).input, 'CDP_SEND_CLICK');
  assert.equal(trace.find(value => value.event === 'ui-dispatch' && value.scenario === 2).priorResponseActive, true);
  assert.deepEqual(trace.filter(value => value.event === 'thinking-mode').map(value => value.changed), [true, false]);
});

test('steering can be composed before response headers arrive, but dispatch still requires the successful open response', async () => {
  for (const existingResponseStatus of [200, 403, null]) {
    const f = await scenarioCDPFixture({ deferExistingResponse: true, existingResponseStatus }); let consumed = 0;
    try {
      for (let index = 0; index < 2; index++) await f.browser.send(index, `SYNTHETIC_${index}`, async () => { consumed++; });
      const result = f.browser.send(2, 'SYNTHETIC_STEERING', async () => { consumed++; });
      if (existingResponseStatus === 200) {
        await result;
        for (let index = 0; index < 3; index++) await f.browser.accepted(index);
        const compose = f.trace.findIndex(value => value.event === 'before-send' && value.scenario === 2);
        const response = f.trace.findIndex(value => value.event === 'response' && value.sequence === 2);
        const dispatch = f.trace.findIndex(value => value.event === 'ui-dispatch' && value.scenario === 2);
        assert.ok(compose < response && response < dispatch);
        assert.equal(f.trace[dispatch].priorResponseActive, true);
        assert.equal(f.sends, 3); assert.equal(consumed, 3);
      } else {
        await assert.rejects(result, existingResponseStatus === 403 ? /AGENT_SCENARIO_PROVIDER_REJECTED/ : /AGENT_SCENARIO_STEERING_UNAVAILABLE/);
        assert.equal(f.sends, 2); assert.equal(consumed, 2);
      }
    } finally { await f.browser.close(); }
  }
});

test('omitted CDP bodies are fetched once for the observed request, including responses received during retrieval', async () => {
  for (const bodyMode of ['omitted', 'base64', 'unavailable', 'wrong-text', 'oversize', 'bad-base64', 'invalid-utf8']) {
    const f = await scenarioCDPFixture({ bodyMode }); let consumed = 0;
    try {
      for (let index = 0; index < 2; index++) {
        await f.browser.send(index, `SYNTHETIC_${index}`, async () => { consumed++; });
        await f.browser.accepted(index);
      }
      const result = f.browser.send(2, 'SYNTHETIC_STEERING_e\u0301 ☕', async () => { consumed++; });
      if (['omitted', 'base64'].includes(bodyMode)) {
        assert.deepEqual(await result, { ...request(2), index: 2 });
        await f.browser.accepted(2);
        const entry = f.trace.find(value => value.scenario === 2 && value.sequence === 3);
        assert.equal(entry.exactSyntheticText, true); assert.equal(entry.bodySource, 'CDP');
        assert.ok(entry.requestBytes > 0);
      } else await assert.rejects(result, /AGENT_SCENARIO_REQUEST_INVALID/, bodyMode);
      assert.equal(f.calls.filter(value => value === 'Network.getRequestPostData').length, 1, bodyMode);
      assert.equal(f.sends, 3); assert.equal(consumed, 3);
      assert.ok(f.trace.some(value => value.event === 'response' && value.sequence === 3));
      assert.doesNotMatch(JSON.stringify(f.trace), /SYNTHETIC_|SECRET|req-|synthetic-message|synthetic-conversation/);
    } finally { await f.browser.close(); }
  }
});

test('steering stops if the prior response finishes or Send becomes disabled during the checkpoint', async () => {
  for (const fault of ['already-finished', 'finished-during-checkpoint', 'disabled-during-checkpoint']) {
    const f = await scenarioCDPFixture(); let consumed = 0;
    try {
      for (let index = 0; index < 2; index++) {
        await f.browser.send(index, `SYNTHETIC_${index}`, async () => { consumed++; });
        await f.browser.accepted(index);
      }
      if (fault === 'already-finished') f.finishTurn();
      await assert.rejects(f.browser.send(2, 'SYNTHETIC_STEERING', async () => {
        consumed++;
        if (fault === 'finished-during-checkpoint') f.finishTurn();
        if (fault === 'disabled-during-checkpoint') f.disableSend();
      }), /AGENT_SCENARIO_STEERING_UNAVAILABLE/, fault);
      assert.equal(f.sends, 2, fault);
      assert.equal(consumed, fault === 'already-finished' ? 2 : 3, fault);
      assert.equal(f.trace.some(value => value.event === 'ui-dispatch' && value.scenario === 2), false, fault);
    } finally { await f.browser.close(); }
  }
});

const normalPage = () => scenarioUI({ provider: true, route: 'new', composer: true, empty: true,
  document: 'complete', visible: true, focused: true });

function readinessFixture() {
  let clock = 0; const trace = [];
  const observer = scenarioReadiness({ now: () => clock, add: value => trace.push(value), mainFrameId: () => 'main' });
  const emit = (method, params) => observer.event({ method, params });
  const begin = (id, url = 'https://chatgpt.com/', type = 'Document') => emit('Network.requestWillBeSent', {
    requestId: id, frameId: 'main', type, request: { url, method: type === 'Document' ? 'GET' : 'POST', headers: { Cookie: 'SECRET' }, postData: 'SECRET' },
  });
  const response = (id, status = 200, headers = {}) => emit('Network.responseReceived', { requestId: id, response: { status, headers } });
  const finish = (id, failed = false) => emit(failed ? 'Network.loadingFailed' : 'Network.loadingFinished', { requestId: id, errorText: 'SECRET' });
  return { observer, trace, emit, begin, response, finish, advance: ms => { clock += ms; } };
}

test('provider readiness waits through transient challenges, redirects, pending preflight and a fresh stable interval', () => {
  const f = readinessFixture(), page = normalPage();
  f.begin('doc'); f.response('doc', 403, { 'CF-Mitigated': 'challenge', 'Set-Cookie': 'SECRET' }); f.finish('doc');
  assert.equal(f.observer.settled({ ...page, challenge: true }), false);
  f.advance(6000); assert.equal(f.observer.settled(page), false);
  f.emit('Network.requestWillBeSent', { requestId: 'doc', type: 'Document', frameId: 'main',
    request: { url: 'https://chatgpt.com/?SECRET', method: 'GET' }, redirectResponse: { status: 302, headers: { Location: 'SECRET' } } });
  f.response('doc'); f.finish('doc'); assert.equal(f.observer.settled(page), false);
  f.advance(5000); assert.equal(f.observer.settled(page), true);
  f.begin('admission', 'https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare?SECRET', 'Fetch');
  f.advance(10000); assert.equal(f.observer.settled(page), false);
  f.response('admission'); assert.equal(f.observer.settled(page), false);
  f.finish('admission'); assert.equal(f.observer.settled(page), false);
  f.advance(4900); assert.equal(f.observer.settled(page), false);
  f.advance(100); assert.equal(f.observer.settled(page), true);
  assert.equal(f.observer.snapshot().states.admission, 'settled');
  assert.ok(f.trace.some(value => value.challenge && value.status === 403));
  assert.ok(f.trace.some(value => value.event === 'readiness-redirect' && value.status === 302));
  assert.doesNotMatch(JSON.stringify(f.trace), /SECRET|https:|Cookie|Location|requestId/);
});

test('visible composer cannot override missing navigation, rejected admission, focus loss or browser interstitials', () => {
  for (const fault of ['missing-document', 'subframe-document', 'pending', 'rejected', 'network-failed', 'challenge', 'background', 'focus', 'loading', 'interstitial', 'dialog']) {
    const f = readinessFixture(), page = normalPage();
    if (fault === 'subframe-document') {
      f.emit('Network.requestWillBeSent', { requestId: 'doc', type: 'Document', frameId: 'subframe', request: { url: 'https://chatgpt.com/', method: 'GET' } });
    } else if (fault !== 'missing-document') f.begin('doc');
    f.response('doc'); f.finish('doc');
    if (['pending', 'rejected', 'network-failed'].includes(fault)) {
      f.begin('admission', 'https://chatgpt.com/backend-api/sentinel/chat-requirements', 'Fetch');
      if (fault !== 'pending') { f.response('admission', fault === 'rejected' ? 403 : 200); f.finish('admission', fault === 'network-failed'); }
    }
    if (fault === 'challenge') page.challenge = true;
    if (fault === 'background') page.visible = false;
    if (fault === 'focus') page.focused = false;
    if (fault === 'loading') page.document = 'interactive';
    if (fault === 'interstitial') f.emit('Page.interstitialShown', {});
    if (fault === 'dialog') f.emit('Page.javascriptDialogOpening', { message: 'SECRET' });
    assert.equal(f.observer.settled(page), false, fault);
    f.advance(60000); assert.equal(f.observer.settled(page), false, fault);
    assert.doesNotMatch(JSON.stringify(f.trace), /SECRET/);
  }
});

test('readiness diagnostics use fixed categories and enums, ignore other hosts and bound event tracking', () => {
  const f = readinessFixture();
  for (const url of ['https://outside.invalid/backend-api/sentinel/chat-requirements', 'https://chatgpt.com.attacker.invalid/cdn-cgi/challenge-platform/SECRET',
    'https://user:SECRET@chatgpt.com/backend-api/sentinel/chat-requirements', 'https://chatgpt.com/backend-api/unknown/SECRET']) {
    f.begin('ignored', url, 'Fetch');
  }
  assert.equal(f.trace.length, 0);
  assert.doesNotMatch(JSON.stringify(scenarioUI({ provider: 'SECRET', route: 'SECRET', document: 'SECRET', arbitrary: 'SECRET',
    controls: [{ kind: 'SECRET', type: 'SECRET', labeled: 'SECRET', arbitrary: 'SECRET' }] })), /SECRET|arbitrary/);
  assert.deepEqual(scenarioResponse({ status: 'SECRET', headers: { SECRET: 'SECRET' }, mimeType: 'SECRET' }), { status: null, challenge: false, contentKind: 'other' });
  assert.equal(scenarioResponse({ status: 403, mimeType: 'application/json' }).contentKind, 'json');
  for (let index = 0; index < 96; index++) f.begin(`id-${index}`, 'https://challenges.cloudflare.com/SECRET', 'Fetch');
  assert.throws(() => f.begin('overflow', 'https://challenges.cloudflare.com/SECRET', 'Fetch'), /TRACE_LIMIT/);
  assert.doesNotMatch(JSON.stringify(f.trace), /SECRET|id-/);
});

test('unsettled provider fails with a content-free artifact, no attempted Send and owned runtime shutdown', async t => {
  const f = await fixture(t); let closed = false, targetClosed = false, clock = 0;
  f.dependencies.browser = async (metadata, options) => scenarioBrowser(metadata, { ...options,
    now: () => clock, wait: async ms => { clock += ms; }, connect: async () => ({
      close() { closed = true; }, async call(method) {
        if (method === 'Target.createTarget') return { targetId: 'test-page' };
        if (method === 'Target.attachToTarget') return { sessionId: 'test-session' };
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        if (method === 'Runtime.evaluate') return { result: { value: { ...normalPage(), challenge: true } } };
        if (method === 'Target.closeTarget') targetClosed = true;
        assert.ok(!method.startsWith('Input.')); return {};
      },
    }) });
  const result = await runAgentScenarios(f.paths, f.dependencies);
  assert.equal(result.reason, 'AGENT_SCENARIO_PROVIDER_NOT_READY');
  assert.equal(result.budgets.attemptedSends, 0); assert.equal(result.runtime, 'STOPPED');
  assert.ok(closed && targetClosed && result.debug && result.artifact);
  assert.ok(result.trace.some(value => value.event === 'page-state' && value.challenge));
});

test('missing or unconfirmed Think selection fails before any provider input and closes its target', async () => {
  for (const mode of [null, { selected: false, x: -1, y: 10 }, { selected: false, x: 10, y: 10 }]) {
    let clock = 0, closed = false, mouseEvents = 0;
    await assert.rejects(scenarioBrowser({}, { trace: [], now: () => clock, wait: async ms => { clock += ms; },
      connect: async (_metadata, { onEvent }) => ({ close() { closed = true; }, async call(method, params, sessionId) {
        if (method === 'Target.createTarget') return { targetId: 'test-page' };
        if (method === 'Target.attachToTarget') return { sessionId: 'test-session' };
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        if (method === 'Page.navigate') {
          onEvent({ sessionId, method: 'Network.requestWillBeSent', params: { requestId: 'doc', type: 'Document', frameId: 'main', request: { url: 'https://chatgpt.com/', method: 'GET' } } });
          onEvent({ sessionId, method: 'Network.responseReceived', params: { requestId: 'doc', response: { status: 200 } } });
          onEvent({ sessionId, method: 'Network.loadingFinished', params: { requestId: 'doc' } });
        }
        if (method === 'Runtime.evaluate') return { result: { value: params.expression.includes('const buttons =') ? mode : normalPage() } };
        assert.ok(!['Input.insertText', 'Input.dispatchKeyEvent'].includes(method));
        if (method === 'Input.dispatchMouseEvent') mouseEvents++;
        return {};
      } }),
    }), /AGENT_SCENARIO_THINKING_UNAVAILABLE/);
    assert.ok(closed); assert.equal(mouseEvents, mode?.x === 10 ? 2 : 0);
  }
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
