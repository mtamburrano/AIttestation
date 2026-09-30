import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CHATGPT_EXTENSION_ID } from '../browser/chatgpt/adapter.mjs';
import { readReleaseFile } from '../distribution/release-inputs.mjs';
import { privateJSON } from './environment.mjs';
import { AGENT_PROFILE } from './agent-environment.mjs';
import { agentControl } from './agent-control.mjs';
import { connectAgentCDP, validateAgentCDP } from './agent-cdp.mjs';
import { waitForAgentBrowserCleanup } from './agent-process.mjs';

export async function refreshAgentExtension(paths, { connect = connectAgentCDP, wait = delay,
  now = Date.now } = {}) {
  const source = (await readReleaseFile(join(paths.extension, 'current/service-worker.js'),
    { limit: 512 * 1024 })).toString('utf8');
  const url = `chrome-extension://${CHATGPT_EXTENSION_ID}/service-worker.js`;
  let selectedSession, scriptId;
  const cdp = await connect(validateAgentCDP(await privateJSON(join(paths.control, 'cdp.json'))), {
    onEvent(event) {
      if (event.method === 'Debugger.scriptParsed' && event.sessionId === selectedSession
          && event.params?.url === url) scriptId = event.params.scriptId;
    },
  });
  const deadline = now() + 15000;
  async function worker(previous) {
    do {
      const { targetInfos } = await cdp.call('Target.getTargets');
      const matches = targetInfos.filter(target => target.type === 'service_worker' && target.url === url);
      if (matches.length === 1 && matches[0].targetId !== previous) return matches[0].targetId;
      await wait(100);
    } while (now() < deadline);
    throw Error('AGENT_EXTENSION_RELOAD_REQUIRED');
  }
  try {
    const previous = await worker();
    const original = await cdp.call('Target.attachToTarget', { targetId: previous, flatten: true });
    // An unpacked extension can retain compiled old bytes across browser restarts.
    // Reload only the private extension, then prove the executing staged source.
    await cdp.call('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }, original.sessionId).catch(() => {});
    const replacement = await worker(previous);
    const attached = await cdp.call('Target.attachToTarget', { targetId: replacement, flatten: true });
    selectedSession = attached.sessionId;
    await cdp.call('Debugger.enable', {}, selectedSession);
    while (!scriptId && now() < deadline) await wait(100);
    if (!scriptId) throw Error('AGENT_EXTENSION_SOURCE_UNAVAILABLE');
    const loaded = await cdp.call('Debugger.getScriptSource', { scriptId }, selectedSession);
    if (loaded.scriptSource !== source) throw Error('AGENT_EXTENSION_SOURCE_CHANGED');
    return { status: 'VERIFIED' };
  } finally { cdp.close(); }
}

export async function agentDoctor(paths, live, { preflight, start, stop, control = agentControl,
  connect = connectAgentCDP, refreshExtension = refreshAgentExtension } = {}) {
  const checks = [], budgets = { providerSends: 0, anchorTransactions: 0, sponsor: 'DISABLED' };
  const failure = reason => ({ profile: AGENT_PROFILE, status: 'OWNER_ACTION_REQUIRED', reason,
    checks, budgets, evidence: 'RETAINED' });
  const report = await preflight();
  if (report.status !== 'READY') return { ...report, checks, budgets, evidence: 'RETAINED' };
  checks.push('CONFIG_SIGNING_KEYCHAIN_SESSION');
  if (live) checks.push('EXTENSION_AND_LOGIN_PREFLIGHT');
  let cdp, epoch;
  try {
    // Exercise an actual drain and fresh runtime epoch. A READY filesystem
    // probe alone does not demonstrate that the installed engine can start.
    for (let iteration = 0; iteration < 2; iteration++) {
      const started = await start();
      if (started.status !== 'READY') return { ...started, checks, budgets, evidence: 'RETAINED' };
      await control(paths, 'assert', ['engine-ready']);
      const state = await control(paths, 'state');
      if (!state.runtimeEpoch || iteration && state.runtimeEpoch === epoch) throw Error('AGENT_RUNTIME_CHANGED');
      epoch = state.runtimeEpoch;
      checks.push(iteration ? 'RUNTIME_RESTART' : 'RUNTIME_START');
      if (live) {
        await refreshExtension(paths);
        checks.push('RELOADED_AND_VERIFIED_EXTENSION');
        cdp = await connect(validateAgentCDP(await privateJSON(join(paths.control, 'cdp.json'))));
        await cdp.call('Browser.getVersion');
        const { targetId } = await cdp.call('Target.createTarget', { url: 'https://chatgpt.com/' });
        await control(paths, 'wait', ['paired', '15000']);
        await cdp.call('Target.closeTarget', { targetId });
        // Chrome must flush its profile before the resident's bounded process
        // cleanup; SIGTERM alone can leave its singleton files behind.
        await cdp.call('Browser.close').catch(() => {});
        cdp.close(); cdp = null;
        await waitForAgentBrowserCleanup(paths);
        checks.push('EXACT_CHROME_CDP_NATIVE_PAIRING');
      }
      await stop(); checks.push('RUNTIME_STOP');
    }
    return { ...report, checks, budgets, runtime: 'STOPPED', evidence: 'RETAINED' };
  } catch {
    return failure(live ? 'AGENT_BROWSER_READINESS_REQUIRED' : 'AGENT_RUNTIME_READINESS_REQUIRED');
  } finally { cdp?.close(); }
}
