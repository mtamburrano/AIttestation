import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical } from '../vault/format.mjs';
import { sha256 } from '../distribution/release.mjs';
import { fileInventory } from '../distribution/inventory.mjs';
import { assertReleasePath, readReleaseFile } from '../distribution/release-inputs.mjs';
import { codeSignatureCheckArguments } from '../distribution/local.mjs';
import { DEVELOPMENT_PROFILE, exists, ownerDirectory, privateJSON, writeNewJSON } from './environment.mjs';
import { AGENT_OPT_IN, AGENT_PROFILE, agentAccount, agentBuildPath, initializeAgent, validateAgent, validateAgentState } from './agent-environment.mjs';
import { developmentSigningInputs, prepareDevelopment, validateDevelopmentConfig } from './prepare.mjs';
import { preflightSigning } from './signing.mjs';
import { checkPlatform, runningChromeProcesses } from './chrome.mjs';
import { agentExtensionReady, probeAgentLogin } from './agent-browser.mjs';
import { agentPermissions } from './agent-permissions.mjs';
import { registerNativeHost } from './integration.mjs';

const run = (command, args) => execFileSync(command, args, { env: { PATH: '/usr/bin:/bin' },
  encoding: 'utf8', stdio: 'pipe', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 65536 });
const reasons = new Set(['AGENT_OPT_IN_REQUIRED', 'AGENT_CONFIG_INVALID', 'AGENT_CONFIG_REQUIRED', 'AGENT_ACCOUNT_MISMATCH',
  'AGENT_PATH_TOO_LONG', 'AGENT_BUILD_NAME_INVALID', 'AGENT_NAMESPACE_MISMATCH', 'AGENT_STATE_UNSAFE', 'AGENT_STATE_LIMIT',
  'AGENT_SPONSOR_DISABLED', 'AGENT_BUILD_INVALID', 'AGENT_STATE_NOT_PREPARED', 'AGENT_COMMAND_INVALID',
  'AGENT_PREFLIGHT_TIMED_OUT', 'AGENT_PREFLIGHT_FAILED',
  'SIGNING_INPUTS_INVALID', 'SIGNING_AUTHORIZATION_REQUIRED', 'KEYCHAIN_SELECTION_REQUIRED', 'APPLE_SILICON_MAC_REQUIRED',
  'INVALID_SELECTION', 'INTERACTION_GUARD_UNAVAILABLE',
  'KEYCHAIN_UNAVAILABLE', 'KEYCHAIN_LOCKED', 'IDENTITY_UNAVAILABLE', 'IDENTITY_AMBIGUOUS', 'ACCESS_UNAVAILABLE',
  'CODESIGN_AUTHORIZATION_REQUIRED', 'PARTITION_AUTHORIZATION_REQUIRED', 'PREFLIGHT_TIMED_OUT', 'PREFLIGHT_UNAVAILABLE',
  'SIGNING_PROBE_TIMED_OUT', 'SIGNING_PROBE_FAILED', 'GUI_SESSION_REQUIRED', 'STOP_PREVIOUS_AGENT_SESSION',
  'LOCAL_IPC_PERMISSION_REQUIRED',
  'ACCESSIBILITY_PERMISSION_REQUIRED', 'SCREEN_RECORDING_PERMISSION_REQUIRED', 'AUTOMATION_PERMISSION_CHECK_UNAVAILABLE',
  'VAULT_KEYCHAIN_BOOTSTRAP_REQUIRED', 'VAULT_KEYCHAIN_UNAVAILABLE', 'CHROME_SETUP_REQUIRED', 'CLOSE_OTHER_CHROME_COPY',
  'EXTENSION_SETUP_REQUIRED', 'BROWSER_BOOTSTRAP_REQUIRED', 'PROVIDER_LOGIN_REQUIRED', 'AGENT_START_NOT_CONFIRMED',
  'AGENT_PREPARATION_FAILED']);
export const agentOwnerAction = reason => ({ profile: AGENT_PROFILE, status: 'OWNER_ACTION_REQUIRED',
  reason: reasons.has(reason) ? reason : 'AGENT_STATE_NOT_PREPARED' });
const ready = () => ({ profile: AGENT_PROFILE, status: 'READY', providerSend: false, sponsor: false,
  mainnet: false, publication: false, deployment: false });

export function boundedAgentPreflight(configPath, name, optIn, live, {
  spawnProcess = spawn, timeoutMs = 120000,
  killGroup = child => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } },
} = {}) {
  return new Promise(resolve => {
    let child, timer, output = '', finished = false;
    const finish = report => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
      killGroup(child); resolve(report);
    };
    const interrupted = () => finish(agentOwnerAction('AGENT_PREFLIGHT_FAILED'));
    try {
      child = spawnProcess(process.execPath, [fileURLToPath(new URL('agent-preflight-worker.mjs', import.meta.url)),
        configPath, name, optIn, live ? 'live-provider-send' : 'offline'], {
        env: { PATH: '/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      timer = setTimeout(() => finish(agentOwnerAction('AGENT_PREFLIGHT_TIMED_OUT')), timeoutMs);
      process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
      child.once('error', () => finish(agentOwnerAction('AGENT_PREFLIGHT_FAILED')));
      child.stdout.on('error', interrupted);
      child.stdout.on('data', bytes => {
        output += bytes.toString('utf8');
        if (Buffer.byteLength(output) > 4096) finish(agentOwnerAction('AGENT_PREFLIGHT_FAILED'));
      });
      child.once('close', code => {
        try {
          const report = JSON.parse(output);
          if (code === 2 && report.status === 'OWNER_ACTION_REQUIRED') finish(agentOwnerAction(report.reason));
          else if (code === 0 && report.profile === AGENT_PROFILE && report.status === 'READY'
              && report.providerSend === live && ['sponsor', 'mainnet', 'publication', 'deployment'].every(key => report[key] === false)
              && ['local-api', 'computer-use'].includes(report.automation)) {
            finish({ ...ready(), automation: report.automation, providerSend: live });
          } else finish(agentOwnerAction('AGENT_PREFLIGHT_FAILED'));
        } catch { finish(agentOwnerAction('AGENT_PREFLIGHT_FAILED')); }
      });
    } catch { finish(agentOwnerAction('AGENT_PREFLIGHT_FAILED')); }
  });
}

export async function probeAgentIPC(paths) {
  let directory;
  const servers = [];
  try {
    directory = await mkdtemp(join(paths.root, 'probe-'));
    for (const address of [join(directory, 'ipc.sock'), { host: '127.0.0.1', port: 0 }]) {
      const server = createServer(); servers.push(server);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('LOCAL_IPC_PERMISSION_REQUIRED')), 1000);
        server.once('error', error => { clearTimeout(timer); reject(error); });
        server.listen(address, () => { clearTimeout(timer); resolve(); });
      });
    }
    return true;
  } catch { return false; }
  finally {
    for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function inspectAgentBuild(config, paths, name, execute = run) {
  const output = agentBuildPath(paths, name); await ownerDirectory(output);
  const metadata = await privateJSON(join(output, 'private-build.json'));
  const app = join(output, 'package/Attestamp.app');
  await assertReleasePath(app, { directory: true });
  if (metadata.profile !== DEVELOPMENT_PROFILE || metadata.releaseClass !== 'PRIVATE_DEVELOPMENT'
      || metadata.updaterEnabled !== false || canonical(metadata.agent) !== canonical(config.agent)) throw Error('AGENT_BUILD_INVALID');
  execute('/usr/bin/codesign', codeSignatureCheckArguments(app,
    `anchor apple generic and certificate leaf[subject.OU] = "${config.teamId}"`, { deep: true }));
  const manifest = await privateJSON(join(app, 'Contents/Resources/spikes/development/private-development.json'));
  if (Object.keys(manifest).sort().join(',') !== 'agent,assurance,browserPolicy,build,profile,sponsorOrigin,updaterEnabled'
      || manifest.profile !== DEVELOPMENT_PROFILE || manifest.sponsorOrigin !== null || manifest.updaterEnabled !== false
      || manifest.assurance !== 'PRIVATE_TESTNET_ONLY' || manifest.browserPolicy !== 'EXPLICIT_TEST_USER_COPY'
      || manifest.build !== name || canonical(manifest.agent) !== canonical(config.agent)) throw Error('AGENT_BUILD_INVALID');
  const inventory = JSON.parse(await readReleaseFile(join(output, 'private-inventory.json'), { privateFile: true, limit: 4 * 1024 * 1024 }));
  const observed = { application: await fileInventory(app),
    verifier: await fileInventory(join(output, 'package/Recipient/Attestamp Verifier.app')),
    extension: await fileInventory(join(output, 'extension')) };
  if (canonical(inventory) !== canonical(observed) || sha256(canonical(inventory)) !== metadata.bundleInventoryDigest) {
    throw Error('AGENT_BUILD_INVALID');
  }
  return { app, digest: metadata.bundleInventoryDigest, extensionInventory: observed.extension };
}

export function probeAgentKeychain(app, bootstrap = false, execute = run) {
  try {
    const text = execute(join(app, 'Contents/MacOS/provenance-app-host'), [bootstrap ? '--agent-bootstrap' : '--agent-preflight']);
    return typeof text === 'string' && text.length <= 1024 && canonical(JSON.parse(text)) === canonical({ status: 'READY' })
      ? ready() : agentOwnerAction('VAULT_KEYCHAIN_UNAVAILABLE');
  } catch (error) {
    try {
      const text = error.stdout;
      if (typeof text === 'string' && text.length <= 1024) {
        const report = JSON.parse(text);
        if (report.status === 'OWNER_ACTION_REQUIRED' && ['VAULT_KEYCHAIN_BOOTSTRAP_REQUIRED', 'VAULT_KEYCHAIN_UNAVAILABLE'].includes(report.reason)) {
          return agentOwnerAction(report.reason);
        }
      }
    } catch {}
    return agentOwnerAction('VAULT_KEYCHAIN_UNAVAILABLE');
  }
}

export async function preflightAgent(configPath, name, optIn, live = false, dependencies = {}) {
  // Test injection is in this non-shipping module; no environment variable or
  // packaged runtime switch can replace a platform, signing or login check.
  const deps = { signingInputs: developmentSigningInputs, signing: preflightSigning, build: inspectAgentBuild,
    keychain: probeAgentKeychain, chrome: checkPlatform, processes: runningChromeProcesses,
    extension: agentExtensionReady, login: probeAgentLogin,
    ipc: probeAgentIPC,
    permissions: agentPermissions,
    consoleUID: async () => (await lstat('/dev/console')).uid, ...dependencies };
  try {
    if (optIn !== AGENT_OPT_IN) return agentOwnerAction('AGENT_OPT_IN_REQUIRED');
    let config;
    try { config = validateDevelopmentConfig(await privateJSON(configPath)); }
    catch { return agentOwnerAction('AGENT_CONFIG_INVALID'); }
    if (!config.agent) return agentOwnerAction('AGENT_CONFIG_REQUIRED');
    const paths = await validateAgent(config.agent, optIn, deps.info);
    if (await exists(join(paths.control, 'runtime.json')) || await exists(join(paths.control, 'launch.json'))
        || await exists(join(paths.control, 'registration.json'))) return agentOwnerAction('STOP_PREVIOUS_AGENT_SESSION');
    await validateAgentState(paths);
    if (await deps.consoleUID() !== config.agent.account.uid) return agentOwnerAction('GUI_SESSION_REQUIRED');
    if (!await deps.ipc(paths)) return agentOwnerAction('LOCAL_IPC_PERMISSION_REQUIRED');
    if (config.agent.automation === 'computer-use') {
      const permission = await deps.permissions(paths);
      if (permission !== 'READY') return agentOwnerAction(permission);
    }
    try {
      const inputs = await deps.signingInputs(configPath);
      if (canonical(inputs.config) !== canonical(config)) return agentOwnerAction('SIGNING_INPUTS_INVALID');
    } catch { return agentOwnerAction('SIGNING_INPUTS_INVALID'); }
    const signing = await deps.signing(config);
    if (signing.status !== 'READY') return agentOwnerAction(signing.reason);
    let build;
    try { build = await deps.build(config, paths, name); }
    catch { return agentOwnerAction('AGENT_BUILD_INVALID'); }
    const keychain = await deps.keychain(build.app);
    if (keychain.status !== 'READY') return keychain;
    if (live) {
      let chrome;
      try { chrome = await deps.chrome(paths.chromeApplication, paths); }
      catch { return agentOwnerAction('CHROME_SETUP_REQUIRED'); }
      if (deps.processes().length) return agentOwnerAction('CLOSE_OTHER_CHROME_COPY');
      const stage = join(paths.extension, name);
      try {
        await ownerDirectory(stage);
        if (canonical(await fileInventory(stage)) !== canonical(build.extensionInventory)
            || !await deps.extension(paths, stage)) return agentOwnerAction('EXTENSION_SETUP_REQUIRED');
      } catch { return agentOwnerAction('EXTENSION_SETUP_REQUIRED'); }
      const chromeDigest = sha256(await readFile(chrome.infoPlist));
      try {
        const receipt = await privateJSON(join(paths.control, `browser-${name}.json`));
        if (canonical(receipt) !== canonical({ profile: AGENT_PROFILE, buildDigest: build.digest, chromeDigest, automation: 'CDP' })) {
          return agentOwnerAction('BROWSER_BOOTSTRAP_REQUIRED');
        }
      } catch { return agentOwnerAction('BROWSER_BOOTSTRAP_REQUIRED'); }
      if (!await deps.login(chrome, paths)) return agentOwnerAction('PROVIDER_LOGIN_REQUIRED');
    }
    return { ...ready(), automation: config.agent.automation, providerSend: live };
  } catch (error) { return agentOwnerAction(error.message); }
}

async function bootstrapAgent(config, paths, name, live) {
  const build = await inspectAgentBuild(config, paths, name);
  if (await exists(join(paths.control, 'runtime.json')) || await exists(join(paths.control, 'launch.json'))) {
    return agentOwnerAction('STOP_PREVIOUS_AGENT_SESSION');
  }
  await validateAgentState(paths);
  const keychain = probeAgentKeychain(build.app, true);
  if (keychain.status !== 'READY' || !live) return keychain;
  const chrome = await checkPlatform(paths.chromeApplication, paths);
  if (runningChromeProcesses().length) return agentOwnerAction('CLOSE_OTHER_CHROME_COPY');
  const stage = join(paths.extension, name);
  if (canonical(await fileInventory(stage)) !== canonical(build.extensionInventory)
      || !await agentExtensionReady(paths, stage)) return agentOwnerAction('EXTENSION_SETUP_REQUIRED');
  if (!await probeAgentLogin(chrome, paths)) return agentOwnerAction('PROVIDER_LOGIN_REQUIRED');
  await writeNewJSON(join(paths.control, `browser-${name}.json`), { profile: AGENT_PROFILE,
    buildDigest: build.digest, chromeDigest: sha256(await readFile(chrome.infoPlist)), automation: 'CDP' });
  return ready();
}

async function startAgent(configPath, config, paths, name, live) {
  const report = await boundedAgentPreflight(configPath, name, AGENT_OPT_IN, live);
  if (report.status !== 'READY') return report;
  const { app } = await inspectAgentBuild(config, paths, name);
  await validateAgent(config.agent, AGENT_OPT_IN);
  if (live) await registerNativeHost(paths, join(app, 'Contents/MacOS/provenance-browser-host'));
  await writeNewJSON(join(paths.control, 'launch.json'), { profile: AGENT_PROFILE, build: name,
    mode: live ? 'live-provider-send' : 'offline', createdAt: Date.now() });
  const child = spawn(join(app, 'Contents/MacOS/provenance-app-host'), ['--agent-session'], {
    env: { PATH: '/usr/bin:/bin' }, detached: true, stdio: 'ignore',
  });
  let exited = false;
  child.once('error', () => { exited = true; }); child.once('exit', () => { exited = true; }); child.unref();
  for (let attempt = 0; attempt < 150 && !exited; attempt++) {
    if (await exists(join(paths.control, 'runtime.json'))) return { ...report, started: true };
    await delay(100);
  }
  // No orphaned startup can request interaction later; control state is kept
  // for the existing ownership-checked stop/reconciliation path.
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await delay(1000);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  return agentOwnerAction('AGENT_START_NOT_CONFIRMED');
}

export async function agentCommand(args) {
  const [action, configPath, ...rest] = args;
  const optIn = rest.includes(AGENT_OPT_IN) ? AGENT_OPT_IN : null;
  if (!optIn) return agentOwnerAction('AGENT_OPT_IN_REQUIRED');
  const live = rest.includes('--live-provider-send');
  const positional = rest.filter(value => !value.startsWith('--'));
  if (new Set(rest).size !== rest.length || rest.some(value => value.startsWith('--')
      && ![AGENT_OPT_IN, '--live-provider-send', '--owner-bootstrap'].includes(value))
      || !['init', 'prepare', 'bootstrap', 'preflight', 'start', 'stop'].includes(action)
      || positional.length !== (['init', 'stop'].includes(action) ? 0 : 1)
      || rest.includes('--owner-bootstrap') !== (action === 'bootstrap')
      || live && ['init', 'prepare', 'stop'].includes(action)) return agentOwnerAction('AGENT_COMMAND_INVALID');
  try {
    if (action === 'preflight') return boundedAgentPreflight(configPath, positional[0], optIn, live);
    const config = validateDevelopmentConfig(await privateJSON(configPath));
    if (!config.agent) return agentOwnerAction('AGENT_CONFIG_REQUIRED');
    agentAccount(config.agent, optIn);
    if (action === 'init') return initializeAgent(config.agent, optIn);
    const paths = await validateAgent(config.agent, optIn), name = positional[0];
    if (action === 'prepare') {
      const result = await prepareDevelopment(configPath, agentBuildPath(paths, name), { agentOptIn: optIn });
      return result.status === 'OWNER_ACTION_REQUIRED' ? agentOwnerAction(result.reason) : result;
    }
    if (action === 'bootstrap') return bootstrapAgent(config, paths, name, live);
    if (action === 'start') return startAgent(configPath, config, paths, name, live);
    const { stopDevelopment } = await import('./cli.mjs');
    return stopDevelopment(paths, { agent: true });
  } catch (error) {
    if (/^PRIVATE_PREPARE_(?:SIGNING|CODESIGN|PARTITION)/.test(error.message)) return agentOwnerAction('SIGNING_AUTHORIZATION_REQUIRED');
    if (error.message.startsWith('PRIVATE_PREPARE_') && reasons.has(error.message.slice('PRIVATE_PREPARE_'.length))) {
      return agentOwnerAction(error.message.slice('PRIVATE_PREPARE_'.length));
    }
    return agentOwnerAction(error.message);
  }
}
