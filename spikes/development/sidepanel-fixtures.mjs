import { sidePanelFixture } from '../../test/sidepanel-fixture.mjs';
export async function sidePanelProductFixture(directory, scenario, diagnostics, network) {
  const f = await sidePanelFixture(directory, { diagnostics, network });
  try {
    const { model } = await f.panel(); await model.toggle();
    if (model.state?.recording !== true || model.state.readySources !== 2) throw Error('SCENARIO_ASSERTION_FAILED');
    await model.toggle();
    if (model.state?.recording !== false || f.runtime.session.receipts.list().length || f.releases.length) throw Error('SCENARIO_ASSERTION_FAILED');
    return { scenario, status: 'PASS', observed: 'RECORDING_DISABLED', operationId: null,
      epochId: diagnostics.id('epochId', f.runtime.runtimeEpoch), providerAttempts: 0,
      sponsorBroadcasts: 0, evidence: 'ENCRYPTED_TEMPORARY_VAULT', providerReceipt: 'UNKNOWN' };
  } finally { await f.close(); }
}
