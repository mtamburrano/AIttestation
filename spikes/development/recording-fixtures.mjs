import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { recordingFixture, until } from '../../test/recording-fixture.mjs';
import { verifyPortable } from '../recipient/portable.mjs';

const prompt = 'SYNTHETIC_RECORDING_e\u0301\r\n☕  ';
const check = condition => { if (!condition) throw Object.assign(Error('SCENARIO_ASSERTION_FAILED'), { code: 'SCENARIO_ASSERTION_FAILED' }); };

export async function recordingProductFixture(directory, scenario, diagnostics, network) {
  const f = await recordingFixture(directory, { diagnostics, network, dropAck: scenario === 'recording-normal-send',
    fetchResponse: async (_url, init) => new Response('data: ' + JSON.stringify({ type: 'stream_handoff',
      conversation_id: JSON.parse(init.body).conversation_id, turn_exchange_id: 'synthetic-turn' }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } }) });
  let observed, operationId = null;
  try {
    await f.recording(true);
    if (scenario === 'recording-normal-send') {
      const page = f.pages.get(17);
      page.text = prompt; f.appear(prompt, 17, 'hydrated');
      f.send(prompt, { method: 'enter', isComposing: true, request: false });
      f.send(prompt, { method: 'enter', shiftKey: true, request: false });
      check(f.deliveries.length === 0);
      f.send(prompt, { method: 'enter' });
      await until(() => page.feedback === 'Attestamp · Prompt saved');
      const requests = f.deliveries.filter(value => value.observation.kind === 'request-observed');
      check(requests.length === 1);
      operationId = f.deliveries[0].observation.eventId;
      f.appear(prompt); await until(() => f.results.some(value => value.result.kind === 'acknowledgement'));
      f.send(prompt); await until(() => f.runtime.session.receipts.list().length === 2);
      f.send('SYNTHETIC_OTHER_TAB', { id: 18 });
      await until(() => f.runtime.session.receipts.list().length === 3);
      f.navigate(); await until(() => !f.runtime.adapter.scopes().some(value => value.scope === f.scopes.get(17)));
      const replayId = f.replay(f.deliveries[0]);
      await until(() => f.results.some(value => value.requestId === replayId));
      check(f.results.find(value => value.requestId === replayId).result.state === 'CAPTURE_REJECTED');
      await f.runtime.engine.drain();
      const receipts = f.runtime.session.receipts.list(), selection = f.runtime.session.receipts.prepare({ ids: [receipts[0].id] });
      check(selection.texts[0].preview === prompt);
      const report = verifyPortable(f.runtime.session.receipts.export(selection.previewId));
      const target = report.records.find(value => value.recordDigest === receipts[0].recordDigest);
      check(target.releaseControl === 'OBSERVED_ONLY' && target.localAssertions.some(value => value.kind === 'normal-acknowledgement'));
      check(f.anchorCalls === 3 && f.confirmed === 3);
      observed = 'NORMAL_PROMPT_SAVED';
    } else {
      if (scenario === 'recording-storage-gap') f.storageFault();
      else if (scenario === 'recording-key-gap') f.keyFault();
      else if (scenario === 'recording-connection-gap') f.disconnect();
      else check(false);
      f.send(prompt);
      if (scenario === 'recording-connection-gap') {
        await until(() => /unavailable/.test(f.pages.get(17).feedback));
        await until(() => !f.runtime.browserState()); observed = 'BRIDGE_DISCONNECTED';
      } else {
        await until(() => /confirmation pending/.test(f.pages.get(17).feedback));
        await until(() => f.results.length > 0);
        check(f.results[0].result.state === 'SAVE_PENDING' && f.deliveries.length === 1);
        operationId = f.deliveries[0].observation.eventId; observed = 'SAVE_PENDING';
      }
      check(f.runtime.session.receipts.list().length === 0 && f.anchorCalls === 0 && f.confirmed === 0);
      check(!f.results.some(value => value.result.state === 'PROMPT_SAVED'));
    }
    check(f.releases.length === 0 && f.prevention === 0);
    for (const page of f.pages.values()) check(page.clicks() === 0 && page.injections() === 0);
    check(f.runtime.session.runtime === undefined);
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
