import { join } from 'node:path';
import { recordingFixture, until } from '../../test/recording-fixture.mjs';
import { InstallationLifecycle } from '../distribution/lifecycle.mjs';
import { verifyPortable } from '../recipient/portable.mjs';

const check = condition => { if (!condition) throw Object.assign(Error('SCENARIO_ASSERTION_FAILED'), { code: 'SCENARIO_ASSERTION_FAILED' }); };

export async function dashboardProductFixture(directory, scenario, diagnostics, network) {
  const installation = await new InstallationLifecycle({ supportDirectory: join(directory, 'installation'),
    chromeSupportDirectory: join(directory, 'chrome'), browserHost: join(directory, 'synthetic-host'), sequence: 1 }).init();
  await installation.enable();
  const f = await recordingFixture(directory, { diagnostics, network, installation });
  const api = async (path, data = {}) => {
    const url = new URL(f.runtime.dashboardURL);
    const response = await fetch(new URL(path, url), { method: 'POST',
      headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify(data) });
    check(response.ok); return response.json();
  };
  try {
    await f.recording(true); f.send('SYNTHETIC_DASHBOARD_PROMPT');
    await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
    let state = await api('/dashboard/state');
    check(state.history.counts.prompts === 1 && state.integration.healthy);
    const id = state.history.prompts[0].receiptId;
    check((await api('/close')).engine === 'RUNNING');
    await f.command('SET_RECORDING', { enabled: false });
    state = await api('/dashboard/state'); check(state.integration.code === 'OFF');
    await api('/installation/disable');
    check(f.runtime.engine.state().scopes.length === 0 && f.runtime.browserState() === null);
    await api('/installation/enable');
    await f.command('SET_RECORDING', { enabled: true });
    state = await api('/dashboard/state'); check(state.integration.code === 'DISCONNECTED');
    check(state.history.counts.prompts === 1);
    const preview = await api('/receipts/preview', { ids: [id] });
    const exported = await api('/receipts/export', { previewId: preview.previewId });
    check(verifyPortable(Buffer.from(exported.content)).records.every(record => record.integrity === 'VALID'));
    check(f.releases.length === 0);
    return { scenario, status: 'PASS', observed: 'NORMAL_PROMPT_SAVED',
      operationId: diagnostics.id('operationId', f.deliveries[0].observation.eventId),
      epochId: diagnostics.id('epochId', f.runtime.runtimeEpoch), providerAttempts: 0,
      sponsorBroadcasts: f.anchorCalls, evidence: 'ENCRYPTED_TEMPORARY_VAULT', providerReceipt: 'UNKNOWN' };
  } finally { await f.close(); }
}
