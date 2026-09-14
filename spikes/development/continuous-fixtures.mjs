import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { continuousFixture, until } from '../../test/continuous-fixture.mjs';
import { verifyPortable } from '../recipient/portable.mjs';

const prompt = 'SYNTHETIC_CONTINUOUS_e\u0301\r\n☕  ';
const check = condition => { if (!condition) throw Object.assign(Error('SCENARIO_ASSERTION_FAILED'), { code: 'SCENARIO_ASSERTION_FAILED' }); };

export async function continuousProductFixture(directory, scenario, diagnostics, network) {
  const f = await continuousFixture(directory, { diagnostics, network, dropAck: scenario === 'continuous-normal-send' });
  let observed, operationId = null;
  try {
    await f.mode('Continuous');
    if (scenario === 'continuous-normal-send') {
      const page = f.pages.get(17);
      page.text = prompt; f.appear(prompt, 17, 'hydrated');
      f.send(prompt, { method: 'enter', isComposing: true });
      f.send(prompt, { method: 'enter', shiftKey: true });
      check(f.deliveries.length === 0);
      f.send(prompt, { method: 'enter' });
      await until(() => page.feedback === 'Attestamp · Prompt saved');
      check(f.deliveries.length === 2 && f.deliveries[0].observation.eventId === f.deliveries[1].observation.eventId);
      operationId = f.deliveries[0].observation.eventId;
      f.appear(prompt); await until(() => f.results.some(value => value.result.kind === 'message-observed'));
      f.send(prompt); await until(() => f.runtime.session.receipts.list().length === 2);
      await f.mode('Continuous', 18); f.send('SYNTHETIC_OTHER_TAB', { id: 18 });
      await until(() => f.runtime.session.receipts.list().length === 3);
      f.navigate(); await until(() => !f.runtime.adapter.scopes().some(value => value.scope === f.scopes.get(17)));
      const before = f.results.length; f.replay(f.deliveries[0]);
      await until(() => f.results.length > before);
      check(f.results.at(-1).result.state === 'RECORDING_UNAVAILABLE');
      await f.runtime.engine.drain();
      const receipts = f.runtime.session.receipts.list(), selection = f.runtime.session.receipts.prepare({ ids: [receipts[0].id] });
      check(selection.texts[0].preview === prompt);
      const report = verifyPortable(f.runtime.session.receipts.export(selection.previewId));
      const target = report.records.find(value => value.recordDigest === receipts[0].recordDigest);
      check(target.releaseControl === 'OBSERVED_ONLY' && target.localAssertions.some(value => value.kind === 'normal-message-observed'));
      check(f.anchorCalls === 3 && f.confirmed === 3);
      observed = 'NORMAL_PROMPT_SAVED';
    } else {
      if (scenario === 'continuous-storage-gap') f.storageFault();
      else if (scenario === 'continuous-key-gap') f.keyFault();
      else if (scenario === 'continuous-connection-gap') f.disconnect();
      else check(false);
      f.send(prompt);
      await until(() => /gap|unavailable/.test(f.pages.get(17).feedback));
      if (scenario === 'continuous-connection-gap') {
        await until(() => !f.runtime.browserState()); observed = 'BRIDGE_DISCONNECTED';
      } else {
        await until(() => f.results.length > 0);
        operationId = f.deliveries[0].observation.eventId; observed = 'CAPTURE_GAP';
      }
      check(f.runtime.session.receipts.list().length === 0 && f.anchorCalls === 0 && f.confirmed === 0);
      check(!f.results.some(value => value.result.state === 'PROMPT_SAVED'));
    }
    check(f.releases.length === 0 && f.prevention === 0);
    for (const page of f.pages.values()) check(page.clicks() === 0 && page.injections() === 0);
    check(Object.keys(f.runtime.session.runtime.snapshot().attempts).length === 0);
    const report = JSON.stringify(diagnostics.preview().report);
    for (const value of [prompt, 'conversation:fixture-', f.runtime.runtimeEpoch, ...f.scopes.values()]) check(!report.includes(value));
    const encrypted = async path => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await encrypted(file);
        else if (entry.isFile()) check(!(await readFile(file)).includes(Buffer.from(prompt)));
      }
    };
    await encrypted(join(directory, 'engine'));
    return { scenario, status: 'PASS', observed,
      operationId: operationId ? diagnostics.id('operationId', operationId) : null,
      epochId: diagnostics.id('epochId', f.runtime.runtimeEpoch), providerAttempts: 0,
      sponsorBroadcasts: f.anchorCalls, evidence: 'ENCRYPTED_TEMPORARY_VAULT', providerReceipt: 'UNKNOWN' };
  } finally { await f.close(); }
}
