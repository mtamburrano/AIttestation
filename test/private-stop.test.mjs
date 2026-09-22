import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, writeFile, rm, unlink, chmod, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { initializeAccount, exists, writeNewJSON } from '../spikes/development/environment.mjs';
import { stopDevelopment, registerNativeHost } from '../spikes/development/cli.mjs';
import { RUNTIME_STATE_PROFILE } from '../spikes/development/runtime-state.mjs';
import { developmentCommandFailure } from '../spikes/development/startup.mjs';

async function fixture(t, behavior = 'normal') {
  const root = await realpath(await mkdtemp('/private/tmp/attestamp-stop-test-'));
  const paths = { home: root, control: join(root, 'control'), support: join(root, 'evidence'), chrome: join(root, 'browser') };
  await initializeAccount(paths);
  const state = join(paths.control, 'runtime.json'), launch = join(paths.control, 'launch.json');
  await registerNativeHost(paths, join(root, 'synthetic-browser-host'));
  await writeNewJSON(launch, { profile: 'pap-private-development/1', mode: 'live-chatgpt-testnet', chromeApplication: '/synthetic/Chrome.app' });
  await writeFile(join(paths.support, 'retained-evidence'), 'EVIDENCE_CANARY');
  await writeFile(join(paths.chrome, 'Preferences'), 'BROWSER_CANARY');
  const token = randomBytes(32).toString('base64url');
  let requests = 0, origin, drained = false;
  const server = createServer(async (req, res) => {
    requests++;
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/engine/exit');
    assert.equal(req.headers.authorization, `Bearer ${token}`); assert.equal(req.headers.origin, origin);
    assert.equal(req.headers.host, new URL(origin).host);
    let body = ''; for await (const bytes of req) body += bytes;
    assert.equal(body, '{}');
    if (behavior === 'reset') { req.socket.destroy(); return; }
    if (behavior === 'timeout') return;
    if (behavior === 'reject') { res.writeHead(403); res.end('PRIVATE_RESPONSE_CANARY'); return; }
    if (behavior === 'redirect') { res.writeHead(307, { Location: 'https://external.invalid/' }); res.end(); return; }
    if (behavior === 'oversize') { res.end('x'.repeat(129)); return; }
    if (behavior === 'invalid') { res.end('{"exiting":false,"token":"PRIVATE_RESPONSE_CANARY"}'); return; }
    res.end('{"exiting":true}');
    if (behavior === 'normal') {
      setTimeout(async () => { drained = true; await unlink(state); }, 50);
    }
    if (behavior === 'replacement') {
      await writeFile(state, JSON.stringify({ profile: RUNTIME_STATE_PROFILE,
        dashboardURL: `${origin}/dashboard#${'z'.repeat(43)}` }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const locator = { profile: RUNTIME_STATE_PROFILE, dashboardURL: `${origin}/dashboard#${token}` };
  await writeNewJSON(state, locator);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, paths, state, launch, locator, server, requests: () => requests, drained: () => drained,
    registration: join(paths.chrome, 'NativeMessagingHosts/ai.provenance.consumer.json') };
}

test('stop handles the retained locator shape, waits for drain and preserves evidence and browser bytes', async t => {
  const f = await fixture(t);
  const pending = stopDevelopment(f.paths);
  assert.equal(await exists(f.registration), true);
  assert.deepEqual(await pending, { stopped: true, evidence: 'RETAINED', browser: 'CLOSE_TEST_CHROME_MANUALLY' });
  assert.equal(f.drained(), true); assert.equal(f.requests(), 1);
  for (const path of [f.state, f.launch, f.registration, join(f.paths.control, 'registration.json')]) assert.equal(await exists(path), false);
  assert.equal(await readFile(join(f.paths.support, 'retained-evidence'), 'utf8'), 'EVIDENCE_CANARY');
  assert.equal(await readFile(join(f.paths.chrome, 'Preferences'), 'utf8'), 'BROWSER_CANARY');
  assert.equal((await stopDevelopment(f.paths)).stopped, true);
});

test('stop cleans up an already-exited direct listener without signalling any PID', async t => {
  const f = await fixture(t); await new Promise(resolve => f.server.close(resolve));
  assert.equal((await stopDevelopment(f.paths)).stopped, true);
  assert.equal(await exists(f.state), false); assert.equal(await exists(f.registration), false);
  assert.equal(f.requests(), 0);
});

test('stop reconciles late exit after the request deadline without retrying or premature cleanup', async t => {
  const f = await fixture(t, 'timeout');
  let waits = 0;
  const result = await stopDevelopment(f.paths, { wait: async milliseconds => {
    assert.equal(milliseconds, 100);
    for (const path of [f.state, f.launch, f.registration, join(f.paths.control, 'registration.json')]) {
      assert.equal(await exists(path), true, 'control state is retained until the original runtime exits');
    }
    if (++waits === 2) {
      await unlink(f.state);
      await new Promise(resolve => f.server.close(resolve));
    }
  } });
  assert.deepEqual(result, { stopped: true, evidence: 'RETAINED', browser: 'CLOSE_TEST_CHROME_MANUALLY' });
  assert.equal(waits, 2); assert.equal(f.requests(), 1);
  for (const path of [f.state, f.launch, f.registration, join(f.paths.control, 'registration.json')]) {
    assert.equal(await exists(path), false);
  }
  assert.equal(await readFile(join(f.paths.support, 'retained-evidence'), 'utf8'), 'EVIDENCE_CANARY');
  assert.equal(await readFile(join(f.paths.chrome, 'Preferences'), 'utf8'), 'BROWSER_CANARY');
});

test('stop accepts locator disappearance before timeout reconciliation begins', async t => {
  const f = await fixture(t, 'timeout');
  let requests = 0;
  const result = await stopDevelopment(f.paths, {
    requestExit: async url => {
      assert.equal(url.href, f.locator.dashboardURL); requests++;
      await unlink(f.state);
      throw Error('PRIVATE_STOP_EXIT_TIMED_OUT');
    },
    wait: async () => assert.fail('an exited runtime needs no more drain polling'),
  });
  assert.equal(result.stopped, true); assert.equal(requests, 1);
  assert.equal(await exists(f.registration), false); assert.equal(await exists(f.launch), false);
});

test('timeout reconciliation never requests exit from or cleans up a replacement runtime', async t => {
  for (const identity of ['bearer', 'endpoint']) for (const replacementAt of [0, 1, 300]) {
    await t.test(`${identity} replacement at drain poll ${replacementAt}`, async t => {
      const f = await fixture(t, 'timeout');
      const controlFiles = [f.state, f.launch, f.registration, join(f.paths.control, 'registration.json')];
      const bytes = () => Promise.all(controlFiles.map(path => readFile(path, 'utf8')));
      let replacementBytes, requests = 0, waits = 0;
      const replace = async () => {
        const url = new URL(f.locator.dashboardURL);
        if (identity === 'bearer') url.hash = randomBytes(32).toString('base64url');
        else url.port = url.port === '12345' ? '12346' : '12345';
        await writeFile(f.state, JSON.stringify({ ...f.locator, dashboardURL: url.href }));
        const launch = JSON.parse(await readFile(f.launch, 'utf8'));
        await writeFile(f.launch, JSON.stringify({ ...launch, chromeApplication: '/synthetic/replacement/Chrome.app' }));
        const registration = JSON.parse(await readFile(f.registration, 'utf8'));
        const manifest = JSON.stringify({ ...registration, path: join(f.root, 'replacement-browser-host') });
        await writeFile(f.registration, manifest);
        await writeFile(join(f.paths.control, 'registration.json'), manifest);
        replacementBytes = await bytes();
      };
      await assert.rejects(stopDevelopment(f.paths, {
        requestExit: async url => {
          assert.equal(url.href, f.locator.dashboardURL); requests++;
          if (replacementAt === 0) await replace();
          throw Error('PRIVATE_STOP_EXIT_TIMED_OUT');
        },
        wait: async () => { if (++waits === replacementAt) await replace(); },
      }), error => {
        assert.equal(developmentCommandFailure(error), 'PRIVATE_STOP_RUNTIME_CHANGED'); return true;
      });
      assert.equal(requests, 1); assert.equal(waits, replacementAt);
      assert.deepEqual(await bytes(), replacementBytes);
      assert.equal(await readFile(join(f.paths.support, 'retained-evidence'), 'utf8'), 'EVIDENCE_CANARY');
      assert.equal(await readFile(join(f.paths.chrome, 'Preferences'), 'utf8'), 'BROWSER_CANARY');
    });
  }
});

test('request failures and refusal to drain retain control state and emit bounded labels', async t => {
  for (const [behavior, label] of [['reset', 'EXIT_CONNECTION_FAILED'], ['reject', 'EXIT_REJECTED'],
    ['redirect', 'EXIT_REJECTED'], ['oversize', 'EXIT_INVALID_RESPONSE'], ['invalid', 'EXIT_INVALID_RESPONSE'],
    ['timeout', 'EXIT_TIMED_OUT'], ['no-drain', 'STILL_DRAINING'], ['replacement', 'RUNTIME_CHANGED']]) {
    await t.test(behavior, async t => {
      const f = await fixture(t, behavior);
      const controlFiles = [f.state, f.launch, f.registration, join(f.paths.control, 'registration.json')];
      const bytes = () => Promise.all(controlFiles.map(path => readFile(path, 'utf8')));
      const before = await bytes(); let waitedMs = 0;
      await assert.rejects(stopDevelopment(f.paths, { wait: async milliseconds => { waitedMs += milliseconds; } }), error => {
        assert.equal(error.message, `PRIVATE_STOP_${label}`);
        assert.equal(developmentCommandFailure(error), `PRIVATE_STOP_${label}`); return true;
      });
      assert.equal(await exists(f.state), true); assert.equal(await exists(f.registration), true);
      assert.equal(await exists(f.launch), true);
      assert.equal(f.requests(), 1);
      if (behavior !== 'replacement') {
        assert.deepEqual(await bytes(), before);
        assert.equal(waitedMs, ['timeout', 'no-drain'].includes(behavior) ? 30000 : 0);
      }
    });
  }
});

test('unsafe locators and malformed runtime URLs fail before a network request or cleanup', async t => {
  for (const mutation of ['mode', 'symlink', 'hardlink', 'json', 'profile', 'extra', 'hostname',
    'credentials', 'query', 'token', 'noncanonical', 'port', 'invalid-url']) {
    await t.test(mutation, async t => {
      const f = await fixture(t);
      let expected = 'RUNTIME_INVALID';
      if (mutation === 'mode') { await chmod(f.state, 0o644); expected = 'RUNTIME_UNREADABLE'; }
      else if (mutation === 'symlink') {
        const target = join(f.root, 'unrelated'); await writeNewJSON(target, f.locator); await unlink(f.state); await symlink(target, f.state);
        expected = 'RUNTIME_UNREADABLE';
      } else if (mutation === 'hardlink') { await link(f.state, join(f.root, 'unrelated')); expected = 'RUNTIME_UNREADABLE'; }
      else if (mutation === 'json') { await writeFile(f.state, 'PRIVATE_JSON_CANARY'); expected = 'RUNTIME_UNREADABLE'; }
      else {
        const value = { ...f.locator };
        if (mutation === 'profile') value.profile = 'unknown';
        if (mutation === 'extra') value.extra = 'PRIVATE_CANARY';
        if (mutation === 'hostname') value.dashboardURL = value.dashboardURL.replace('127.0.0.1', 'localhost');
        if (mutation === 'credentials') value.dashboardURL = value.dashboardURL.replace('http://', 'http://secret@');
        if (mutation === 'query') value.dashboardURL = value.dashboardURL.replace('#', '?secret#');
        if (mutation === 'token') value.dashboardURL = value.dashboardURL.slice(0, -1);
        if (mutation === 'noncanonical') value.dashboardURL = value.dashboardURL.replace('127.0.0.1', '127.1');
        if (mutation === 'port') value.dashboardURL = `http://127.0.0.1:80/dashboard#${'a'.repeat(43)}`;
        if (mutation === 'invalid-url') value.dashboardURL = 'PRIVATE_URL_CANARY';
        await writeFile(f.state, JSON.stringify(value));
      }
      await assert.rejects(stopDevelopment(f.paths), { message: `PRIVATE_STOP_${expected}` });
      assert.equal(f.requests(), 0); assert.equal(await exists(f.registration), true);
    });
  }
});

test('account, launch and registration guards keep precise diagnostics and ownership checks', async t => {
  const f = await fixture(t); await unlink(f.state);
  await chmod(join(f.paths.control, 'account.json'), 0o644);
  await assert.rejects(stopDevelopment(f.paths), /PRIVATE_STOP_ACCOUNT_INVALID/);
  await chmod(join(f.paths.control, 'account.json'), 0o600);
  await chmod(f.launch, 0o644);
  await assert.rejects(stopDevelopment(f.paths), /PRIVATE_STOP_LAUNCH_UNREADABLE/);
  await chmod(f.launch, 0o600);
  await writeFile(f.launch, JSON.stringify({ profile: 'unknown' }));
  await assert.rejects(stopDevelopment(f.paths), /PRIVATE_STOP_LAUNCH_INVALID/);
  await writeFile(f.launch, JSON.stringify({ profile: 'pap-private-development/1', mode: 'live-chatgpt-testnet' }));
  await writeFile(f.registration, '{}');
  await assert.rejects(stopDevelopment(f.paths), /PRIVATE_STOP_REGISTRATION_CLEANUP_FAILED/);
  assert.equal(await readFile(f.registration, 'utf8'), '{}');
  assert.equal(await exists(f.launch), true);
});

test('private exit stays direct when the inherited proxy would drop the request', async t => {
  const f = await fixture(t); let proxyRequests = 0;
  const proxy = createServer(req => { proxyRequests++; req.socket.destroy(); });
  proxy.on('connect', (_req, socket) => { proxyRequests++; socket.destroy(); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const script = `import { stopDevelopment } from ${JSON.stringify(new URL('../spikes/development/cli.mjs', import.meta.url).href)};
    await stopDevelopment(JSON.parse(process.argv[1])); console.log('STOPPED');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.paths)], {
    env: { PATH: '/usr/bin:/bin', NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, killSignal: 'SIGKILL',
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr); assert.equal(stdout.trim(), 'STOPPED');
  assert.equal(proxyRequests, 0); assert.equal(f.requests(), 1);
});

test('stop shuts down a separate real engine and retains its durable vault', async t => {
  const f = await fixture(t); await new Promise(resolve => f.server.close(resolve));
  const child = spawn(process.execPath, [new URL('./fixtures/private-stop-engine.mjs', import.meta.url).pathname,
    JSON.stringify(f.paths)], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const exited = once(child, 'exit');
  assert.equal((await once(child.stdout, 'data'))[0].toString().trim(), 'READY');
  assert.equal((await stopDevelopment(f.paths)).stopped, true);
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(await exists(f.state), false); assert.equal(await exists(f.registration), false);
  assert.ok((await readFile(join(f.paths.support, 'vault/vault.sqlite'))).length > 0);
  assert.equal(await readFile(join(f.paths.support, 'retained-evidence'), 'utf8'), 'EVIDENCE_CANARY');
  assert.equal(await readFile(join(f.paths.chrome, 'Preferences'), 'utf8'), 'BROWSER_CANARY');
});
