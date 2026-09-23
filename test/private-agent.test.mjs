import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, symlink, link, copyFile, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { AGENT_PROFILE, AGENT_OPT_IN, agentAccount, agentBuildPath, initializeAgent,
  validateAgent, validateAgentLaunch, validateAgentState } from '../spikes/development/agent-environment.mjs';
import { agentNativeSources, replaceAgentInput } from '../spikes/development/agent-artifact.mjs';
import { initializeAgentConfig, resolveAgentConfig } from '../spikes/development/agent-config.mjs';
import { agentCommand, agentOwnerAction, bootstrapAgent, boundedAgentPreflight, inspectAgentBuild, preflightAgent, probeAgentKeychain } from '../spikes/development/agent.mjs';
import { agentExtensionReady, probeAgentLogin } from '../spikes/development/agent-browser.mjs';
import { agentPermissions } from '../spikes/development/agent-permissions.mjs';
import { closeAgentBrowser, waitForAgentBrowserCleanup } from '../spikes/development/agent-process.mjs';
import { ownerDirectory, writeNewJSON } from '../spikes/development/environment.mjs';
import { stageAgentExtension, validateDevelopmentConfig } from '../spikes/development/prepare.mjs';
import { registerNativeHost, stopDevelopment } from '../spikes/development/cli.mjs';
import { DurableVault, MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { agentInstallation } from '../spikes/development/agent-policy.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { fileInventory } from '../spikes/distribution/inventory.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { sha256 } from '../spikes/distribution/release.mjs';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';

async function fixture(t, namespace = 'fixture01') {
  const home = await realpath(await mkdtemp('/private/tmp/agent-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const info = { username: 'synthetic-signer', uid: process.getuid(), homedir: home };
  const agent = { profile: AGENT_PROFILE, namespace, automation: 'local-api', account: { username: info.username, uid: info.uid, home } };
  const config = { profile: 'pap-private-development/1', teamId: 'TESTTEAM01', signingIdentity: 'A'.repeat(40),
    helperProvisioningProfile: join(home, 'synthetic-profile'), signingKeychain: join(home, 'synthetic-keychain'), sponsor: null, agent };
  const sourceConfigPath = join(home, 'agent-config.json'); await writeNewJSON(sourceConfigPath, config);
  await writeFile(config.helperProvisioningProfile, 'synthetic profile, never used for signing', { mode: 0o600 });
  const retained = join(home, 'retained-checkpoint'); await mkdir(retained, { mode: 0o700 });
  for (const name of ['control', 'vault', 'browser', 'extension', 'sponsor-ledger', 'evidence', 'keychain']) {
    await writeFile(join(retained, name), `retained synthetic ${name}`, { mode: 0o600 });
  }
  const baseline = await fileInventory(retained);
  await initializeAgentConfig(sourceConfigPath, AGENT_OPT_IN, info);
  const persisted = await resolveAgentConfig(agent.namespace, AGENT_OPT_IN, info);
  return { home, info, agent, ...persisted, retained, baseline };
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

test('stopped Chrome accepts only owned top-level connection metadata matching its validated bundle', async t => {
  const f = await fixture(t), marker = join(f.paths.chrome, 'RunningChromeVersion');
  const chrome = { application: f.paths.chromeApplication, version: '153.0.8010.53' };
  let checks = 0;
  const options = { processes: () => [], checkChrome: async (application, paths) => {
    checks++; assert.equal(application, f.paths.chromeApplication); assert.deepEqual(paths, f.paths); return chrome;
  } };
  for (const target of ['153.0.8010.53:1', '153.0.8010.53:0', '153.0.8010.53']) {
    await symlink(target, marker);
    await assert.rejects(lstat(join(f.paths.chrome, target)), { code: 'ENOENT' });
    assert.equal(await validateAgentState(f.paths, options), chrome);
    assert.equal(await readlink(marker), target);
    await rm(marker);
  }
  assert.equal(checks, 3);
  await symlink('153.0.8010.53:1', marker);
  for (const selected of [{ ...chrome, version: '153.0.8010.54' }, { ...chrome, version: '154.0.8010.53' },
    { ...chrome, version: undefined }, { ...chrome, application: '/Applications/Google Chrome.app' }, null]) {
    await assert.rejects(validateAgentState(f.paths, { ...options, checkChrome: async () => selected }), /AGENT_STATE_UNSAFE/);
  }
  await assert.rejects(validateAgentState(f.paths, { ...options,
    checkChrome: async () => { throw Error('CHROME_SIGNATURE_REJECTED'); } }), /CHROME_SETUP_REQUIRED/);
  let processes = 0;
  await assert.rejects(validateAgentState(f.paths, { ...options,
    processes: () => processes++ ? [{ pid: 99 }] : [] }), /CLOSE_OTHER_CHROME_COPY/);
  assert.equal(await readlink(marker), '153.0.8010.53:1');
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('Chrome connection metadata rejects malformed, redirected, misplaced and non-symlink entries', async t => {
  const f = await fixture(t), marker = join(f.paths.chrome, 'RunningChromeVersion');
  const active = () => [{ pid: 99, executable: join(f.paths.chromeApplication, 'Contents/MacOS/Google Chrome') }];
  let checks = 0;
  const options = { processes: () => [], checkChrome: async () => { checks++; throw Error('UNEXPECTED_BUNDLE_CHECK'); } };
  for (const target of [f.retained, '/153.0.8010.53:1', '../153.0.8010.53:1', '153.0.8010.53/extra:1',
    '153.0.8010.53\\extra:1', '..:1', '153..8010.53:1', '153.0.8010:1', '153.0.8010.53.0:1',
    '0153.0.8010.53:1', '153.00.8010.53:1', '153.0.8010.-1:1', '153.0.8010.+1:1',
    '153.0.8010.4294967296:1', `153.0.8010.${'9'.repeat(50)}:1`, '153.0.8010.x:1',
    '１５３.0.8010.53:1', ' 153.0.8010.53:1', '153.0.8010.53:1 ', '153.0.8010.53:1\n',
    '153.0.8010.53\n', '153.0.8010.53:\t1', '153.0.8010.53:', '153.0.8010.53:2',
    '153.0.8010.53:01', '153.0.8010.53:true', '153.0.8010.53:-1', '153.0.8010.53:1:extra',
    '153.0.8010.53:1:', ':1']) {
    await symlink(target, marker);
    await assert.rejects(validateAgentState(f.paths, { ...options, processes: active }), /CLOSE_OTHER_CHROME_COPY/);
    await assert.rejects(validateAgentState(f.paths, options), /AGENT_STATE_UNSAFE/, target);
    assert.equal(await readlink(marker), target);
    await rm(marker);
  }
  for (const parent of [f.paths.chrome, f.paths.control, f.paths.support, join(f.paths.chrome, 'Default')]) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const misplaced = join(parent, 'RunningChromeVersion');
    if (parent !== f.paths.chrome) {
      await symlink('153.0.8010.53:1', misplaced);
      await assert.rejects(validateAgentState(f.paths, options), /AGENT_STATE_UNSAFE/);
      await rm(misplaced);
    }
    await writeFile(misplaced, '153.0.8010.53:1', { mode: 0o600 });
    await assert.rejects(validateAgentState(f.paths, options), /AGENT_STATE_UNSAFE/);
    await rm(misplaced);
    await mkdir(misplaced, { mode: 0o700 });
    await assert.rejects(validateAgentState(f.paths, options), /AGENT_STATE_UNSAFE/);
    await rm(misplaced, { recursive: true });
  }
  await validateAgentState(f.paths, { ...options, processes: active }); // Offline does not require unrelated Chrome to quit.
  await assert.rejects(validateAgentState(f.paths, { ...options, processes: active, requireStoppedBrowser: true }), /CLOSE_OTHER_CHROME_COPY/);
  await validateAgentState(f.paths, { ...options, requireStoppedBrowser: true });
  assert.equal(checks, 0);
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('live preflight and bootstrap gate running Chrome before state traversal or privileged probes', async t => {
  const f = await fixture(t), marker = join(f.paths.chrome, 'RunningChromeVersion');
  let active = true, probes = 0;
  const unexpected = () => { probes++; throw Error('UNEXPECTED_PROBE'); };
  const deps = { info: f.info, processes: () => active ? [{ pid: 99 }] : [],
    consoleUID: unexpected, ipc: unexpected, build: unexpected, signingInputs: unexpected,
    keychain: unexpected, chrome: unexpected, extension: unexpected, login: unexpected };
  const preflight = () => preflightAgent(f.agent.namespace, 'one', AGENT_OPT_IN, true, deps);
  const bootstrap = () => agentCommand(['bootstrap', f.agent.namespace, 'one', AGENT_OPT_IN, '--owner-bootstrap', '--live-provider-send'],
    { info: f.info, bootstrap: (...args) => bootstrapAgent(...args, deps) });
  for (const target of ['153.0.8010.53:1', f.retained]) {
    await symlink(target, marker);
    for (const run of [preflight, bootstrap]) assert.equal((await run()).reason, 'CLOSE_OTHER_CHROME_COPY');
    assert.equal(await readlink(marker), target);
    await rm(marker);
  }
  assert.equal(probes, 0);
  // Replay the owner-observed metadata surviving shutdown and subsequent runs.
  active = false; await symlink('153.0.8010.53:1', marker);
  await mkdir(join(f.paths.extension, 'current'), { mode: 0o700 });
  const infoPlist = join(f.home, 'synthetic-chrome-version');
  await writeFile(infoPlist, 'synthetic Chrome 153');
  let chromeChecks = 0;
  const resumed = { ...deps, consoleUID: async () => f.info.uid, ipc: async () => true,
    signingInputs: async () => ({ config: f.config }), signing: async () => ({ status: 'READY' }),
    build: async () => ({ app: '/unused-synthetic-app', extensionInventory: [] }),
    keychain: () => ({ status: 'READY' }),
    chrome: async () => { chromeChecks++; return { application: f.paths.chromeApplication, infoPlist, version: '153.0.8010.53' }; },
    extension: async () => true, login: async () => true };
  assert.equal((await bootstrapAgent(f.config, f.paths, 'one', true, resumed)).status, 'READY');
  assert.deepEqual(JSON.parse(await readFile(join(f.paths.control, 'browser.json'), 'utf8')),
    { profile: AGENT_PROFILE, chromeDigest: sha256(await readFile(infoPlist)), automation: 'CDP' });
  for (const live of [true, false, true]) {
    assert.equal((await preflightAgent(f.agent.namespace, 'one', AGENT_OPT_IN, live, resumed)).status, 'READY');
  }
  assert.equal(chromeChecks, 4, 'each run revalidates the bundle once');
  const invalid = { ...resumed, ...Object.fromEntries(['consoleUID', 'ipc', 'build', 'signingInputs', 'keychain', 'extension', 'login']
    .map(name => [name, unexpected])), chrome: async () => ({ application: f.paths.chromeApplication, version: '153.0.8010.54' }) };
  assert.equal((await preflightAgent(f.agent.namespace, 'one', AGENT_OPT_IN, true, invalid)).reason, 'AGENT_STATE_UNSAFE');
  await assert.rejects(bootstrapAgent(f.config, f.paths, 'one', true, invalid), /AGENT_STATE_UNSAFE/);
  assert.equal(probes, 0);
  assert.equal(await readlink(marker), '153.0.8010.53:1');
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('agent extension staging copies nested assets into a fresh private root and refuses reuse', async t => {
  const f = await fixture(t), source = join(f.home, 'extension-source');
  await mkdir(join(source, 'assets'), { recursive: true, mode: 0o755 });
  await writeFile(join(source, 'manifest.json'), '{"manifest_version":3}');
  await writeFile(join(source, 'assets/fixture.js'), 'synthetic extension');
  const stage = join(f.paths.extension, 'build01');
  await stageAgentExtension(source, stage);
  await ownerDirectory(stage);
  const staged = await fileInventory(stage);
  assert.deepEqual(staged, await fileInventory(source));
  await writeFile(join(source, 'assets/fixture.js'), 'changed source');
  await assert.rejects(stageAgentExtension(source, stage), { code: 'EEXIST' });
  assert.deepEqual(await fileInventory(stage), staged);
  const alias = join(f.paths.extension, 'retained-alias');
  await symlink(f.retained, alias);
  await assert.rejects(stageAgentExtension(source, alias), { code: 'EEXIST' });
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('agent extension readiness follows current Chromium disable reasons and fails closed on ambiguity', async t => {
  const f = await fixture(t), stage = join(f.paths.extension, 'current');
  await mkdir(join(f.paths.chrome, 'Default'), { mode: 0o700 });
  const writePreferences = (name, value) => writeFile(join(f.paths.chrome, 'Default', name), JSON.stringify(value), { mode: 0o600 });
  const entry = { path: stage, disable_reasons: [] };
  const preferences = { extensions: { settings: { [CHATGPT_EXTENSION_ID]: entry } } };
  await writePreferences('Secure Preferences', preferences);
  assert.equal(await agentExtensionReady(f.paths, stage), true);

  await writePreferences('Secure Preferences', { extensions: { settings: { [CHATGPT_EXTENSION_ID]: { path: stage } } } });
  assert.equal(await agentExtensionReady(f.paths, stage), true);

  entry.state = 1;
  await writePreferences('Preferences', preferences);
  assert.equal(await agentExtensionReady(f.paths, stage), true);

  for (const [name, value] of [
    ['disabled', { ...entry, disable_reasons: [1] }],
    ['blocklisted', { ...entry, blacklist_state: 1 }],
    ['omaha-blocklisted', { ...entry, omaha_blocklist_state: 1 }],
    ['telemetry-blocklisted', { ...entry, extension_telemetry_service_blocklist_state: 1 }],
    ['legacy-blocklisted', { ...entry, blacklist: true }],
    ['malformed-blocklist', { ...entry, blacklist_state: [] }],
    ['wrong-path', { ...entry, path: join(f.paths.extension, 'other') }],
    ['wrong-state', { ...entry, state: 0 }],
    ['malformed-reasons', { ...entry, disable_reasons: '[]' }],
  ]) {
    await writePreferences('Secure Preferences',
      { extensions: { settings: { [CHATGPT_EXTENSION_ID]: value } } });
    assert.equal(await agentExtensionReady(f.paths, stage), false, name);
  }

  await writePreferences('Secure Preferences',
    { extensions: { settings: { wrongextensionid: { path: stage, disable_reasons: [] } } } });
  await writePreferences('Preferences', {});
  assert.equal(await agentExtensionReady(f.paths, stage), false, 'wrong-id');

  await writePreferences('Secure Preferences',
    { extensions: { settings: { [CHATGPT_EXTENSION_ID]: { path: stage, disable_reasons: [] } } } });
  await writeFile(join(f.paths.chrome, 'Default', 'Preferences'), '{ malformed', { mode: 0o600 });
  assert.equal(await agentExtensionReady(f.paths, stage), false);
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
  const f = await fixture(t), calls = [], stage = join(f.paths.extension, 'current'); await mkdir(stage, { mode: 0o700 });
  const chromeInfo = join(f.home, 'Chrome-Info.plist'); await writeFile(chromeInfo, 'synthetic Chrome version');
  const build = { app: '/unused-synthetic-app', digest: 'test-build', extensionInventory: [] };
  const chrome = { application: f.paths.chromeApplication,
    executable: join(f.paths.chromeApplication, 'Contents/MacOS/Google Chrome'), infoPlist: chromeInfo };
  const deps = { info: f.info, consoleUID: async () => f.info.uid,
    signingInputs: async () => ({ config: f.config }), signing: async () => ({ status: 'READY' }), ipc: async () => true,
    build: async () => build, keychain: () => ({ status: 'READY' }),
    permissions: async () => assert.fail('local-api preflight must not inspect GUI automation permissions'),
    chrome: async (application, paths) => {
      assert.equal(application, f.paths.chromeApplication); assert.deepEqual(paths, f.paths); return chrome;
    }, processes: () => [], extension: async () => true,
    login: async (selected, paths) => {
      assert.equal(selected, chrome); assert.deepEqual(paths, f.paths); calls.push('login'); return true;
    } };
  const preflight = (live = false, patch = {}) => preflightAgent(f.agent.namespace, 'one', AGENT_OPT_IN, live, { ...deps, ...patch });
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
  await writeNewJSON(join(f.paths.control, 'browser.json'), { profile: AGENT_PROFILE,
    chromeDigest: sha256(await readFile(chromeInfo)), automation: 'CDP' });
  for (const [patch, reason] of [
    [{ chrome: async () => { throw Error('untrusted'); } }, 'CHROME_SETUP_REQUIRED'],
    [{ processes: () => [{ pid: 99 }] }, 'CLOSE_OTHER_CHROME_COPY'],
    [{ extension: async () => false }, 'EXTENSION_SETUP_REQUIRED'],
    [{ login: async () => false }, 'PROVIDER_LOGIN_REQUIRED'],
  ]) assert.equal((await preflight(true, patch)).reason, reason);
  let processChecks = 0;
  assert.equal((await preflight(true, { processes: () => processChecks++ ? [{ pid: 99 }] : [] })).reason, 'CLOSE_OTHER_CHROME_COPY');
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
  assert.deepEqual(await boundedAgentPreflight('fixture01', 'one', AGENT_OPT_IN, false, options(JSON.stringify(ready))), ready);
  assert.deepEqual(spawned[0].config.env, { PATH: '/usr/bin:/bin' });
  assert.deepEqual(spawned[0].args.slice(1), ['fixture01', 'one', AGENT_OPT_IN, 'offline']);
  assert.equal(spawned[0].config.detached, true);
  assert.equal((await boundedAgentPreflight('fixture01', 'one', AGENT_OPT_IN, false, options(null))).reason, 'AGENT_PREFLIGHT_TIMED_OUT');
  for (const output of ['/private/secret', 'x'.repeat(4097), JSON.stringify({ ...ready, sponsor: true })]) {
    assert.equal((await boundedAgentPreflight('fixture01', 'one', AGENT_OPT_IN, false, options(output))).reason, 'AGENT_PREFLIGHT_FAILED');
  }
  assert.deepEqual(killed, spawned.map(entry => entry.child));
  assert.equal((await boundedAgentPreflight('fixture01', 'one', AGENT_OPT_IN, false,
    { spawnProcess: () => { throw Error('private-path'); } })).reason, 'AGENT_PREFLIGHT_FAILED');
});

test('the real CLI preflight emits machine-readable failure and ignores inherited account and agent overrides', async t => {
  const namespace = `env-test-${randomBytes(4).toString('hex')}`, f = await fixture(t, namespace);
  await assert.rejects(lstat(join(userInfo().homedir, `.attestamp-agent-${namespace}`)), { code: 'ENOENT' });
  const result = spawnSync(process.execPath, [new URL('../spikes/development/cli.mjs', import.meta.url).pathname,
    'agent', 'preflight', namespace, 'one', AGENT_OPT_IN], {
    env: { PATH: '/usr/bin:/bin', HOME: f.home, ATTESTAMP_AGENT_MODE: 'true', ATTESTAMP_AGENT_UID: String(f.info.uid),
      ATTESTAMP_AGENT_CONFIG: f.configPath },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), agentOwnerAction('AGENT_CONFIG_NOT_PREPARED'));
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
  const report = await preflightAgent(f.agent.namespace, 'one', AGENT_OPT_IN, false, {
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

const loginPaths = { home: '/synthetic', root: '/synthetic/agent', chrome: '/synthetic/agent/chrome',
  chromeApplication: '/synthetic/agent/browser/Google Chrome.app' };
const loginChrome = { application: loginPaths.chromeApplication,
  executable: `${loginPaths.chromeApplication}/Contents/MacOS/Google Chrome` };
const sessionURL = 'https://chatgpt.com/api/auth/session';

function evaluateLogin(expression, { href = 'https://chatgpt.com/', status = 200, redirected = false,
  url = sessionURL, contentType = 'application/json; charset=utf-8',
  session = { user: { id: 'synthetic-user-id', email: 'synthetic@example.invalid' },
    accessToken: 'synthetic-token', expires: new Date(Date.now() + 3600000).toISOString() },
  json = async () => session, fetchError = false, requests = [], afterFetch,
} = {}) {
  const location = { href };
  return runInNewContext(expression, { location, AbortSignal, fetch: async (path, options) => {
    requests.push({ path, options, status });
    if (fetchError) throw Error('synthetic network/redirect error');
    afterFetch?.(location);
    return { status, redirected, url, headers: new Headers({ 'content-type': contentType }), json };
  } }, { timeout: 1000 });
}

function loginBrowser(onCall = () => false) {
  const launches = [], calls = [], replies = [], requests = [], killed = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter(), output = new PassThrough(); let exited = false;
    child.exitCode = null;
    const exit = (code = 0) => {
      if (!exited) { exited = true; queueMicrotask(() => { child.exitCode = code; child.emit('exit', code); }); }
    };
    child.kill = signal => { killed.push({ child, signal }); exit(1); };
    const input = new Writable({ write(chunk, encoding, callback) {
      const request = JSON.parse(chunk.toString().slice(0, -1)); calls.push(request);
      const reply = result => {
        replies.push(result);
        output.write(`${JSON.stringify({ id: request.id, result })}\0`);
      };
      queueMicrotask(async () => {
        if (onCall(request, { child, output, reply, exit })) return;
        const result = request.method === 'Target.createTarget' ? { targetId: 'target' }
          : request.method === 'Target.attachToTarget' ? { sessionId: 'session' }
            : request.method === 'Runtime.evaluate' ? { result: { type: 'boolean', value:
              await evaluateLogin(request.params.expression, { requests,
                status: args.some(arg => arg.startsWith('--headless')) ? 403 : 200 }) } } : {};
        reply(result);
        if (request.method === 'Browser.close') exit();
      });
      callback();
    } });
    child.stdio = [null, null, null, input, output];
    launches.push({ executable, args, options, child }); return child;
  };
  return { spawnProcess, launches, calls, replies, requests, killed, waitForCleanup: async () => {} };
}

test('browser login probe uses the exact headed Default profile, a private CDP pipe and content-free session evidence', async () => {
  const browser = loginBrowser();
  assert.equal(await probeAgentLogin(loginChrome, loginPaths, { ...browser, timeoutMs: 1000 }), true);
  const { args, executable, options, child } = browser.launches[0];
  assert.equal(executable, loginChrome.executable);
  assert.deepEqual(options.env, { HOME: loginPaths.home, PATH: '/usr/bin:/bin' });
  assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
  assert.ok(args.includes(`--user-data-dir=${loginPaths.chrome}`));
  assert.ok(args.includes('--profile-directory=Default'));
  assert.ok(args.includes('--remote-debugging-pipe'));
  assert.ok(!args.some(arg => /headless|remote-debugging-port/.test(arg)));
  assert.deepEqual(browser.calls.map(call => call.method), ['Target.createTarget', 'Target.attachToTarget',
    'Page.navigate', 'Runtime.evaluate', 'Browser.close']);
  assert.ok(browser.calls.every(call => !call.params.userGesture));
  for (const call of browser.calls.filter(call => ['Page.navigate', 'Runtime.evaluate'].includes(call.method))) {
    assert.equal(call.sessionId, 'session');
  }
  const evaluation = browser.calls.find(call => call.method === 'Runtime.evaluate');
  assert.equal(evaluation.params.awaitPromise, true); assert.equal(evaluation.params.returnByValue, true);
  assert.equal(browser.requests.length, 1);
  assert.equal(browser.requests[0].path, '/api/auth/session');
  assert.equal(browser.requests[0].options.credentials, 'same-origin');
  assert.equal(browser.requests[0].options.redirect, 'error');
  assert.equal(browser.requests[0].options.method, undefined);
  assert.doesNotMatch(JSON.stringify(browser.replies), /synthetic-user-id|synthetic@example|synthetic-token/);
  assert.deepEqual(browser.killed, []);
  assert.ok(child.stdio[3].destroyed && child.stdio[4].destroyed);
});

test('Chrome 153 owner regression: the same valid profile gets headless 403 and headed CDP 200', async () => {
  // Replay the recorded HTTP outcomes; this fixture never contacts the provider.
  const headless = loginBrowser(), headed = loginBrowser();
  assert.equal(await probeAgentLogin(loginChrome, loginPaths, { timeoutMs: 20,
    spawnProcess: (command, args, options) => headless.spawnProcess(command, [...args, '--headless=new'], options) }), false);
  assert.equal(await probeAgentLogin(loginChrome, loginPaths, { ...headed, timeoutMs: 1000 }), true);
  assert.deepEqual(headless.requests.map(request => request.status), [403]);
  assert.deepEqual(headed.requests.map(request => request.status), [200]);
  assert.equal(headless.launches[0].executable, headed.launches[0].executable);
  assert.equal(headless.launches[0].args[0], headed.launches[0].args[0]);
});

test('login evaluation rejects redirects, challenges, invalid or expired sessions without reading cookies', async () => {
  const browser = loginBrowser();
  await probeAgentLogin(loginChrome, loginPaths, { ...browser, timeoutMs: 1000 });
  const { expression } = browser.calls.find(call => call.method === 'Runtime.evaluate').params;
  const future = new Date(Date.now() + 3600000).toISOString();
  const cases = [
    { href: 'https://accounts.example.invalid/' }, { href: 'https://chatgpt.com/auth/login' },
    { href: 'https://chatgpt.com/?challenge=1' }, { status: 401 }, { status: 403 }, { status: 302 }, { status: 204 },
    { redirected: true }, { url: 'https://chatgpt.com/login' }, { contentType: 'text/html' }, { contentType: '' },
    { fetchError: true }, { json: async () => { throw SyntaxError('synthetic malformed JSON'); } },
    { session: null }, { session: {} }, { session: { user: { id: '' }, expires: future } },
    { session: { user: { id: 1 }, expires: future } }, { session: { user: { id: 'synthetic' }, expires: 'invalid' } },
    { session: { user: { id: 'synthetic' }, expires: new Date(Date.now() - 1000).toISOString() } },
    { session: { user: { id: 'synthetic' }, expires: new Date(Date.now() + 30000).toISOString() } },
    { session: { user: { id: 'synthetic' }, expires: Date.now() + 3600000 } },
    { afterFetch: location => { location.href = 'https://chatgpt.com/auth/login'; } },
  ];
  for (const [index, scenario] of cases.entries()) assert.equal(await evaluateLogin(expression, scenario), false, `case ${index}`);
  assert.equal(await evaluateLogin(expression), true);
  const requests = [];
  assert.equal(await evaluateLogin(expression, { href: 'https://other.invalid/', requests }), false);
  assert.deepEqual(requests, []);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/);
});

test('login probe refuses browser or profile mismatch before spawning', async () => {
  const spawnProcess = () => assert.fail('mismatched inputs must not launch');
  for (const [chrome, paths] of [
    [{ ...loginChrome, executable: '/other/Google Chrome' }, loginPaths],
    [{ ...loginChrome, application: '/other/Google Chrome.app' }, loginPaths],
    [loginChrome, { ...loginPaths, chrome: '/other/chrome' }],
  ]) assert.equal(await probeAgentLogin(chrome, paths, { spawnProcess }), false);
});

test('login probe fails closed and cleans up only its child on CDP failure, pipe loss, crash and timeout', async t => {
  for (const failure of ['stall-start', 'stall-evaluate', 'stall-close', 'pipe-error', 'pipe-end', 'crash',
    'malformed', 'null-message', 'oversized', 'cdp-error', 'exception', 'non-boolean', 'navigation-error', 'spawn-error']) {
    await t.test(failure, async () => {
      const at = failure === 'stall-close' ? 'Browser.close' : failure === 'navigation-error' ? 'Page.navigate'
        : failure === 'stall-start' || failure === 'spawn-error' ? 'Target.createTarget' : 'Runtime.evaluate';
      const browser = loginBrowser((request, { child, output, reply, exit }) => {
        if (request.method !== at) return false;
        if (failure.startsWith('stall-')) return true;
        if (failure === 'pipe-error') output.emit('error', Error('synthetic private error'));
        if (failure === 'pipe-end') output.end();
        if (failure === 'crash') exit(1);
        if (failure === 'spawn-error') child.emit('error', Error('synthetic private path'));
        if (failure === 'malformed') output.write('{bad\0');
        if (failure === 'null-message') output.write('null\0');
        if (failure === 'oversized') output.write('x'.repeat(256 * 1024 + 1));
        if (failure === 'cdp-error') output.write(`${JSON.stringify({ id: request.id, error: { message: 'synthetic private error' } })}\0`);
        if (failure === 'exception') reply({ result: { type: 'boolean', value: true }, exceptionDetails: { text: 'synthetic private error' } });
        if (failure === 'non-boolean') reply({ result: { type: 'string', value: 'true' } });
        if (failure === 'navigation-error') reply({ errorText: 'synthetic navigation error' });
        return true;
      });
      assert.equal(await probeAgentLogin(loginChrome, loginPaths, { ...browser, timeoutMs: 20 }), false);
      const child = browser.launches[0].child;
      assert.ok(browser.killed.every(entry => entry.child === child && entry.signal === 'SIGKILL'));
      if (failure !== 'crash') assert.ok(browser.killed.length > 0);
      assert.ok(child.stdio[3].destroyed && child.stdio[4].destroyed);
    });
  }
  assert.equal(await probeAgentLogin(loginChrome, loginPaths, { spawnProcess: () => { throw Error('synthetic private path'); } }), false);
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

test('owned cleanup tolerates persistent version metadata but waits for singleton links without following or removing them', async t => {
  const f = await fixture(t), version = join(f.paths.chrome, 'RunningChromeVersion');
  await symlink('153.0.8010.53:1', version);
  await waitForAgentBrowserCleanup(f.paths, { wait: () => assert.fail('version metadata must not delay cleanup') });
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const marker = join(f.paths.chrome, name);
    await symlink(f.retained, marker);
    let elapsed = 0, waits = 0;
    await assert.rejects(waitForAgentBrowserCleanup(f.paths, {
      timeoutMs: 100, now: () => elapsed, wait: async ms => { elapsed += ms; waits++; },
    }), /AGENT_BROWSER_CLOSE_TIMED_OUT/);
    assert.equal(elapsed, 100); assert.equal(waits, 2);
    assert.equal((await lstat(marker)).isSymbolicLink(), true);
    assert.equal(await readlink(marker), f.retained);
    await waitForAgentBrowserCleanup(f.paths, { wait: async () => { await rm(marker); } });
  }
  await waitForAgentBrowserCleanup(f.paths);
  assert.equal(await readlink(version), '153.0.8010.53:1');
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
  await rm(f.paths.chrome, { recursive: true }); await symlink(f.retained, f.paths.chrome);
  await assert.rejects(waitForAgentBrowserCleanup(f.paths), /UNSAFE_PRIVATE_TEST_DIRECTORY/);
  assert.deepEqual(await fileInventory(f.retained), f.baseline);
});

test('login readiness accepts persistent version metadata but fails on probe timeout or stale singleton links', async t => {
  for (const scenario of ['clean', 'persistent-version', 'stale-singleton', 'probe-timeout']) {
    await t.test(scenario, async t => {
      const f = await fixture(t), marker = join(f.paths.chrome, 'RunningChromeVersion');
      const singleton = join(f.paths.chrome, 'SingletonLock');
      const chrome = { application: f.paths.chromeApplication, executable: join(f.paths.chromeApplication, 'Contents/MacOS/Google Chrome'),
        version: '153.0.8010.53' };
      const browser = loginBrowser(request => scenario === 'probe-timeout' && request.method === 'Runtime.evaluate');
      // Synthetic browser state only: replay the marker remaining during shutdown.
      await symlink('153.0.8010.53:1', marker);
      if (scenario !== 'persistent-version') await symlink('synthetic-host-99', singleton);
      let elapsed = 0, cleanupCalled = false;
      const result = await probeAgentLogin(chrome, f.paths, { ...browser, timeoutMs: 100,
        waitForCleanup: async paths => {
          cleanupCalled = true;
          assert.notEqual(browser.launches[0].child.exitCode, null);
          assert.ok(browser.launches[0].child.stdio[3].destroyed);
          assert.ok(scenario === 'probe-timeout' ? browser.killed.length > 0 : browser.calls.some(call => call.method === 'Browser.close'));
          await waitForAgentBrowserCleanup(paths, { timeoutMs: 100, now: () => elapsed,
            wait: async ms => {
              elapsed += ms;
              if (scenario !== 'stale-singleton') await rm(singleton);
              if (scenario === 'clean') await rm(marker);
            } });
        } });
      assert.equal(cleanupCalled, true);
      assert.equal(result, ['clean', 'persistent-version'].includes(scenario));
      if (scenario !== 'clean') assert.equal(await readlink(marker), '153.0.8010.53:1');
      if (scenario === 'stale-singleton') {
        assert.equal(elapsed, 100); assert.equal(await readlink(singleton), 'synthetic-host-99');
      }
      if (scenario === 'persistent-version') assert.equal(elapsed, 0);
      await validateAgentState(f.paths, { processes: () => [], checkChrome: async () => chrome });
      assert.deepEqual(await fileInventory(f.retained), f.baseline);
    });
  }
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
