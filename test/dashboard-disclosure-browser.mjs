import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { until } from './continuous-fixture.mjs';
import { unpack } from '../spikes/vault/format.mjs';

export async function disclosureRegressions({ call, evaluate, wait, click, root }) {
  const failures = [], exportPath = join(root, 'attestamp-evidence.json');
  const receipt = "document.querySelector('#prompts input')";
  const reload = async () => {
    await evaluate('globalThis.disclosureReloadPending = true');
    await call('Page.reload');
    await wait(`!globalThis.disclosureReloadPending && ${receipt} !== null && document.querySelector('#prompt-count')?.textContent === '1' && !document.querySelector('#preview-export').disabled`);
  };
  const reset = async () => {
    await reload();
    await evaluate(`${receipt}.click()`);
    await rm(exportPath, { force: true });
  };
  // Let the actual local API finish; hold only delivery to the real dashboard.
  const hold = path => evaluate(`(() => {
    const original = globalThis.fetch;
    const gate = globalThis.disclosureGate = { ready: false, exports: 0 };
    const released = new Promise(resolve => { gate.release = resolve; });
    globalThis.fetch = async (...args) => {
      if (args[0] === '/receipts/export') gate.exports++;
      const response = await original(...args);
      if (args[0] === ${JSON.stringify(path)} && !gate.ready) {
        gate.request = JSON.parse(args[1].body);
        gate.response = await response.clone().json();
        gate.ready = true;
        await released;
      }
      return response;
    };
  })()`);
  const release = async () => {
    await evaluate('disclosureGate.release()');
    await wait("!document.querySelector('#preview-export').disabled");
  };
  const invalid = async () => {
    assert.equal(await evaluate("document.querySelector('#save-export').disabled"), true, 'invalidated selection cannot be saved');
    assert.equal(await evaluate("document.querySelector('#preview').hidden"), true, 'stale preview stays hidden');
    assert.equal(await evaluate("document.querySelector('#preview-texts').textContent"), '', 'invalidated bytes are cleared');
    assert.equal(await evaluate("document.querySelector('#preview-summary').textContent"), '');
    assert.equal(await evaluate("document.querySelector('#preview-details').textContent"), '');
  };
  const run = async (name, scenario) => {
    try { await reset(); await scenario(); console.log(`PASS: ${name}`); }
    catch (error) { failures.push(new Error(name, { cause: error })); console.error(`FAIL: ${name}: ${error.message}`); }
  };
  for (const [name, change] of [
    ['evidence option changes during disclosure preview', "document.querySelector('#include-evidence').click()"],
    ['receipt deselected during disclosure preview', `${receipt}.click()`],
    ['evidence option changes and returns during disclosure preview', "document.querySelector('#include-evidence').click(); document.querySelector('#include-evidence').click()"],
    ['receipt deselected and reselected during disclosure preview', `${receipt}.click(); ${receipt}.click()`],
  ]) await run(name, async () => {
    await hold('/receipts/preview'); await click('preview-export'); await wait('disclosureGate.ready');
    assert.equal(await evaluate('disclosureGate.request.ids.length'), 1);
    assert.equal(await evaluate('disclosureGate.request.includeEvidence'), true);
    assert.match(await evaluate('disclosureGate.response.texts[0].preview'), /SYNTHETIC_DASHBOARD_CANARY/);
    await evaluate(change); await release(); await invalid();
    await click('refresh'); await wait("!document.querySelector('#preview-export').disabled"); await invalid();
    await click('save-export'); assert.equal(await evaluate('disclosureGate.exports'), 0);
  });
  for (const includeEvidence of [true, false]) await run(`unchanged disclosure selection exports with evidence=${includeEvidence}`, async () => {
    if (!includeEvidence) await click('include-evidence');
    await hold('/receipts/preview'); await click('preview-export'); await wait('disclosureGate.ready'); await release();
    assert.equal(await evaluate("document.querySelector('#save-export').disabled"), false);
    const preview = await evaluate("JSON.parse(document.querySelector('#preview-details').textContent)");
    assert.equal(preview.includeEvidence, includeEvidence);
    assert.deepEqual(preview.texts.map(value => value.receiptId), [await evaluate(`${receipt}.value`)]);
    const summary = `1 selected receipts. ${preview.evidenceObjects} evidence objects; ${preview.publicProofObjects} portable proof objects. ${preview.exportBytes} bytes. Signed metadata and links are included.`;
    assert.equal(await evaluate("document.querySelector('#preview-summary').textContent"), summary);
    await click('refresh'); await wait("!document.querySelector('#preview-export').disabled");
    assert.equal(await evaluate("document.querySelector('#save-export').disabled"), false);
    assert.equal(await evaluate("document.querySelector('#preview-summary').textContent"), summary);
    assert.equal(await evaluate("JSON.parse(document.querySelector('#preview-details').textContent).previewId"), preview.previewId);
    await click('save-export');
    let content;
    await until(async () => { try { content = await readFile(exportPath, 'utf8'); return Buffer.byteLength(content) === preview.exportBytes; } catch { return false; } });
    const bundle = JSON.parse(content);
    assert.equal(bundle.disclosure.objects.length, preview.evidenceObjects);
    assert.deepEqual(bundle.disclosure.records.map(value => value.manifest.eventId), preview.records.map(value => value.id));
    assert.equal(bundle.disclosure.objects.some(value => unpack(value.bytes).includes('SYNTHETIC_DASHBOARD_CANARY')), includeEvidence);
    if (!includeEvidence) assert.equal(bundle.disclosure.objects.length, 0);
  });
  for (const [name, change] of [
    ['evidence option changes during export response', "document.querySelector('#include-evidence').click()"],
    ['receipt deselected during export response', `${receipt}.click()`],
  ]) await run(name, async () => {
    await click('preview-export'); await wait("!document.querySelector('#save-export').disabled");
    const previewId = await evaluate("JSON.parse(document.querySelector('#preview-details').textContent).previewId");
    await hold('/receipts/export'); await click('save-export'); await wait('disclosureGate.ready');
    assert.equal(await evaluate('disclosureGate.request.previewId'), previewId);
    // Observe download creation synchronously, without a filesystem timing race.
    await evaluate('globalThis.disclosureDownloads = 0; URL.createObjectURL = () => { disclosureDownloads++; return "blob:synthetic-disallowed-download"; }');
    await evaluate(change); await release(); await invalid();
    assert.equal(await evaluate('disclosureDownloads'), 0, 'changed consent suppresses the in-flight download');
    await click('refresh'); await wait("!document.querySelector('#preview-export').disabled"); await invalid();
  });
  await reload();
  await rm(exportPath, { force: true });
  if (failures.length) throw new AggregateError(failures, 'Disclosure selection regressions failed');
}
