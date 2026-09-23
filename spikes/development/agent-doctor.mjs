import { join } from 'node:path';
import { privateJSON } from './environment.mjs';
import { AGENT_PROFILE } from './agent-environment.mjs';
import { agentControl } from './agent-control.mjs';
import { connectAgentCDP, validateAgentCDP } from './agent-cdp.mjs';

export async function agentDoctor(paths, live, { preflight, start, stop, control = agentControl,
  connect = connectAgentCDP } = {}) {
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
        cdp = await connect(validateAgentCDP(await privateJSON(join(paths.control, 'cdp.json'))));
        await cdp.call('Browser.getVersion');
        const { targetId } = await cdp.call('Target.createTarget', { url: 'https://chatgpt.com/' });
        await control(paths, 'wait', ['paired', '15000']);
        await cdp.call('Target.closeTarget', { targetId });
        cdp.close(); cdp = null;
        checks.push('EXACT_CHROME_CDP_NATIVE_PAIRING');
      }
      await stop(); checks.push('RUNTIME_STOP');
    }
    return { ...report, checks, budgets, runtime: 'STOPPED', evidence: 'RETAINED' };
  } catch {
    return failure(live ? 'AGENT_BROWSER_READINESS_REQUIRED' : 'AGENT_RUNTIME_READINESS_REQUIRED');
  } finally { cdp?.close(); }
}
