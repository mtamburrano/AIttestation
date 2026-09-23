import test from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initializeAgentConfig, resolveAgentConfig } from '../spikes/development/agent-config.mjs';
import { AGENT_OPT_IN, AGENT_PROFILE, agentAccount, initializeAgent } from '../spikes/development/agent-environment.mjs';
import { agentCommand, preflightAgent } from '../spikes/development/agent.mjs';
import { ownerDirectory, privateJSON, writeNewJSON } from '../spikes/development/environment.mjs';
import { fileInventory } from '../spikes/distribution/inventory.mjs';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';

async function fixture(t) {
  const home = await realpath(await mkdtemp('/private/tmp/agent-config-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const info = { username: 'synthetic-signer', uid: process.getuid(), homedir: home };
  const agent = { profile: AGENT_PROFILE, namespace: 'fixture01', automation: 'local-api',
    account: { username: info.username, uid: info.uid, home } };
  const inputs = join(home, 'original-inputs'); await mkdir(inputs, { mode: 0o700 });
  const sourcePath = join(inputs, 'private-config.json'), sourceProfile = join(inputs, 'private-profile');
  const config = { profile: 'pap-private-development/1', teamId: 'TESTTEAM01', signingIdentity: 'A'.repeat(40),
    helperProvisioningProfile: sourceProfile, signingKeychain: join(inputs, 'unused-synthetic-keychain'), sponsor: null, agent };
  await writeNewJSON(sourcePath, config);
  await writeFile(sourceProfile, 'synthetic helper profile: no Keychain access or signing', { mode: 0o600 });
  const baseline = await fileInventory(inputs);
  return { home, info, agent, config, inputs, sourcePath, sourceProfile, baseline };
}

function probes(f, seen = []) {
  return { info: f.info, consoleUID: async () => f.info.uid, ipc: async () => true,
    signingInputs: async path => {
      seen.push(path);
      const config = await privateJSON(path);
      assert.equal(await readFile(config.helperProvisioningProfile, 'utf8'), 'synthetic helper profile: no Keychain access or signing');
      return { config };
    },
    signing: async () => ({ status: 'READY' }), build: async () => ({ app: '/unused-synthetic-app' }),
    keychain: () => ({ status: 'READY' }),
    chrome: () => assert.fail('offline preflight must not access Chrome'),
    login: () => assert.fail('offline preflight must not access the provider') };
}

test('one-time init preserves its inputs and normal commands resolve only the persisted namespace', async t => {
  const f = await fixture(t);
  assert.deepEqual(await agentCommand(['init', f.sourcePath, AGENT_OPT_IN], { info: f.info }),
    { profile: AGENT_PROFILE, initialized: true, namespace: f.agent.namespace });
  assert.deepEqual(await fileInventory(f.inputs), f.baseline);
  for (const file of [f.sourcePath, f.sourceProfile]) assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const selected = await resolveAgentConfig(f.agent.namespace, AGENT_OPT_IN, f.info);
  const { configPath, config, paths } = selected;
  assert.equal(configPath, join(f.home, '.attestamp-agent-fixture01/bootstrap/agent-config.json'));
  assert.deepEqual(config, { ...f.config, helperProvisioningProfile: join(paths.bootstrap, 'helper.provisionprofile') });
  await ownerDirectory(paths.root); await ownerDirectory(paths.bootstrap);
  for (const file of [configPath, config.helperProvisioningProfile]) assert.equal((await lstat(file)).mode & 0o777, 0o600);

  // Removing the original addresses models a new session with no remembered
  // source path. Only the copies established by initialization remain usable.
  const movedInputs = join(f.home, 'retained-inputs'); await rename(f.inputs, movedInputs);
  const seen = [];
  const preflight = (namespace, build, optIn, live) => preflightAgent(namespace, build, optIn, live, probes(f, seen));
  const report = await agentCommand(['preflight', f.agent.namespace, 'one', AGENT_OPT_IN], { preflight });
  assert.equal(report.status, 'READY'); assert.equal(report.providerSend, false); assert.deepEqual(seen, [configPath]);
  let prepared = false, started = false, bootstrapped = false;
  const deps = { info: f.info,
    prepare: async (path, output, options) => {
      assert.equal(path, configPath); assert.equal(output, join(paths.builds, 'one'));
      assert.equal(options.agentOptIn, AGENT_OPT_IN); assert.deepEqual(await privateJSON(path), config);
      prepared = true; return { prepared: true };
    },
    start: async (namespace, selectedConfig, selectedPaths, build, live) => {
      assert.equal(namespace, f.agent.namespace); assert.deepEqual(selectedConfig, config);
      assert.deepEqual(selectedPaths, paths); assert.equal(build, 'one'); assert.equal(live, false);
      started = true; return { started: true };
    },
    bootstrap: async (selectedConfig, selectedPaths, build, live) => {
      assert.deepEqual(selectedConfig, config); assert.deepEqual(selectedPaths, paths);
      assert.equal(build, 'one'); assert.equal(live, false); bootstrapped = true; return { status: 'READY' };
    } };
  assert.equal((await agentCommand(['prepare', f.agent.namespace, 'one', AGENT_OPT_IN], deps)).prepared, true);
  assert.equal((await agentCommand(['start', f.agent.namespace, 'one', AGENT_OPT_IN], deps)).started, true);
  assert.equal((await agentCommand(['bootstrap', f.agent.namespace, 'one', AGENT_OPT_IN, '--owner-bootstrap'], deps)).status, 'READY');
  assert.ok(prepared && started && bootstrapped);
  assert.equal((await agentCommand(['stop', f.agent.namespace, AGENT_OPT_IN], { info: f.info })).stopped, true);
  assert.deepEqual(await fileInventory(movedInputs), f.baseline);
  assert.equal(copyApplicationResource('spikes/development/agent-config.mjs'), false);

  const script = `const { resolveAgentConfig } = await import(process.argv[1]);
    const selected = await resolveAgentConfig(process.argv[2], '--agent-mode', JSON.parse(process.argv[3]));
    process.stdout.write(JSON.stringify({ path: selected.configPath, namespace: selected.config.agent.namespace }));`;
  const freshProcess = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script,
    new URL('../spikes/development/agent-config.mjs', import.meta.url).href, f.agent.namespace, JSON.stringify(f.info)], {
    cwd: movedInputs, env: { PATH: '/usr/bin:/bin', ATTESTAMP_AGENT_CONFIG: f.sourcePath,
      ATTESTAMP_AGENT_NAMESPACE: 'different01' }, encoding: 'utf8', timeout: 10000,
  }));
  assert.deepEqual(freshProcess, { path: configPath, namespace: f.agent.namespace });
});

test('namespace selection rejects caller paths, missing setup and incomplete initialization without fallback', async t => {
  const f = await fixture(t), namespace = f.agent.namespace;
  await assert.rejects(initializeAgentConfig('/unused-missing-config', undefined, f.info), /AGENT_OPT_IN_REQUIRED/);
  for (const selection of [f.sourcePath, '../fixture01', 'fixture01/child', '', undefined, null, 123, {}]) {
    await assert.rejects(resolveAgentConfig(selection, AGENT_OPT_IN, f.info), /AGENT_CONFIG_INVALID/);
    assert.equal((await preflightAgent(selection, 'one', AGENT_OPT_IN, false, probes(f))).reason, 'AGENT_CONFIG_INVALID');
    for (const action of ['prepare', 'start', 'stop']) {
      const args = [action, selection, ...(action === 'stop' ? [] : ['one']), AGENT_OPT_IN];
      assert.equal((await agentCommand(args, { info: f.info })).reason, 'AGENT_CONFIG_INVALID');
    }
  }
  await assert.rejects(resolveAgentConfig(namespace, undefined, f.info), /AGENT_OPT_IN_REQUIRED/);
  assert.equal((await preflightAgent(namespace, 'one', AGENT_OPT_IN, false, probes(f))).reason, 'AGENT_CONFIG_NOT_PREPARED');
  await initializeAgent(f.agent, AGENT_OPT_IN, f.info);
  const paths = agentAccount(f.agent, AGENT_OPT_IN, f.info);
  await mkdir(join(paths.root, 'bootstrap'), { mode: 0o700 });
  const before = await fileInventory(paths.root);
  await assert.rejects(resolveAgentConfig(namespace, AGENT_OPT_IN, f.info), /AGENT_CONFIG_NOT_PREPARED/);
  await assert.rejects(initializeAgentConfig(f.sourcePath, AGENT_OPT_IN, f.info), { code: 'EEXIST' });
  assert.deepEqual(await fileInventory(paths.root), before);
  assert.deepEqual(await fileInventory(f.inputs), f.baseline);
});

test('canonical config rejects redirection, unsafe files and namespace/account mismatches', async t => {
  for (const variation of ['root-link', 'bootstrap-link', 'config-link', 'config-hardlink', 'public-config',
    'missing-config', 'wrong-namespace', 'wrong-account', 'external-profile', 'sponsor-enabled']) {
    await t.test(variation, async t => {
      const f = await fixture(t);
      await initializeAgentConfig(f.sourcePath, AGENT_OPT_IN, f.info);
      const { config, configPath, paths } = await resolveAgentConfig(f.agent.namespace, AGENT_OPT_IN, f.info);
      if (variation === 'root-link' || variation === 'bootstrap-link') {
        const path = variation === 'root-link' ? paths.root : paths.bootstrap;
        const moved = join(f.home, 'redirected'); await rename(path, moved); await symlink(moved, path);
      } else if (['config-link', 'config-hardlink', 'public-config', 'missing-config'].includes(variation)) {
        await rm(configPath);
        if (variation === 'config-link') await symlink(f.sourcePath, configPath);
        if (variation === 'config-hardlink') await link(f.sourcePath, configPath);
        if (variation === 'public-config') await writeFile(configPath, JSON.stringify(config), { mode: 0o644 });
      } else {
        if (variation === 'wrong-namespace') config.agent.namespace = 'another01';
        if (variation === 'wrong-account') config.agent.account.uid++;
        if (variation === 'external-profile') config.helperProvisioningProfile = f.sourceProfile;
        if (variation === 'sponsor-enabled') config.sponsor = { origin: 'https://127.0.0.1:37461', certificateFile: '/unused' };
        await writeFile(configPath, JSON.stringify(config));
      }
      const report = await preflightAgent(f.agent.namespace, 'one', AGENT_OPT_IN, false, {
        info: f.info, consoleUID: () => assert.fail('unsafe config must fail before platform or signing probes') });
      assert.equal(report.status, 'OWNER_ACTION_REQUIRED');
      assert.ok(!JSON.stringify(report).includes(f.home));
      if (variation === 'missing-config') assert.equal(report.reason, 'AGENT_CONFIG_NOT_PREPARED');
      if (variation === 'wrong-namespace') assert.equal(report.reason, 'AGENT_NAMESPACE_MISMATCH');
      if (variation === 'wrong-account') assert.equal(report.reason, 'AGENT_ACCOUNT_MISMATCH');
      if (variation === 'config-hardlink') await rm(configPath);
      assert.deepEqual(await fileInventory(f.inputs), f.baseline);
    });
  }
});

test('a missing copied profile fails preflight but does not prevent namespace-based stop', async t => {
  const f = await fixture(t); await initializeAgentConfig(f.sourcePath, AGENT_OPT_IN, f.info);
  const { config } = await resolveAgentConfig(f.agent.namespace, AGENT_OPT_IN, f.info);
  await rm(config.helperProvisioningProfile);
  assert.equal((await preflightAgent(f.agent.namespace, 'one', AGENT_OPT_IN, false, probes(f))).reason, 'SIGNING_INPUTS_INVALID');
  assert.equal((await agentCommand(['stop', f.agent.namespace, AGENT_OPT_IN], { info: f.info })).stopped, true);
  assert.deepEqual(await fileInventory(f.inputs), f.baseline);
});
