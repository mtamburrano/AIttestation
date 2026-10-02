import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { OWNER_ACCEPTANCE_PROFILE, initializeOwnerAcceptance, ownerAcceptanceAccount, ownerAcceptanceManifest,
  ownerAcceptanceRuntimeOptions, validateOwnerAcceptance, validateOwnerAcceptanceLaunch, validateOwnerAcceptanceManifest,
  validateOwnerAcceptanceState } from '../spikes/development/owner-acceptance.mjs';
import { ownerAcceptanceArtifactSources, specializeOwnerAcceptanceArtifact } from '../spikes/development/owner-artifact.mjs';
import { DEVELOPMENT_PROFILE, privateManifestNamespace, testAccount, validatePrivateLaunchRequest } from '../spikes/development/environment.mjs';
import { prepareDevelopment, validateDevelopmentConfig } from '../spikes/development/prepare.mjs';
import { agentAccount, AGENT_OPT_IN } from '../spikes/development/agent-environment.mjs';
import { inspectCodexHookOwnership } from '../spikes/development/inspect-codex-hook.mjs';
import { privateInstallation } from '../spikes/development/integration.mjs';
import { releaseBuildPlan, validateBuildConfig } from '../spikes/distribution/release-inputs.mjs';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';
import { discoverClients } from '../spikes/coding/discovery.mjs';
import { ownedHook, parseSettings } from '../spikes/coding/settings.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';

const repository = resolve(import.meta.dirname, '..');
async function fixture(t) {
  const home = await realpath(await mkdtemp('/private/tmp/oa-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const info = { username: 'synthetic-owner', uid: process.getuid(), homedir: home };
  const owner = { profile: OWNER_ACCEPTANCE_PROFILE, namespace: 'abcdef123456',
    account: { username: info.username, uid: info.uid, home } };
  const config = { profile: DEVELOPMENT_PROFILE, teamId: 'TESTTEAM01', signingIdentity: 'A'.repeat(40),
    helperProvisioningProfile: join(home, 'synthetic-profile-never-read'), sponsor: null, ownerAcceptance: owner };
  const paths = ownerAcceptanceAccount(owner, info);
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, value, { mode: 0o700 }); return path;
  };
  return { home, info, owner, config, paths, put };
}

test('owner mode binds an explicit account before any resource access and cannot replace existing lanes', async t => {
  const f = await fixture(t);
  assert.doesNotThrow(() => validateDevelopmentConfig(f.config));
  for (const info of [{ ...f.info, uid: f.info.uid + 1 }, { ...f.info, username: 'different' }, { ...f.info, homedir: '/not-read' }]) {
    await assert.rejects(initializeOwnerAcceptance(f.owner, info), /ACCOUNT_MISMATCH/);
    await assert.rejects(validateOwnerAcceptance(f.owner, info), /ACCOUNT_MISMATCH/);
  }
  for (const account of [{ ...f.owner.account, uid: 0 }, { ...f.owner.account, username: 'attestamp-test' },
    { ...f.owner.account, home: '/' }, { ...f.owner.account, home: '/Users/attestamp-test' },
    { ...f.owner.account, home: `${f.home}/../other` }]) {
    assert.throws(() => ownerAcceptanceAccount({ ...f.owner, account }, f.info), /ACCOUNT_INVALID/);
  }
  assert.deepEqual(await readdir(f.home), []);
  assert.throws(() => testAccount(f.info), /DEDICATED_MACOS_TEST_USER/);
  assert.throws(() => agentAccount(f.owner, AGENT_OPT_IN, f.info), /AGENT_CONFIG_INVALID/);
  for (const changes of [{ agent: {} }, { namespace: '6d1110ab' }, { sponsor: { origin: 'https://127.0.0.1:37461' } }]) {
    assert.throws(() => validateDevelopmentConfig({ ...f.config, ...changes }), /MODE_MIXING/);
  }
  for (const changes of [{ automation: 'local-api' }, { supportDirectory: '/not-read' }, { namespace: '../existing' }]) {
    assert.throws(() => ownerAcceptanceAccount({ ...f.owner, ...changes }, f.info), /CONFIG_INVALID/);
  }
  const configPath = await f.put(join(f.home, 'config.json'), JSON.stringify(f.config)); await chmod(configPath, 0o600);
  await assert.rejects(prepareDevelopment(configPath, join(f.home, 'build')), /ACCOUNT_MISMATCH/);
  assert.deepEqual(await readdir(f.home), ['config.json']);
});

test('owner state is fresh, private, canonical and namespace-bound without adopting retained state', async t => {
  const f = await fixture(t);
  const sentinel = await f.put(join(f.home, 'synthetic-retained/support/keep'), 'retained fixture');
  await initializeOwnerAcceptance(f.owner, f.info);
  assert.deepEqual(await validateOwnerAcceptance(f.owner, f.info), f.paths);
  await validateOwnerAcceptanceState(f.paths);
  await assert.rejects(initializeOwnerAcceptance(f.owner, f.info), { code: 'EEXIST' });
  assert.equal(await readFile(sentinel, 'utf8'), 'retained fixture');
  await chmod(f.paths.support, 0o755);
  await assert.rejects(validateOwnerAcceptance(f.owner, f.info), /UNSAFE_PRIVATE_TEST_DIRECTORY/);
  await chmod(f.paths.support, 0o700);
  await symlink(dirname(sentinel), join(f.paths.support, 'vault'));
  await assert.rejects(validateOwnerAcceptanceState(f.paths), /STATE_UNSAFE/);
  await rm(join(f.paths.support, 'vault'));
  await link(sentinel, join(f.paths.support, 'shared'));
  await assert.rejects(validateOwnerAcceptanceState(f.paths), /STATE_UNSAFE/);
  await rm(join(f.paths.support, 'shared'));
  await symlink(dirname(sentinel), join(f.paths.chrome, 'Default'));
  await assert.rejects(validateOwnerAcceptanceState(f.paths), /STATE_UNSAFE/);
  await rm(join(f.paths.chrome, 'Default'));
  await symlink('154.0.8037.58:1', join(f.paths.chrome, 'RunningChromeVersion'));
  await validateOwnerAcceptanceState(f.paths, { chrome: { version: '154.0.8037.58' } });
  await assert.rejects(validateOwnerAcceptanceState(f.paths, { chrome: { version: '154.0.0.0' } }), /STATE_UNSAFE/);
  await rm(join(f.paths.chrome, 'RunningChromeVersion'));
  const socketPath = join(f.paths.support, 'bridge-11111111-222.sock'), server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    await validateOwnerAcceptanceState(f.paths);
    await chmod(socketPath, 0o666);
    await assert.rejects(validateOwnerAcceptanceState(f.paths), /STATE_UNSAFE/);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await writeFile(join(f.paths.root, 'owner-acceptance.json'), JSON.stringify({ ...f.owner, namespace: '123456abcdef' }));
  await assert.rejects(validateOwnerAcceptance(f.owner, f.info), /STATE_MISMATCH/);
  const other = { ...f.owner, namespace: '123456abcdef' }, otherPaths = ownerAcceptanceAccount(other, f.info);
  await symlink(f.paths.root, otherPaths.root);
  await assert.rejects(initializeOwnerAcceptance(other, f.info), { code: 'EEXIST' });
  await assert.rejects(validateOwnerAcceptance(other, f.info), /UNSAFE_PRIVATE_TEST_DIRECTORY/);
  const aliasHome = join(f.home, 'alias'); await symlink(f.home, aliasHome);
  const aliased = { ...f.owner, account: { ...f.owner.account, home: aliasHome } };
  await assert.rejects(initializeOwnerAcceptance(aliased, { ...f.info, homedir: aliasHome }), /CANONICAL_NEW_TEST_DIRECTORY/);
});

test('owner manifest and launch reject ambient authority, other modes and changed accounts', async t => {
  const f = await fixture(t), manifest = ownerAcceptanceManifest(f.owner);
  assert.deepEqual(validateOwnerAcceptanceManifest(manifest), f.owner);
  for (const changes of [{ agent: {} }, { namespace: '6d1110ab' }, { sponsorOrigin: 'https://127.0.0.1:37461' },
    { updaterEnabled: true }, { assurance: 'PRODUCTION' }, { ownerAcceptance: null }, { automation: 'local-api' }]) {
    assert.throws(() => validateOwnerAcceptanceManifest({ ...manifest, ...changes }));
  }
  assert.throws(() => privateManifestNamespace(manifest), /INVALID_PRIVATE_BUILD/);
  const launch = { profile: DEVELOPMENT_PROFILE, mode: 'owner-acceptance', ownerAcceptance: f.owner,
    chromeApplication: join(f.home, 'Synthetic Chrome.app') };
  assert.equal(validateOwnerAcceptanceLaunch(launch, f.owner), launch);
  for (const changes of [{ mode: 'live-chatgpt-testnet' }, { mode: 'offline' }, { mode: 'live-provider-send' },
    { ownerAcceptance: { ...f.owner, namespace: '123456abcdef' } }, { agent: {} }, { namespace: '6d1110ab' }]) {
    assert.throws(() => validateOwnerAcceptanceLaunch({ ...launch, ...changes }, f.owner), /EXPLICIT_OWNER_ACCEPTANCE/);
  }
  assert.throws(() => validatePrivateLaunchRequest(launch, null), /EXPLICIT_PRIVATE_OPERATION/);
});

test('release builders reject owner and other test authority even when empty or paired with valid release metadata', async t => {
  const f = await fixture(t);
  for (const releaseChannel of ['production', 'release-candidate']) {
    assert.equal(releaseBuildPlan({ releaseChannel }).releaseChannel, releaseChannel);
    for (const authority of [{ ownerAcceptance: f.owner }, { ownerAcceptance: null }, { ownerAcceptance: undefined },
      { profile: OWNER_ACCEPTANCE_PROFILE }, { profile: DEVELOPMENT_PROFILE }, { agent: {} }, { namespace: '6d1110ab' }, { sponsor: null }]) {
      for (const validate of [releaseBuildPlan, validateBuildConfig]) {
        assert.throws(() => validate({ releaseChannel, ...authority }), /PRIVATE_AUTHORITY_IN_RELEASE_INPUT/);
      }
    }
  }
  for (const path of ['owner-acceptance.mjs', 'owner-artifact.mjs', 'inspect-codex-hook.mjs']) {
    assert.equal(copyApplicationResource(`spikes/development/${path}`), false);
  }
});

test('shared resident discovers configured owner clients without writes; apply, trust, conflicts and owned removal stay intact', async t => {
  const f = await fixture(t); await initializeOwnerAcceptance(f.owner, f.info);
  const network = restrictFixtureNetwork(f.home);
  const bin = join(f.home, 'synthetic-bin');
  const codex = await f.put(join(bin, 'codex'), 'synthetic native codex');
  await f.put(join(bin, 'claude'), 'synthetic native claude');
  const codexPath = await f.put(join(f.home, '.codex/hooks.json'), '{"unrelated":"preserve","hooks":{"UserPromptSubmit":[]}}\n');
  const claudePath = await f.put(join(f.home, '.claude/settings.json'), '{"permissions":{"allow":["synthetic"]}}\n');
  const before = await Promise.all([codexPath, claudePath].map(path => readFile(path)));
  const options = ownerAcceptanceRuntimeOptions(f.owner, f.info, args => {
    assert.equal(args.home, f.home);
    return discoverClients({ ...args, globalBins: [bin], applications: join(f.home, 'Applications') });
  });
  assert.equal(options.managed, null);
  assert.equal(options.integrationHomes.firefox, join(f.home, 'Library/Application Support/Mozilla/NativeMessagingHosts'));
  let runtime;
  try {
    runtime = await startPackagedChatGPT({ ...options, supportDirectory: f.paths.support, keyStore: new MemoryKeyStore(),
      fastTrust: { profile: 'PAP_ALGORAND_FAST_CONFIRM_V1' },
      installation: privateInstallation(f.paths, join(f.home, 'synthetic-browser-host'), 'PRIVATE_OWNER_ACCEPTANCE'),
      codeIdentity: async () => 'a'.repeat(40), hookPeer: () => { throw Error('NO_NATIVE_CLIENT'); },
      attestPeer: () => { throw Error('NO_BROWSER'); }, collectFast: () => { throw Error('NO_ANCHOR'); },
      openDashboard: () => { throw Error('NO_BROWSER'); } });
    assert.equal(runtime.engine.state().recording, false);
    assert.equal((await runtime.maintenance.status()).releaseClass, 'PRIVATE_OWNER_ACCEPTANCE');
    await assert.rejects(runtime.maintenance.checkUpdate(), /not configured/);
    await assert.rejects(runtime.maintenance.store(), /OWNER_ACCEPTANCE_STORE_UNAVAILABLE/);
    assert.equal(runtime.agentControl, undefined);
    const manager = runtime.integrationManager;
    const firefox = await manager.preview({ client: 'firefox-chatgpt' });
    await assert.rejects(readFile(firefox.configPath), { code: 'ENOENT' });
    await assert.rejects(manager.apply({ operationId: firefox.operationId, consent: false }), /CONSENT_REQUIRED/);
    await assert.rejects(readFile(firefox.configPath), { code: 'ENOENT' });
    for (const client of ['codex', 'claude-code']) {
      assert.equal((await manager.discover({ client })).authority, 'NONE');
      const plan = await manager.preview({ client });
      assert.equal(plan.configPath, client === 'codex' ? codexPath : claudePath);
      await assert.rejects(manager.apply({ operationId: plan.operationId, consent: false }), /CONSENT_REQUIRED/);
    }
    assert.deepEqual(await Promise.all([codexPath, claudePath].map(path => readFile(path))), before);
    const stale = await manager.preview({ client: 'codex' });
    await f.put(codex, 'updated synthetic executable');
    await assert.rejects(manager.apply({ operationId: stale.operationId, consent: true }), /CONFLICT/);
    assert.deepEqual(await readFile(codexPath), before[0]);
    const revisionPlan = await manager.preview({ client: 'codex' });
    await writeFile(codexPath, before[0].toString() + ' ');
    await assert.rejects(manager.apply({ operationId: revisionPlan.operationId, consent: true }), /CONFLICT/);
    await writeFile(codexPath, before[0]);
    for (const client of ['codex', 'claude-code']) {
      const plan = await manager.preview({ client });
      const result = await manager.apply({ operationId: plan.operationId, consent: true });
      assert.equal(result.state, client === 'codex' ? 'TRUST_REQUIRED' : 'CONFIGURED');
    }
    const installed = await readFile(codexPath);
    const toml = await f.put(join(f.home, '.codex/config.toml'), '[hooks]\nUserPromptSubmit = []\n');
    await assert.rejects(manager.preview({ client: 'codex', action: 'remove' }), /CODEX_DUAL_HOOK_CONFIGURATION/);
    assert.deepEqual(await readFile(codexPath), installed);
    assert.equal(await readFile(toml, 'utf8'), '[hooks]\nUserPromptSubmit = []\n');
    const inspection = { configRoot: join(f.home, '.codex'), journalPath: join(f.paths.support, 'coding-integrations.json'),
      receiver: join(dirname(process.execPath), 'provenance-hook-receiver') };
    const report = await inspectCodexHookOwnership(inspection);
    assert.equal(report.dualConfiguration, true); assert.equal(report.removalAuthorized, false);
    assert.deepEqual(report.files[1].hooks, [{ index: 0, ownership: 'MATCHED_ATTESTAMP_JOURNAL' }]);
    assert.equal((await inspectCodexHookOwnership({ ...inspection, receiver: join(f.home, 'wrong-receiver') })).files[1].hooks[0].ownership, 'UNPROVEN');
    assert.deepEqual(await readFile(codexPath), installed);
    await rm(toml);
    for (const client of ['codex', 'claude-code']) {
      const removal = await manager.preview({ client, action: 'remove' });
      assert.equal((await manager.apply({ operationId: removal.operationId, consent: true })).state, 'REMOVED');
    }
    const removedCodex = parseSettings(await readFile(codexPath, 'utf8'), 'json');
    assert.equal(removedCodex.unrelated, 'preserve'); assert.deepEqual(removedCodex.hooks.UserPromptSubmit, []);
    assert.deepEqual(parseSettings(await readFile(claudePath, 'utf8'), 'json').permissions, { allow: ['synthetic'] });
  } finally { await runtime?.close(); network.restore(); }
  await validateOwnerAcceptanceState(f.paths);
});

test('read-only ownership inspection never treats names, comments, altered or duplicated hooks as ownership', async t => {
  const f = await fixture(t), configRoot = join(f.home, '.codex'), receiver = join(f.home, 'Synthetic.app/receiver');
  const journalPath = join(f.home, 'prior-support/coding-integrations.json'), installationId = '11111111-2222-4333-8444-555555555555';
  const hook = ownedHook('codex', receiver, installationId), configPath = join(configRoot, 'hooks.json');
  const journal = { profile: 'pap-coding-integrations/2', entries: { codex: {
    client: 'codex', state: 'configured', configRoot, configPath, format: 'json', installationId, hook,
  } } };
  const args = { configRoot, journalPath, receiver };
  assert.deepEqual((await inspectCodexHookOwnership(args)).files.map(file => file.exists), [false, false]);
  assert.deepEqual(await readdir(f.home), []);
  await f.put(journalPath, JSON.stringify(journal));
  for (const groups of [
    [{ hooks: [{ type: 'command', command: 'echo Attestamp', timeout: 1 }] }],
    [{ hooks: [{ ...hook.hooks[0], timeout: 2 }] }], [hook, hook],
  ]) {
    const bytes = JSON.stringify({ hooks: { UserPromptSubmit: groups } }); await f.put(configPath, bytes);
    assert.ok((await inspectCodexHookOwnership(args)).files[1].hooks.every(value => value.ownership === 'UNPROVEN'));
    assert.equal(await readFile(configPath, 'utf8'), bytes);
  }
  const tomlPath = join(configRoot, 'config.toml');
  const toml = `# Attestamp ${installationId}\n[hooks]\nUserPromptSubmit = []\n`;
  await f.put(tomlPath, toml); await f.put(configPath, JSON.stringify({ hooks: { UserPromptSubmit: [hook] } }));
  const before = await Promise.all([journalPath, tomlPath, configPath].map(path => readFile(path)));
  assert.equal((await inspectCodexHookOwnership(args)).files[1].hooks[0].ownership, 'MATCHED_ATTESTAMP_JOURNAL');
  assert.deepEqual(await Promise.all([journalPath, tomlPath, configPath].map(path => readFile(path))), before);
  await rm(journalPath);
  assert.equal((await inspectCodexHookOwnership(args)).files[1].hooks[0].ownership, 'UNPROVEN');
  await rm(configPath); await symlink(tomlPath, configPath);
  await assert.rejects(inspectCodexHookOwnership(args), /UNSAFE_INSTALL_FILE/);
});

test('owner native inputs isolate the lock, rendezvous and keys and compile without signing or execution', async t => {
  const f = await fixture(t), sources = {};
  for (const [kind, path] of Object.entries({ host: 'spikes/vault/native/macos-app-host.swift', helper: 'spikes/vault/native/macos-keychain-helper.swift',
    hookReceiver: 'spikes/coding/native/macos-hook-receiver.swift', chromeRelay: 'spikes/browser/chatgpt/native-host.mjs',
    firefoxRelay: 'spikes/browser/firefox/native-host.mjs' })) sources[kind] = await readFile(join(repository, path), 'utf8');
  const specialized = ownerAcceptanceArtifactSources(sources, f.owner, f.info);
  assert.ok(!Object.values(specialized).some(source => source.includes('Library/Application Support/Private Provenance')));
  assert.ok(!specialized.host.includes('attestamp-test')); assert.ok(!specialized.host.includes('--agent-'));
  assert.ok(specialized.host.indexOf('try ownerAcceptanceValidateAccount()') < specialized.host.indexOf('let instanceLock = try lockApplicationInstance()'));
  assert.ok(specialized.helper.includes(Buffer.from(f.paths.keychainService).toString('base64')));
  assert.ok(!specialized.helper.includes('managed:anchoring')); assert.ok(!specialized.helper.includes('agent:readiness'));
  assert.ok(specialized.hookReceiver.includes('try ownerAcceptanceValidateAccount()'));
  for (const kind of ['chromeRelay', 'firefoxRelay']) assert.ok(specialized[kind].includes(f.paths.support));
  assert.throws(() => ownerAcceptanceArtifactSources({ ...sources, helper: '' }, f.owner, f.info), /BUILD_INPUT_CHANGED/);
  const contents = join(f.home, 'synthetic-contents'), work = join(f.home, 'compile-test'); await mkdir(work);
  const keyStorePath = join(contents, 'Resources/spikes/platform/macos/key-store.mjs');
  await mkdir(dirname(keyStorePath), { recursive: true });
  await copyFile(join(repository, 'spikes/platform/macos/key-store.mjs'), keyStorePath);
  for (const browser of ['chatgpt', 'firefox']) await mkdir(join(contents, `Resources/spikes/browser/${browser}`), { recursive: true });
  const calls = [];
  await specializeOwnerAcceptanceArtifact(repository, contents, work, f.owner, (exe, args) => calls.push({ exe, args }), f.info);
  assert.equal(calls.length, 3);
  assert.ok((await readFile(keyStorePath, 'utf8')).includes(`const DEFAULT_SERVICE = "${f.paths.keychainService}";`));
  if (process.platform === 'darwin') for (const { exe, args } of calls) {
    const checked = spawnSync(exe, [...args.slice(0, args.indexOf('-o')), '-typecheck'],
      { env: { PATH: '/usr/bin:/bin', HOME: f.home, TMPDIR: f.home }, encoding: 'utf8', timeout: 60000 });
    assert.equal(checked.status, 0, checked.stderr);
  }
});
