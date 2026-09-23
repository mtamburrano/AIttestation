import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, lstat, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentControl, agentCondition } from '../spikes/development/agent-control.mjs';
import { agentRequest } from '../spikes/development/agent-http.mjs';
import { launchAgentChrome, connectAgentCDP, validateAgentCDP } from '../spikes/development/agent-cdp.mjs';
import { updateAgentStage } from '../spikes/development/agent-stage.mjs';
import { withAgentAwake } from '../spikes/development/agent-awake.mjs';
import { waitForAgentBrowserCleanup } from '../spikes/development/agent-process.mjs';
import { agentDoctor } from '../spikes/development/agent-doctor.mjs';
import { fileInventory } from '../spikes/distribution/inventory.mjs';
import { writeNewJSON } from '../spikes/development/environment.mjs';
import { RUNTIME_STATE_PROFILE } from '../spikes/development/runtime-state.mjs';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';

const locator = `http://127.0.0.1:12345/dashboard#${'a'.repeat(43)}`;
const cdpValue = { profile: 'pap-agent-cdp/1', pid: 42, webSocketDebuggerUrl: 'ws://127.0.0.1:43210/devtools/browser/synthetic-browser' };
async function fixture(t) {
  const root = await realpath(await mkdtemp('/private/tmp/agent-control-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { root, home: root, chromeApplication: join(root, 'browser/Google Chrome.app') };
  for (const name of ['control', 'chrome', 'extension', 'support']) {
    paths[name] = join(root, name); await mkdir(paths[name], { mode: 0o700 });
  }
  await writeNewJSON(join(paths.control, 'runtime.json'), { profile: RUNTIME_STATE_PROFILE, dashboardURL: locator });
  const sentinel = join(paths.support, 'evidence'); await writeFile(sentinel, 'synthetic retained evidence', { mode: 0o600 });
  return { paths, sentinel };
}

test('controls bind recording to the current engine revision and expose only named dashboard operations', async t => {
  const { paths } = await fixture(t), calls = [];
  let recording = false, revision = 7;
  const request = async (url, route, body) => {
    assert.equal(url, locator); calls.push({ route, body });
    if (route === '/engine/state') return { runtimeEpoch: 'epoch', adapterProfile: 'adapter', revision, recording };
    if (route === '/engine/command') {
      assert.equal(body.runtimeEpoch, 'epoch'); assert.equal(body.expectedRevision, revision);
      assert.equal(body.kind, 'SET_RECORDING'); assert.match(body.commandId, /^[a-f0-9-]{36}$/);
      recording = body.enabled; revision++; return { recording, revision };
    }
    if (route === '/dashboard/state') return { available: true, recording, history: { counts: { prompts: 4, pendingAnchors: 0 } },
      integration: { connected: true, code: 'SOURCES_READY', readySources: 1 } };
    return { status: 'test' };
  };
  assert.equal((await agentControl(paths, 'recording', ['on'], { request })).recording, true);
  assert.equal((await agentControl(paths, 'recording', ['off'], { request })).recording, false);
  assert.equal((await agentControl(paths, 'history', ['200'], { request })).counts.prompts, 4);
  for (const condition of ['paired', 'engine-ready', 'recording=OFF', 'prompt-count=4', 'anchors-settled', 'sources-ready']) {
    assert.equal((await agentControl(paths, 'assert', [condition], { request })).satisfied, true);
  }
  for (const [action, args] of [['capture', []], ['recording', ['yes']], ['history', ['-1']], ['debug', ['new']],
    ['debug', ['new', 'a'.repeat(32), 'b'.repeat(32), 'yes']], ['wait', ['unknown', '1']]]) {
    await assert.rejects(agentControl(paths, action, args, { request }), /AGENT_COMMAND_INVALID/);
  }
  assert.ok(calls.every(call => !/capture|observe|send/.test(call.route)));
});

test('waits time out, cancel and reject replacement runtime locators without retrying controls', async t => {
  const { paths, sentinel } = await fixture(t);
  let now = 0;
  await assert.rejects(agentControl(paths, 'wait', ['paired', '400'], {
    request: async () => ({ integration: { connected: false } }), now: () => now, wait: async ms => { now += ms; },
  }), /AGENT_WAIT_TIMED_OUT/);
  assert.equal(now, 400);
  await assert.rejects(agentControl(paths, 'recording', ['on'], { request: async () => {
    await writeFile(join(paths.control, 'runtime.json'), JSON.stringify({ profile: RUNTIME_STATE_PROFILE,
      dashboardURL: locator.replace('12345', '12346') }));
    return { revision: 1 };
  } }), /AGENT_RUNTIME_CHANGED/);
  const aborted = AbortSignal.abort(Error('TEST_INTERRUPTED'));
  await assert.rejects(agentControl(paths, 'state', [], { signal: aborted, request: () => assert.fail() }), /TEST_INTERRUPTED/);
  assert.equal(await readFile(sentinel, 'utf8'), 'synthetic retained evidence');
});

test('debug export and failure artifacts are exclusive, owner-only, bounded and never reset journals', async t => {
  const { paths, sentinel } = await fixture(t), calls = [];
  const request = async (_url, route, body) => {
    calls.push({ route, body });
    if (route === '/debug-session/export') return { content: JSON.stringify({ profile: 'synthetic-debug', events: [] }) };
    return { available: true, recording: true, privateError: 'SECRET', sourceURL: 'SECRET', debugSession: { state: 'STOPPED' } };
  };
  assert.equal((await agentControl(paths, 'debug', ['status'], { request })).state, 'STOPPED');
  await agentControl(paths, 'debug', ['off'], { request });
  await agentControl(paths, 'debug', ['new', 'a'.repeat(32), 'b'.repeat(32), 'acknowledge'], { request });
  const exported = await agentControl(paths, 'debug', ['export'], { request });
  const failure = await agentControl(paths, 'failure-bundle', [], { request });
  for (const path of [exported.artifact, failure.artifact]) assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(failure.artifact, 'utf8'), /SECRET|dashboard|127\.0\.0\.1/);
  assert.equal(await readFile(sentinel, 'utf8'), 'synthetic retained evidence');
  assert.deepEqual(calls.find(call => call.route === '/debug-session/new').body,
    { sessionId: 'a'.repeat(32), revision: 'b'.repeat(32), acknowledged: true });
});

test('HTTP control authenticates numeric loopback directly and bounds errors, redirects and responses', async () => {
  const requestHTTP = (statusCode, responseBody, inspect = () => {}) => (options, callback) => {
    inspect(options);
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = bytes => {
      assert.equal(bytes, '{}');
      queueMicrotask(() => { const response = new PassThrough(); response.statusCode = statusCode;
        callback(response); response.end(responseBody); });
    };
    return req;
  };
  assert.deepEqual(await agentRequest(locator, '/engine/state', {}, { requestHTTP: requestHTTP(200, '{"ok":true}', options => {
    assert.equal(options.hostname, '127.0.0.1'); assert.equal(options.method, 'POST');
    assert.equal(options.headers.Origin, 'http://127.0.0.1:12345');
    assert.equal(options.headers.Authorization, `Bearer ${'a'.repeat(43)}`);
  }) }), { ok: true });
  await assert.rejects(agentRequest(locator, '/engine/state', {}, { requestHTTP: requestHTTP(302, 'PRIVATE_ERROR') }), /AGENT_API_REJECTED/);
  await assert.rejects(agentRequest(locator, '/engine/state', {}, { requestHTTP: requestHTTP(200, 'x'.repeat(2 * 1024 * 1024 + 1)) }), /AGENT_API_LIMIT/);
  assert.throws(() => agentRequest(locator.replace('127.0.0.1', 'outside.invalid'), '/engine/state'), /RUNTIME_STATE/);
});

test('staging replaces only the stable agent path while stopped and retains previous bytes', async t => {
  const { paths, sentinel } = await fixture(t); await rm(join(paths.control, 'runtime.json'));
  const source = join(paths.root, 'build-extension'); await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'manifest.json'), '{"fixture":1}');
  const options = { processes: () => [] };
  await updateAgentStage(paths, source, await fileInventory(source), options);
  const stage = join(paths.extension, 'current');
  assert.equal(await readFile(join(stage, 'manifest.json'), 'utf8'), '{"fixture":1}');
  await writeFile(join(source, 'manifest.json'), '{"fixture":2}');
  await assert.rejects(updateAgentStage(paths, source, await fileInventory(source), { processes: () => [{ pid: 2 }] }), /STOP_PREVIOUS/);
  assert.equal(await readFile(join(stage, 'manifest.json'), 'utf8'), '{"fixture":1}');
  await updateAgentStage(paths, source, await fileInventory(source), options);
  assert.equal(await readFile(join(stage, 'manifest.json'), 'utf8'), '{"fixture":2}');
  assert.ok((await fileInventory(paths.extension)).some(file => file.path.startsWith('previous-')));
  await rm(stage, { recursive: true }); await symlink(paths.support, stage);
  await assert.rejects(updateAgentStage(paths, source, await fileInventory(source), options));
  assert.equal(await readFile(sentinel, 'utf8'), 'synthetic retained evidence');
});

function child() {
  const child = new EventEmitter(); child.pid = 42; child.exitCode = null; child.unref = () => {};
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
  return child;
}
test('agent Chrome launches the exact process with loopback CDP and private connection metadata', async t => {
  const { paths } = await fixture(t), chrome = { application: paths.chromeApplication,
    executable: join(paths.chromeApplication, 'Contents/MacOS/Google Chrome') };
  let launched;
  const browser = await launchAgentChrome(chrome, paths, { processes: () => [],
    spawnProcess: (command, args, options) => {
      assert.equal(command, chrome.executable); assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
      assert.ok(args.includes('--remote-debugging-port=0')); assert.ok(args.includes(`--user-data-dir=${paths.chrome}`));
      assert.ok(!args.some(value => value.includes('remote-allow-origins')));
      assert.deepEqual(options.env, { HOME: paths.home, PATH: '/usr/bin:/bin' });
      launched = child(); return launched;
    },
    launch: async (_chrome, _paths, _url, options) => {
      options.spawnProcess(chrome.executable, [`--user-data-dir=${paths.chrome}`, 'about:blank'],
        { env: { HOME: paths.home, PATH: '/usr/bin:/bin' } });
      await writeFile(join(paths.chrome, 'DevToolsActivePort'), '43210\n/devtools/browser/synthetic-browser\n');
      return { pid: 42 };
    } });
  assert.deepEqual(browser.value, cdpValue);
  assert.equal((await lstat(browser.metadata)).mode & 0o777, 0o600);
  await browser.close(); assert.equal(launched.exitCode, 0);
  await assert.rejects(lstat(browser.metadata), { code: 'ENOENT' });
  for (const endpoint of ['ws://outside.invalid:1234/devtools/browser/a', 'ws://localhost:1234/devtools/browser/a',
    'wss://127.0.0.1:1234/devtools/browser/a', 'ws://127.0.0.1:1234/devtools/browser/a?token=x']) {
    assert.throws(() => validateAgentCDP({ ...cdpValue, webSocketDebuggerUrl: endpoint }), /AGENT_CDP_INVALID/);
  }
});

test('owned Chrome tolerates persistent version metadata but retains its locator until singleton cleanup succeeds', async t => {
  for (const stale of [false, true]) {
    const { paths, sentinel } = await fixture(t), marker = join(paths.chrome, 'RunningChromeVersion');
    const singleton = join(paths.chrome, 'SingletonLock');
    const chrome = { application: paths.chromeApplication, executable: join(paths.chromeApplication, 'Contents/MacOS/Google Chrome') };
    let owned, elapsed = 0;
    const browser = await launchAgentChrome(chrome, paths, { processes: () => [],
      spawnProcess: () => { owned = child(); return owned; },
      launch: async (_chrome, _paths, _url, options) => {
        options.spawnProcess(chrome.executable, ['about:blank'], {});
        await symlink('153.0.8010.53:1', marker);
        await symlink('synthetic-host-99', singleton);
        await writeFile(join(paths.chrome, 'DevToolsActivePort'), '43210\n/devtools/browser/synthetic-browser\n');
        return { pid: owned.pid };
      },
      waitForCleanup: async paths => {
        assert.equal(owned.exitCode, 0);
        await waitForAgentBrowserCleanup(paths, { timeoutMs: 100, now: () => elapsed,
          wait: async ms => {
            assert.equal((await lstat(join(paths.control, 'cdp.json'))).isFile(), true);
            elapsed += ms;
            if (!stale) await rm(singleton);
          } });
      } });
    if (stale) {
      await assert.rejects(browser.close(), /AGENT_BROWSER_CLOSE_TIMED_OUT/);
      assert.equal((await lstat(singleton)).isSymbolicLink(), true);
      assert.equal(elapsed, 100);
      assert.equal((await lstat(browser.metadata)).isFile(), true);
    } else {
      await browser.close();
      await assert.rejects(lstat(browser.metadata), { code: 'ENOENT' });
    }
    assert.equal(await readlink(marker), '153.0.8010.53:1');
    assert.equal(await readFile(sentinel, 'utf8'), 'synthetic retained evidence');
  }
});

test('CDP supports DOM inspection and actual console/network event subscription with bounded calls', async () => {
  const events = [], calls = [];
  class Socket extends EventTarget {
    constructor(url) { super(); assert.equal(url, cdpValue.webSocketDebuggerUrl); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(bytes) {
      const message = JSON.parse(bytes); calls.push(message);
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result: { synthetic: true } }) }));
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: 'fixture' } }) }));
      });
    }
    close() {}
  }
  const cdp = await connectAgentCDP(cdpValue, { WebSocketClass: Socket, onEvent: event => events.push(event) });
  for (const method of ['DOM.getDocument', 'Runtime.enable', 'Network.enable']) await cdp.call(method, {}, 'page-session');
  assert.equal(events.length, 3); assert.equal(calls[2].sessionId, 'page-session');
  cdp.close(); await assert.rejects(cdp.call('Browser.getVersion'), /AGENT_CDP_INVALID/);
});

test('doctor checks real lifecycle order, fresh epochs, CDP pairing and preserves failed runtime', async t => {
  const { paths } = await fixture(t); await writeNewJSON(join(paths.control, 'cdp.json'), cdpValue);
  const calls = []; let epoch = 0;
  const dependencies = { preflight: async () => ({ status: 'READY' }),
    start: async () => { calls.push('start'); epoch++; return { status: 'READY' }; },
    stop: async () => { calls.push('stop'); },
    control: async (_paths, action) => { calls.push(action); return { runtimeEpoch: String(epoch) }; },
    connect: async () => ({ close() { calls.push('cdp-close'); }, call: async method => { calls.push(method); return { targetId: 'fixture' }; } }) };
  const report = await agentDoctor(paths, true, dependencies);
  assert.equal(report.status, 'READY'); assert.equal(calls.filter(value => value === 'stop').length, 2);
  assert.deepEqual(report.budgets, { providerSends: 0, anchorTransactions: 0, sponsor: 'DISABLED' });
  calls.length = 0;
  const failure = await agentDoctor(paths, true, { ...dependencies, control: async () => { throw Error('SECRET'); } });
  assert.equal(failure.status, 'OWNER_ACTION_REQUIRED'); assert.ok(!calls.includes('stop'));
  assert.doesNotMatch(JSON.stringify(failure), /SECRET/);
});

test('bounded runs hold idle sleep only for their process and release on success, failure and interruption', async () => {
  for (const outcome of ['success', 'failure', 'interrupt', 'spawn-failure']) {
    let hold, invoked = false;
    const operation = withAgentAwake(10, async signal => {
      invoked = true;
      if (outcome === 'failure') throw Error('TEST_FAILURE');
      if (outcome === 'interrupt') {
        queueMicrotask(() => process.emit('SIGTERM'));
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        signal.throwIfAborted();
      }
      return 'done';
    }, { spawnProcess: (command, args, options) => {
      assert.equal(command, '/usr/bin/caffeinate'); assert.deepEqual(args, ['-i', '-t', '10', '-w', String(process.pid)]);
      assert.deepEqual(options.env, { PATH: '/usr/bin:/bin' }); hold = child();
      queueMicrotask(() => hold.emit(outcome === 'spawn-failure' ? 'error' : 'spawn', Error('SECRET'))); return hold;
    } });
    if (outcome === 'success') assert.equal(await operation, 'done'); else await assert.rejects(operation);
    assert.equal(hold.exitCode, 0); assert.equal(invoked, outcome !== 'spawn-failure');
  }
});

test('standalone CLI emits one JSON result without config rediscovery or raw errors; controls never ship', () => {
  const result = spawnSync(process.execPath, ['spikes/development/agent-cli.mjs', 'capture', 'unknown', '--agent-mode'],
    { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).reason, 'AGENT_COMMAND_INVALID');
  for (const module of ['agent-cli', 'agent-control', 'agent-cdp', 'agent-doctor', 'agent-stage', 'agent-awake']) {
    assert.equal(copyApplicationResource(`spikes/development/${module}.mjs`), false);
  }
  assert.throws(() => agentCondition('prompt-count=-1'), /AGENT_COMMAND_INVALID/);
});
