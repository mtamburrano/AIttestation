import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, symlink, link, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { AGENT_PROFILE, AGENT_OPT_IN, agentAccount, agentBuildPath, initializeAgent,
  validateAgent, validateAgentLaunch, validateAgentState } from '../spikes/development/agent-environment.mjs';
import { agentNativeSources, replaceAgentInput } from '../spikes/development/agent-artifact.mjs';
import { agentCommand, agentOwnerAction, boundedAgentPreflight, inspectAgentBuild, preflightAgent, probeAgentKeychain } from '../spikes/development/agent.mjs';
import { probeAgentLogin } from '../spikes/development/agent-browser.mjs';
import { agentPermissions } from '../spikes/development/agent-permissions.mjs';
import { closeAgentBrowser } from '../spikes/development/agent-process.mjs';
import { writeNewJSON } from '../spikes/development/environment.mjs';
import { validateDevelopmentConfig } from '../spikes/development/prepare.mjs';
import { registerNativeHost, stopDevelopment } from '../spikes/development/cli.mjs';
import { DurableVault, MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { agentInstallation } from '../spikes/development/agent-policy.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { fileInventory } from '../spikes/distribution/inventory.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { sha256 } from '../spikes/distribution/release.mjs';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';

async function fixture(t) {
  const home = await realpath(await mkdtemp('/private/tmp/agent-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const info = { username: 'synthetic-signer', uid: process.getuid(), homedir: home };
  const agent = { profile: AGENT_PROFILE, namespace: 'fixture01', automation: 'local-api', account: { username: info.username, uid: info.uid, home } };
  const config = { profile: 'pap-private-development/1', teamId: 'TESTTEAM01', signingIdentity: 'A'.repeat(40),
    helperProvisioningProfile: join(home, 'synthetic-profile'), signingKeychain: join(home, 'synthetic-keychain'), sponsor: null, agent };
  const configPath = join(home, 'agent-config.json'); await writeNewJSON(configPath, config);
  const retained = join(home, 'retained-checkpoint'); await mkdir(retained, { mode: 0o700 });
  for (const name of ['control', 'vault', 'browser', 'extension', 'sponsor-ledger', 'evidence', 'keychain']) {
    await writeFile(join(retained, name), `retained synthetic ${name}`, { mode: 0o600 });
  }
  const baseline = await fileInventory(retained);
  await initializeAgent(agent, AGENT_OPT_IN, info);
  const paths = await validateAgent(agent, AGENT_OPT_IN, info);
  return { home, info, agent, config, configPath, paths, retained, baseline };
}

async function nativeSources() {
  return { host: await readFile(new URL('../spikes/vault/native/macos-app-host.swift', import.meta.url), 'utf8'),
    helper: await readFile(new URL('../spikes/vault/native/macos-keychain-helper.swift', import.meta.url), 'utf8'),
    browser: await readFile(new URL('../spikes/browser/chatgpt/native/macos-browser-host.swift', import.meta.url), 'utf8') };
}

test('agent entry requires explicit opt-in, exact current account and a fixed isolated namespace', async t => {
  const f = await fixture(t);
  assert.throws(() => agentAccount(f.agent, undefined, f.info), /OPT_IN/);
  for (const agent of [
    { ...f.agent, namespace: '../retained-checkpoint' }, { ...f.agent, namespace: 'attestamp/test' },
    { ...f.agent, root: f.retained }, { ...f.agent, namespace: '' },
    { ...f.agent, account: { ...f.agent.account, home: f.retained } },
    { ...f.agent, account: { ...f.agent.account, uid: f.info.uid + 1 } },
  ]) assert.throws(() => agentAccount(agent, AGENT_OPT_IN, f.info), /AGENT_/);
  const retainedInfo = { username: 'attestamp-test', uid: 503, homedir: '/Users/attestamp-test' };
  assert.throws(() => agentAccount({ ...f.agent, account: { username: retainedInfo.username, uid: 503, home: retainedInfo.homedir } },
    AGENT_OPT_IN, retainedInfo), /ACCOUNT_MISMATCH/);
  assert.throws(() => agentBuildPath(f.paths, '../retained-checkpoint'), /BUILD_NAME/);
  assert.throws(() => validateDevelopmentConfig({ ...f.config, sponsor: { origin: 'https://127.0.0.1:37461', certificateFile: '/test/cert' } }), /SPONSOR_DISABLED/);
  assert.equal((await agentCommand(['start', f.configPath, 'one'])).reason, 'AGENT_OPT_IN_REQUIRED');
  for (const flag of ['--testnet', '--mainnet', '--publish', '--deploy', '--live-chatgpt-testnet']) {
    assert.equal((await agentCommand(['start', f.configPath, 'one', AGENT_OPT_IN, flag])).reason, 'AGENT_COMMAND_INVALID');
  }
  await assert.rejects(initializeAgent(f.agent, AGENT_OPT_IN, f.info), { code: 'EEXIST' });
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('redirected root, state, extension and hard links fail before retained data can change', async t => {
  const f = await fixture(t);
  const extra = { ...f.agent, namespace: 'alias01' };
  await symlink(f.retained, agentAccount(extra, AGENT_OPT_IN, f.info).root);
  await assert.rejects(initializeAgent(extra, AGENT_OPT_IN, f.info), { code: 'EEXIST' });
  await assert.rejects(validateAgent(extra, AGENT_OPT_IN, f.info));
  await symlink(f.retained, join(f.paths.support, 'vault'));
  await assert.rejects(validateAgentState(f.paths), /STATE_UNSAFE/);
  await rm(join(f.paths.support, 'vault'));
  await link(join(f.retained, 'evidence'), join(f.paths.control, 'linked-state'));
  await assert.rejects(validateAgentState(f.paths), /STATE_UNSAFE/);
  await rm(join(f.paths.control, 'linked-state'));
  await rm(f.paths.extension, { recursive: true }); await symlink(f.retained, f.paths.extension);
  await assert.rejects(validateAgent(f.agent, AGENT_OPT_IN, f.info));
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('agent vault, bridge registration, launch cleanup and key service leave retained resources byte-identical', async t => {
  const f = await fixture(t), requests = [], storage = new Map([['ai.provenance.evidence-vault\0retained', 'untouched']]);
  let source = await readFile(new URL('../spikes/vault/key-lifecycle.mjs', import.meta.url), 'utf8');
  source = replaceAgentInput(source, "const DEFAULT_SERVICE = 'ai.provenance.evidence-vault';",
    `const DEFAULT_SERVICE = ${JSON.stringify(f.paths.keychainService)};`);
  for (const file of ['format.mjs', 'vault.mjs']) source = source.replace(`'./${file}'`, JSON.stringify(new URL(`../spikes/vault/${file}`, import.meta.url).href));
  const modulePath = join(f.home, 'isolated-keystore.mjs'); await writeFile(modulePath, source);
  const { MacOSKeychainStore } = await import(pathToFileURL(modulePath));
  const keyStore = new MacOSKeychainStore({ run: request => {
    requests.push(request); const key = `${request.service}\0${request.account}`;
    if (request.operation === 'set') storage.set(key, request.value);
    if (request.operation === 'delete') storage.delete(key);
    const value = storage.get(key);
    return { status: 0, stdout: JSON.stringify({ profile: 'pap-keychain-response/1',
      status: request.operation === 'get' && !value ? 'MISSING' : 'OK', ...(request.operation === 'get' && value ? { value } : {}) }) };
  } });
  const directory = join(f.paths.support, 'vault');
  const vault = DurableVault.create(directory, { keyStore }); vault.capture(Buffer.from('synthetic agent evidence')); vault.close();
  DurableVault.open(directory, { keyStore }).close();
  await registerNativeHost(f.paths, join(f.paths.builds, 'one/package/Attestamp.app/Contents/MacOS/provenance-browser-host'));
  await writeNewJSON(join(f.paths.control, 'launch.json'), { profile: AGENT_PROFILE, mode: 'offline' });
  await assert.rejects(stopDevelopment(f.paths), /LAUNCH_INVALID/);
  await stopDevelopment(f.paths, { agent: true });
  assert.equal(storage.get('ai.provenance.evidence-vault\0retained'), 'untouched');
  assert.ok(requests.length > 3 && requests.every(request => request.service === f.paths.keychainService));
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
  await validateAgentState(f.paths);
});

test('agent launch is explicit, bounded in time, bound to one build and cannot grant additional live scope', () => {
  const now = Date.now(), launch = { profile: AGENT_PROFILE, build: 'one', createdAt: now, mode: 'offline' };
  assert.deepEqual(validateAgentLaunch(launch, 'one', now), launch);
  for (const request of [{ ...launch, mode: 'testnet' }, { ...launch, sponsor: true }, { ...launch, createdAt: now - 60001 },
    { ...launch, createdAt: now + 1 }, { ...launch, build: 'two' }]) assert.throws(() => validateAgentLaunch(request, 'one', now), /EXPLICIT_SESSION/);
});

test('the actual local runtime cannot enable browser integration, sponsor requests or public Store access in default agent mode', async t => {
  const f = await fixture(t), network = restrictFixtureNetwork(f.paths.root);
  let runtime;
  try {
    const installation = await agentInstallation(f.paths, '/unused-synthetic-browser-host', false);
    runtime = await startPackagedChatGPT({ supportDirectory: f.paths.support, keyStore: new MemoryKeyStore(),
      managed: null, installation, openDashboard: async () => { throw Error('NO_BROWSER'); } });
    network.allowRuntime(runtime);
    assert.equal((await runtime.maintenance.status()).integration, 'DISABLED');
    await assert.rejects(runtime.maintenance.enable(), /LIVE_OPT_IN_REQUIRED/);
    await assert.rejects(runtime.maintenance.store(), /PUBLICATION_DISABLED/);
    await assert.rejects(runtime.maintenance.checkUpdate(), /not configured/);
    await assert.rejects(fetch('https://outside.invalid'), /NETWORK_FORBIDDEN/);
    assert.deepEqual(await fileInventory(f.retained), f.baseline);
  } finally { await runtime?.close(); network.restore(); }
});

test('agent artifact validation pins the signed namespace and inventories before it can be selected', async t => {
  const f = await fixture(t), name = 'one', output = agentBuildPath(f.paths, name);
  const app = join(output, 'package/Attestamp.app'), dev = join(app, 'Contents/Resources/spikes/development');
  const verifier = join(output, 'package/Recipient/Attestamp Verifier.app');
  await mkdir(dev, { recursive: true, mode: 0o700 }); await mkdir(verifier, { recursive: true, mode: 0o700 });
  await mkdir(join(output, 'extension'), { mode: 0o700 });
  await writeNewJSON(join(dev, 'private-development.json'), { profile: f.config.profile, agent: f.agent, build: name,
    sponsorOrigin: null, updaterEnabled: false, assurance: 'PRIVATE_TESTNET_ONLY', browserPolicy: 'EXPLICIT_TEST_USER_COPY' });
  const inventory = { application: await fileInventory(app), verifier: [], extension: [] };
  await writeNewJSON(join(output, 'private-inventory.json'), inventory);
  await writeNewJSON(join(output, 'private-build.json'), { profile: f.config.profile, releaseClass: 'PRIVATE_DEVELOPMENT',
    updaterEnabled: false, agent: f.agent, bundleInventoryDigest: sha256(canonical(inventory)) });
  const checks = [], execute = (tool, args) => { checks.push({ tool, args }); };
  assert.equal((await inspectAgentBuild(f.config, f.paths, name, execute)).app, app);
  assert.ok(checks[0].args.some(value => value.includes(f.config.teamId)));
  const other = { ...f.config, agent: { ...f.agent, namespace: 'another' } };
  await assert.rejects(inspectAgentBuild(other, f.paths, name, execute), /BUILD_INVALID/);
  await writeFile(join(app, 'unexpected.txt'), 'not inventoried');
  await assert.rejects(inspectAgentBuild(f.config, f.paths, name, execute), /BUILD_INVALID/);
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('preflight gates every predictable prerequisite and never probes the provider without a separate opt-in', async t => {
  const f = await fixture(t), calls = [], stage = join(f.paths.extension, 'one'); await mkdir(stage, { mode: 0o700 });
  const chromeInfo = join(f.home, 'Chrome-Info.plist'); await writeFile(chromeInfo, 'synthetic Chrome version');
  const build = { app: '/unused-synthetic-app', digest: 'test-build', extensionInventory: [] };
  const deps = { info: f.info, consoleUID: async () => f.info.uid,
    signingInputs: async () => ({ config: f.config }), signing: async () => ({ status: 'READY' }), ipc: async () => true,
    build: async () => build, keychain: () => ({ status: 'READY' }),
    chrome: async () => ({ infoPlist: chromeInfo }), processes: () => [], extension: async () => true,
    login: async () => { calls.push('login'); return true; } };
  const preflight = (live = false, patch = {}) => preflightAgent(f.configPath, 'one', AGENT_OPT_IN, live, { ...deps, ...patch });
  assert.equal((await preflight()).status, 'READY'); assert.deepEqual(calls, []);
  assert.deepEqual((await preflight()).providerSend, false);
  for (const [patch, reason] of [
    [{ consoleUID: async () => f.info.uid + 1 }, 'GUI_SESSION_REQUIRED'],
    [{ ipc: async () => false }, 'LOCAL_IPC_PERMISSION_REQUIRED'],
    [{ signingInputs: async () => { throw Error('secret-path'); } }, 'SIGNING_INPUTS_INVALID'],
    [{ signing: async () => ({ status: 'OWNER_ACTION_REQUIRED', reason: 'CODESIGN_AUTHORIZATION_REQUIRED' }) }, 'CODESIGN_AUTHORIZATION_REQUIRED'],
    [{ build: async () => { throw Error('private-path'); } }, 'AGENT_BUILD_INVALID'],
    [{ keychain: () => agentOwnerAction('VAULT_KEYCHAIN_BOOTSTRAP_REQUIRED') }, 'VAULT_KEYCHAIN_BOOTSTRAP_REQUIRED'],
  ]) assert.equal((await preflight(false, patch)).reason, reason);
  assert.equal((await preflight(true)).reason, 'BROWSER_BOOTSTRAP_REQUIRED');
  assert.deepEqual(calls, []);
  await writeNewJSON(join(f.paths.control, 'browser-one.json'), { profile: AGENT_PROFILE, buildDigest: build.digest,
    chromeDigest: sha256(await readFile(chromeInfo)), automation: 'CDP' });
  for (const [patch, reason] of [
    [{ chrome: async () => { throw Error('untrusted'); } }, 'CHROME_SETUP_REQUIRED'],
    [{ processes: () => [{ pid: 99 }] }, 'CLOSE_OTHER_CHROME_COPY'],
    [{ extension: async () => false }, 'EXTENSION_SETUP_REQUIRED'],
    [{ login: async () => false }, 'PROVIDER_LOGIN_REQUIRED'],
  ]) assert.equal((await preflight(true, patch)).reason, reason);
  const live = await preflight(true);
  assert.equal(live.status, 'READY'); assert.equal(live.providerSend, true);
  for (const scope of ['sponsor', 'mainnet', 'publication', 'deployment']) assert.equal(live[scope], false);
  assert.deepEqual(calls, ['login']);
  await writeFile(chromeInfo, 'new Chrome version');
  assert.equal((await preflight(true)).reason, 'BROWSER_BOOTSTRAP_REQUIRED');
  await writeNewJSON(join(f.paths.control, 'launch.json'), {});
  assert.equal((await preflight()).reason, 'STOP_PREVIOUS_AGENT_SESSION');
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('native Keychain preflight accepts only bounded reports and never requests an ACL change', () => {
  const calls = [], execute = (command, args) => { calls.push({ command, args }); return '{"status":"READY"}'; };
  assert.equal(probeAgentKeychain('/synthetic.app', false, execute).status, 'READY');
  assert.deepEqual(calls[0].args, ['--agent-preflight']);
  for (const output of ['private-path', '{"status":"OWNER_ACTION_REQUIRED","reason":"secret"}', 'x'.repeat(1025)]) {
    assert.equal(probeAgentKeychain('/synthetic.app', false, () => { throw { stdout: output }; }).reason, 'VAULT_KEYCHAIN_UNAVAILABLE');
  }
  assert.equal(probeAgentKeychain('/synthetic.app', false, () => { throw { stdout: '{"status":"OWNER_ACTION_REQUIRED","reason":"VAULT_KEYCHAIN_BOOTSTRAP_REQUIRED"}' }; }).reason,
    'VAULT_KEYCHAIN_BOOTSTRAP_REQUIRED');
});

test('the preflight worker has a global deadline, clean environment and bounded output with owned-process cleanup', async () => {
  const killed = [], spawned = [];
  const options = (output, code = 0) => ({ timeoutMs: 10, killGroup: child => killed.push(child),
    spawnProcess: (tool, args, config) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); spawned.push({ child, tool, args, config });
      if (output !== null) queueMicrotask(() => { child.stdout.write(output); child.emit('close', code); });
      return child;
    } });
  const ready = { profile: AGENT_PROFILE, status: 'READY', automation: 'local-api', providerSend: false,
    sponsor: false, mainnet: false, publication: false, deployment: false };
  assert.deepEqual(await boundedAgentPreflight('/synthetic-config', 'one', AGENT_OPT_IN, false, options(JSON.stringify(ready))), ready);
  assert.deepEqual(spawned[0].config.env, { PATH: '/usr/bin:/bin' });
  assert.equal(spawned[0].config.detached, true);
  assert.equal((await boundedAgentPreflight('/synthetic-config', 'one', AGENT_OPT_IN, false, options(null))).reason, 'AGENT_PREFLIGHT_TIMED_OUT');
  for (const output of ['/private/secret', 'x'.repeat(4097), JSON.stringify({ ...ready, sponsor: true })]) {
    assert.equal((await boundedAgentPreflight('/synthetic-config', 'one', AGENT_OPT_IN, false, options(output))).reason, 'AGENT_PREFLIGHT_FAILED');
  }
  assert.deepEqual(killed, spawned.map(entry => entry.child));
  assert.equal((await boundedAgentPreflight('/synthetic-config', 'one', AGENT_OPT_IN, false,
    { spawnProcess: () => { throw Error('private-path'); } })).reason, 'AGENT_PREFLIGHT_FAILED');
});

test('the real CLI preflight emits machine-readable failure and ignores inherited account and agent overrides', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [new URL('../spikes/development/cli.mjs', import.meta.url).pathname,
    'agent', 'preflight', f.configPath, 'one', AGENT_OPT_IN], {
    env: { PATH: '/usr/bin:/bin', HOME: f.home, ATTESTAMP_AGENT_MODE: 'true', ATTESTAMP_AGENT_UID: String(f.info.uid) },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), agentOwnerAction('AGENT_ACCOUNT_MISMATCH'));
  assert.ok(!result.stdout.includes(f.home));
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('computer-use readiness checks permissions without prompts and fails closed on unavailable inspection', async t => {
  const f = await fixture(t), original = await readdir(f.paths.root);
  for (const label of ['READY', 'ACCESSIBILITY_PERMISSION_REQUIRED', 'SCREEN_RECORDING_PERMISSION_REQUIRED', 'unknown secret']) {
    const result = await agentPermissions(f.paths, tool => {
      if (tool === '/usr/bin/xcrun') return '';
      if (label === 'READY') return label;
      throw { stdout: label };
    });
    assert.equal(result, label === 'unknown secret' ? 'AUTOMATION_PERMISSION_CHECK_UNAVAILABLE' : label);
    assert.deepEqual(await readdir(f.paths.root), original);
  }
  const agent = { ...f.agent, automation: 'computer-use' }, config = { ...f.config, agent };
  await writeFile(f.configPath, JSON.stringify(config));
  await writeFile(join(f.paths.root, 'agent.json'), JSON.stringify(agent));
  const report = await preflightAgent(f.configPath, 'one', AGENT_OPT_IN, false, {
    info: f.info, consoleUID: async () => f.info.uid, ipc: async () => true,
    permissions: async () => 'ACCESSIBILITY_PERMISSION_REQUIRED',
    signingInputs: async () => { assert.fail('permission failure must precede signing and runtime'); },
  });
  assert.equal(report.reason, 'ACCESSIBILITY_PERMISSION_REQUIRED');
  const native = await readFile(new URL('../spikes/development/native/agent-permissions.m', import.meta.url), 'utf8');
  assert.doesNotMatch(native, /CGRequest|AXIsProcessTrustedWithOptions|CGWindowListCreateImage|SecItem|tccutil/);
  assert.equal(await agentPermissions(f.paths, tool => {
    if (tool === '/usr/bin/xcrun') return '';
    throw { stdout: 'READY' };
  }), 'AUTOMATION_PERMISSION_CHECK_UNAVAILABLE');
});

test('browser login probe uses only its owned process and bounded CDP, returning no credentials or Send authority', async () => {
  const calls = [], killed = [], launches = [];
  const fakeSpawn = (executable, args, options) => {
    launches.push({ executable, args, options });
    const child = new EventEmitter(), output = new PassThrough(); let exited = false;
    child.kill = signal => { killed.push(signal); if (!exited) { exited = true; queueMicrotask(() => child.emit('exit', 0)); } };
    const input = new Writable({ write(chunk, encoding, callback) {
      const request = JSON.parse(chunk.toString().slice(0, -1)); calls.push(request);
      const result = request.method === 'Target.createTarget' ? { targetId: 'target' }
        : request.method === 'Target.attachToTarget' ? { sessionId: 'session' }
          : request.method === 'Runtime.evaluate' ? { result: { type: 'boolean', value: true } } : {};
      queueMicrotask(() => { output.write(`${JSON.stringify({ id: request.id, result })}\0`);
        if (request.method === 'Browser.close') child.kill('GRACEFUL'); });
      callback();
    } });
    child.stdio = [null, null, null, input, output]; return child;
  };
  const chrome = { executable: '/synthetic/Chrome.app/Contents/MacOS/Google Chrome' }, paths = { home: '/synthetic', chrome: '/synthetic/isolated-profile' };
  assert.equal(await probeAgentLogin(chrome, paths, { spawnProcess: fakeSpawn, timeoutMs: 1000 }), true);
  assert.deepEqual(launches[0].options.env, { HOME: paths.home, PATH: '/usr/bin:/bin' });
  assert.ok(launches[0].args.includes(`--user-data-dir=${paths.chrome}`));
  assert.ok(launches[0].args.includes('--remote-debugging-pipe'));
  assert.ok(!calls.some(call => /Input\.|Network\.|Storage\./.test(call.method)));
  assert.ok(calls.every(call => !call.params.userGesture));
  assert.ok(killed.includes('GRACEFUL'));
  const stalled = () => {
    const child = new EventEmitter(); child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
    child.kill = () => queueMicrotask(() => child.emit('exit', 1)); return child;
  };
  assert.equal(await probeAgentLogin(chrome, paths, { spawnProcess: stalled, timeoutMs: 10 }), false);
});

test('normal shutdown waits for its owned browser and escalates only that child if graceful exit stalls', async () => {
  const child = new EventEmitter(), signals = [];
  child.exitCode = null; child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', 1)); };
  await closeAgentBrowser(child, 10);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  child.exitCode = 0;
  await closeAgentBrowser(child);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  const graceful = new EventEmitter(); graceful.exitCode = null;
  graceful.kill = signal => { assert.equal(signal, 'SIGTERM'); queueMicrotask(() => graceful.emit('exit', 0)); };
  await closeAgentBrowser(graceful);
});

test('production inputs contain no agent switch and private specializations fail on unexpected source drift', async t => {
  const f = await fixture(t), sources = await nativeSources(), specialized = agentNativeSources(sources, f.agent, f.paths);
  for (const source of Object.values(sources)) assert.doesNotMatch(source, /agent-session|agent-preflight|ai\.provenance\.agent\./);
  assert.match(specialized.host, /--agent-session/); assert.match(specialized.host, /agent-runtime\.mjs/);
  assert.match(specialized.host, /\.now\(\) \+ 8/); assert.doesNotMatch(specialized.helper, /managed:anchoring/);
  assert.match(specialized.helper, /SecKeychainSetUserInteractionAllowed\(false\)/);
  assert.match(specialized.helper, /authentication\.interactionNotAllowed = true/);
  assert.match(specialized.browser, /agent-relay\.mjs/);
  assert.throws(() => agentNativeSources({ ...sources, host: sources.host.replace('Resources/spikes/development/runtime.mjs', 'changed') }, f.agent, f.paths), /INPUT_CHANGED/);
  assert.throws(() => replaceAgentInput('twice twice', 'twice', 'replacement'), /INPUT_CHANGED/);
  for (const name of (await readdir(new URL('../spikes/development', import.meta.url))).filter(name => name.startsWith('agent'))) {
    assert.equal(copyApplicationResource(`spikes/development/${name}`), false);
  }
  const keyStore = await readFile(new URL('../spikes/vault/key-lifecycle.mjs', import.meta.url), 'utf8');
  assert.match(keyStore, /DEFAULT_SERVICE = 'ai.provenance.evidence-vault'/);
  assert.doesNotMatch(keyStore, /AGENT|agent-mode|ai\.provenance\.agent\./);
});

test('private native variants compile and guard account, explicit launch and isolated locks; production binary has no agent authority', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 180000,
}, async t => {
  const f = await fixture(t), actual = userInfo();
  // Native fixture constants explicitly point to this invocation's temporary
  // resources. No native Keychain helper is executed in this test.
  const agent = { ...f.agent, account: { username: actual.username, uid: actual.uid, home: actual.homedir } };
  const paths = { ...f.paths, home: actual.homedir };
  const sources = await nativeSources(), variants = agentNativeSources(sources, agent, paths);
  // The generated lock location normally derives from HOME; pin just this
  // fixture's lock to the temporary support path before compiling it.
  const host = variants.host.replace('let directory = URL(fileURLWithPath: try ownedHome())\n    .appendingPathComponent',
    `let directory = URL(fileURLWithPath: ${JSON.stringify(f.home)})\n    .appendingPathComponent`);
  const app = join(f.home, 'Agent.app'), contents = join(app, 'Contents'); await mkdir(join(contents, 'MacOS'), { recursive: true });
  const helperDirectory = join(contents, 'Helpers/Private Provenance Keychain.app/Contents/MacOS'); await mkdir(helperDirectory, { recursive: true });
  await writeFile(join(helperDirectory, '../Info.plist'), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>provenance-keychain-helper</string><key>CFBundleIdentifier</key><string>ai.provenance.keychain-helper</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  await writeFile(join(contents, 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>provenance-app-host</string><key>CFBundleIdentifier</key><string>ai.provenance.consumer.host</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const options = { env: { PATH: '/usr/bin:/bin', TMPDIR: f.home }, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 };
  execFileSync('/usr/bin/xcrun', ['clang', '-framework', 'ApplicationServices', '-framework', 'CoreGraphics',
    new URL('../spikes/development/native/agent-permissions.m', import.meta.url).pathname, '-o', join(f.home, 'permission-probe')], options);
  const stub = join(f.home, 'synthetic-helper.c');
  await writeFile(stub, '#include <stdio.h>\nint main(void) { while (getchar() != EOF) {} puts("{\\"profile\\":\\"pap-keychain-response/1\\",\\"status\\":\\"OK\\",\\"value\\":\\"YWdlbnQtcmVhZGluZXNzLXYx\\"}"); return 0; }');
  execFileSync('/usr/bin/xcrun', ['clang', stub, '-o', join(helperDirectory, 'provenance-keychain-helper')], options);
  for (const [kind, source] of Object.entries({ host, helper: variants.helper, browser: variants.browser, production: sources.host })) {
    const sourcePath = join(f.home, `${kind}.swift`); await writeFile(sourcePath, source);
    const target = kind === 'host' ? join(contents, 'MacOS/provenance-app-host') : join(f.home, kind);
    execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(f.home, 'swift-cache'), '-O', '-D', 'PRODUCT_CHATGPT',
      '-D', 'PRODUCT_RELEASE', ...(kind === 'production' ? [] : ['-D', 'PRIVATE_DEVELOPMENT']), '-framework', 'Security', sourcePath, '-o', target], options);
  }
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', join(contents, 'Helpers/Private Provenance Keychain.app')], options);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], options);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], options);
  const executable = join(contents, 'MacOS/provenance-app-host');
  assert.equal(spawnSync(executable, [], { ...options, timeout: 5000 }).status, 1);
  const probe = spawnSync(executable, ['--agent-preflight'], { ...options, timeout: 5000 });
  assert.equal(probe.status, 0, probe.stderr); assert.equal(JSON.parse(probe.stdout).status, 'READY');
  assert.ok((await readdir(f.paths.support)).includes('application.lock'));
  await rm(f.paths.chrome, { recursive: true }); await symlink(f.retained, f.paths.chrome);
  assert.equal(spawnSync(executable, ['--agent-preflight'], { ...options, timeout: 5000 }).status, 1);
  const production = await readFile(join(f.home, 'production'));
  for (const marker of ['--agent-session', '--agent-preflight', 'agent-runtime.mjs', 'ai.provenance.agent.']) assert.equal(production.includes(Buffer.from(marker)), false);
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});
