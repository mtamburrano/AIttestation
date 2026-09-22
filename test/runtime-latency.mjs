import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Vault } from '../spikes/vault/vault.mjs';
import { MacOSKeychainStore } from '../spikes/vault/key-lifecycle.mjs';
import { ChatGPTRecordingSession } from '../spikes/browser/chatgpt/session.mjs';
import { CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { ManagedAnchoringClient } from '../spikes/managed/client.mjs';
import { managedError } from '../spikes/managed/protocol.mjs';
import { OwnerDebugSession } from '../spikes/development/debug-session.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { recordingFixture, until } from './recording-fixture.mjs';

// No installed resources or real credentials: this bounded report separates
// actual vault/debug CPU and I/O from a synthetic 40 ms native broker wait.
export async function measureRuntimeLatency({ check = false } = {}) {
  const root = await mkdtemp('/private/tmp/attestamp-runtime-latency-test-');
  let f, vault, seed, debug, network;
  const report = { profile: 'attestamp-runtime-latency/1', prompts: 48, retainedRecords: 320,
    sponsor: 'SYNTHETIC_OFF', nativeBrokerWaitMs: 40, measurements: [] };
  const measure = async (name, operation) => {
    const cpu = process.cpuUsage(), start = performance.now();
    const value = await operation(), durationMs = performance.now() - start, used = process.cpuUsage(cpu);
    report.measurements.push({ name, durationMs: Math.round(durationMs), cpuMs: Math.round((used.user + used.system) / 1000) });
    return value;
  };
  try {
    vault = new Vault(join(root, 'vault'), randomBytes(32), undefined, { create: true });
    seed = await new ChatGPTRecordingSession(root, {}, { vault, fastTrust: { profile: FAST_CONFIRM_PROFILE } }).init();
    for (let i = 0; i < report.prompts; i++) seed.observeNormal({ kind: 'request-observed', eventId: randomUUID(),
      inputMethod: 'provider-request', text: `SYNTHETIC_RETAINED_${i}`,
      request: { profile: 'chatgpt-new-user-text/3', path: '/backend-api/conversation', messageId: `retained-${i}`, conversationId: 'retained' },
      source: { adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT, scope: randomUUID(),
        runtimeEpoch: randomUUID(), browserSessionId: 'synthetic-browser', tabId: 17, windowId: 1,
        tabEpoch: 'synthetic-epoch', documentId: 'synthetic-document', destination: 'conversation:retained' } });
    for (let i = report.prompts * 2; i < report.retainedRecords; i++) vault.capture(Buffer.from(`SYNTHETIC_RETAINED_STATE_${i}`));
    seed.close();
    await measure('cold_receipts', () => seed.receipts.list());
    await measure('warm_receipts', () => seed.receipts.list());
    const receipt = seed.receipts.list()[0];
    await measure('selective_preview', () => seed.receipts.prepare({ ids: [receipt.id] }));
    let keyReads = 0, attempts = 0;
    const brokerReply = () => ({ status: 0, stdout: JSON.stringify({ profile: 'pap-keychain-response/1',
      status: 'OK', value: Buffer.from('a'.repeat(43)).toString('base64url') }) });
    const keyStore = new MacOSKeychainStore({ run: () => {
      keyReads++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, report.nativeBrokerWaitMs);
      return brokerReply();
    } });
    // The same broker delay with asynchronous I/O becomes available to the
    // managed client after its asynchronous custody API is implemented.
    if (typeof keyStore.getAsync === 'function') keyStore.getAsync = async () => {
      keyReads++; await delay(report.nativeBrokerWaitMs); return Buffer.from('a'.repeat(43));
    };
    const managed = new ManagedAnchoringClient({ origin: 'https://synthetic.invalid', keyStore,
      request: async () => { attempts++; await delay(1); throw managedError('SERVICE_UNAVAILABLE'); } });
    debug = new OwnerDebugSession(root);
    debug.setEnabled(true);
    const retainedDiagnostics = debug.diagnostics.scope({ epochId: 'synthetic-retained-debug' });
    for (let index = 0; index < 2048; index++) retainedDiagnostics.record('ENGINE_STARTED');
    report.retainedDebugEvents = debug.status().retainedEvents;
    network = restrictFixtureNetwork(root);
    f = await recordingFixture(root, { vault, managed, debugSession: debug, diagnostics: debug.diagnostics, network });
    const api = async (path, body = {}) => {
      const url = new URL(f.runtime.dashboardURL);
      const response = await fetch(new URL(path, url), { method: 'POST',
        headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify(body) });
      const value = await response.json(); assert.equal(response.status, 200); return value;
    };
    for (const enabled of [false, true]) {
      await api('/debug-session/recording', { enabled });
      const suffix = enabled ? 'debug_on' : 'debug_off';
      await measure(`debug_event_${suffix}`, () => debug.diagnostics.scope({ epochId: f.runtime.runtimeEpoch }).record('ENGINE_STARTED'));
      await measure(`engine_${suffix}`, () => api('/engine/state'));
      await measure(`dashboard_${suffix}`, () => api('/dashboard/state'));
      await measure(`receipts_${suffix}`, () => api('/receipts'));
      await measure(`parallel_reads_control_${suffix}`, () => Promise.all([
        api('/receipts'), api('/dashboard/state'), f.recording(false) ]));
      await measure(`recording_on_${suffix}`, () => f.recording(true));
      await measure(`capture_${suffix}`, async () => {
        f.send(`SYNTHETIC_CAPTURE_${suffix}`);
        await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
      });
      await measure(`recording_off_${suffix}`, () => f.recording(false));
      await measure(`debug_control_${suffix}`, () => api('/debug-session/recording', { enabled }));
    }
    report.keyReads = keyReads; report.sponsorAttempts = attempts;
    report.finalReceipts = f.runtime.session.receipts.list().length;
    assert.equal(report.finalReceipts, report.prompts + 2);
    assert.equal(f.pages.get(17).requests.length, 2); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
    assert.doesNotMatch(debug.export(), /SYNTHETIC_CAPTURE|SYNTHETIC_RETAINED|synthetic\.invalid/);
    if (check) for (const item of report.measurements) assert.ok(item.durationMs < 1500, `${item.name}: ${item.durationMs} ms`);
    return report;
  } finally { await f?.close(); network?.restore(); debug?.close(); seed?.close(); vault?.close(); await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(await measureRuntimeLatency({ check: process.argv.includes('--check') }), null, 2));
}
