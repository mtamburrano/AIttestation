import { sidePanelFixture } from '../../test/sidepanel-fixture.mjs';
import { until } from '../../test/continuous-fixture.mjs';
import { targetKey } from '../browser/chatgpt/extension/sidepanel-model.js';
import { verifyPortable } from '../recipient/portable.mjs';

const check = value => { if (!value) throw Object.assign(Error('SCENARIO_ASSERTION_FAILED'), { code: 'SCENARIO_ASSERTION_FAILED' }); };
export async function sidePanelProductFixture(directory, scenario, diagnostics, network) {
  let release;
  const confirmation = new Promise(resolve => { release = resolve; });
  const f = await sidePanelFixture(directory, { diagnostics, network, collectFast: () => confirmation });
  try {
    const { model } = await f.panel();
    const text = '\ufeffSYNTHETIC_PANEL_e\u0301\r\n☕';
    model.edit(text); await Promise.all([model.send(), model.send()]);
    await until(() => f.confirmed === 1);
    const id = model.draft.submission.id;
    check(f.pages.get(17).text === '' && f.releases.length === 0);
    model.edit('SYNTHETIC_LATER_DRAFT');
    if (scenario === 'panel-cancel') {
      await model.refresh(); await model.cancel(id);
    } else if (scenario === 'panel-destination-change') {
      f.navigate(17); await until(async () => { await model.refresh(); return !model.target; });
    } else {
      check(scenario === 'panel-protect-and-send');
      await model.select(targetKey(model.state.targets.find(value => value.tabId === 18)));
      check(model.draft.text === '');
    }
    release({ synthetic: true }); await f.runtime.engine.drain();
    const op = await f.settled(model, id);
    check(scenario === 'panel-protect-and-send' ? op.state === 'SUBMISSION_OBSERVED' : op.state === 'CANCELLED');
    check(f.releases.length === (scenario === 'panel-protect-and-send' ? 1 : 0));
    check(f.pages.get(18).text === '');
    if (f.releases.length) check(f.pages.get(17).text === text && f.pages.get(17).clicks() === 1);
    const receipt = f.runtime.session.receipts.list()[0];
    const preview = f.runtime.session.receipts.prepare({ ids: [receipt.id] });
    check(preview.texts[0].preview === text);
    if (op.state === 'CANCELLED') {
      const report = verifyPortable(f.runtime.session.receipts.export(preview.previewId));
      check(report.records.some(value => value.localAssertions.some(assertion => assertion.kind === 'release-cancelled')));
    }
    check(!JSON.stringify(diagnostics.preview().report).includes('fixture-17'));
    const versionId = f.runtime.engine.state().operations.find(value => value.id === id).versionId;
    return { scenario, status: 'PASS', observed: op.state === 'CANCELLED' ? 'OPERATION_CANCELLED' : op.state,
      operationId: diagnostics.id('operationId', versionId),
      epochId: diagnostics.id('epochId', f.runtime.runtimeEpoch), providerAttempts: f.releases.length,
      sponsorBroadcasts: f.anchorCalls, evidence: 'ENCRYPTED_TEMPORARY_VAULT', providerReceipt: 'UNKNOWN' };
  } finally { release({ synthetic: true }); await f.close(); }
}
