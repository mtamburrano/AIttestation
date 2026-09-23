import { unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { MacOSKeychainStore } from '../vault/key-lifecycle.mjs';
import { startPackagedChatGPT } from '../browser/chatgpt/runtime-main.mjs';
import { AGENT_OPT_IN, validateAgent, validateAgentLaunch, validateAgentState } from './agent-environment.mjs';
import { DEVELOPMENT_PROFILE, privateJSON } from './environment.mjs';
import { checkPlatform, launchDevelopmentChrome } from './chrome.mjs';
import { agentInstallation } from './agent-policy.mjs';
import { OwnerDebugSession } from './debug-session.mjs';
import { publishRuntimeState } from './runtime-state.mjs';
import { restrictFixtureNetwork } from './fixture-network.mjs';
import { startupFailure } from './startup.mjs';
import { closeAgentBrowser } from './agent-process.mjs';

let runtime, debugSession, statePath, browserChild;
try {
  const config = await privateJSON(fileURLToPath(new URL('private-development.json', import.meta.url)));
  if (Object.keys(config).sort().join(',') !== 'agent,assurance,browserPolicy,build,profile,sponsorOrigin,updaterEnabled'
      || config.profile !== DEVELOPMENT_PROFILE || config.sponsorOrigin !== null || config.updaterEnabled !== false
      || config.assurance !== 'PRIVATE_TESTNET_ONLY' || config.browserPolicy !== 'EXPLICIT_TEST_USER_COPY') throw Error('INVALID_PRIVATE_BUILD');
  const paths = await validateAgent(config.agent, AGENT_OPT_IN);
  await validateAgentState(paths);
  const launchPath = join(paths.control, 'launch.json');
  const request = validateAgentLaunch(await privateJSON(launchPath), config.build);
  const live = request.mode === 'live-provider-send';
  const chrome = live ? await checkPlatform(paths.chromeApplication, paths) : null;
  const keyStore = new MacOSKeychainStore();
  if (!keyStore.get('agent:readiness')?.equals(Buffer.from('agent-readiness-v1'))) throw Error('AGENT_KEYCHAIN_NOT_READY');
  await unlink(launchPath);
  const installation = await agentInstallation(paths, join(dirname(process.execPath), 'provenance-browser-host'), live);
  // The browser has its own explicit live opt-in. The evidence engine remains
  // local in both modes; no managed client or remote confirmation fallback.
  const network = restrictFixtureNetwork(paths.root);
  debugSession = new OwnerDebugSession(paths.control);
  runtime = await startPackagedChatGPT({ supportDirectory: paths.support, keyStore, managed: null, installation,
    diagnostics: debugSession.diagnostics, debugSession,
    collectFast: async () => { throw Error('AGENT_SPONSOR_DISABLED'); },
    desktopChannel: process.argv.includes('--resident') ? { requestFD: 6, responseFD: 7 } : null,
    openDashboard: live ? url => launchDevelopmentChrome(chrome, paths, url)
      : async () => { throw Error('AGENT_LIVE_OPT_IN_REQUIRED'); } });
  network.allowRuntime(runtime);
  if (live) await launchDevelopmentChrome(chrome, paths, 'about:blank', {
    spawnProcess: (...args) => { browserChild = spawn(...args); return browserChild; },
  });
  statePath = await publishRuntimeState(paths.control, runtime);
  process.once('beforeExit', async () => {
    try { await closeAgentBrowser(browserChild); debugSession.close(); await unlink(statePath).catch(() => {}); }
    catch { process.stderr.write('AGENT_BROWSER_CLOSE_TIMED_OUT\n'); process.exitCode = 1; }
  });
  const stop = async () => {
    await runtime.close(); await closeAgentBrowser(browserChild); debugSession.close(); await unlink(statePath).catch(() => {}); process.exit(0);
  };
  const signalStop = () => stop().catch(() => {
    process.stderr.write('AGENT_STOP_FAILED\n'); process.exit(1);
  });
  process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop);
} catch (error) {
  await runtime?.close(); await closeAgentBrowser(browserChild).catch(() => {}); debugSession?.close();
  process.stderr.write(`${startupFailure(error)}\n`); process.exitCode = 1;
}
