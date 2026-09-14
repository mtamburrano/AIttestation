import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { continuousFixture, until } from './continuous-fixture.mjs';
import { InstallationLifecycle } from '../spikes/distribution/lifecycle.mjs';
import { privateInstallation } from '../spikes/development/integration.mjs';
import { promptHistory, integrationStatus } from '../spikes/browser/chatgpt/dashboard.mjs';
import { startDesktopChannel } from '../spikes/browser/chatgpt/desktop-channel.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { inspectRecovery } from '../spikes/vault/vault.mjs';
import { runNativeHost } from '../spikes/browser/chatgpt/native-host.mjs';
import { CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp('/private/tmp/attestamp-dashboard-test-');
  let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  const installation = await new InstallationLifecycle({ supportDirectory: join(root, 'installation'),
    chromeSupportDirectory: join(root, 'chrome'), browserHost: join(root, 'synthetic-browser-host'), sequence: 1 }).init();
  await installation.enable();
  f = await continuousFixture(root, { defaultMode: 'Continuous', installation, ...options });
  const api = async (path, body = {}) => {
    const url = new URL(f.runtime.dashboardURL);
    const response = await fetch(new URL(path, url), { method: 'POST',
      headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  return { root, f, installation, api };
}

test('dashboard close/reopen, pause and account loss retain prompt counts, selective export and recovery', async t => {
  let connected = true;
  const { f, api } = await fixture(t, { managed: {
    status: () => ({ state: connected ? 'ACTIVE' : 'ACCOUNT_REQUIRED' }),
    disconnect: () => { connected = false; return { state: 'ACCOUNT_REQUIRED' }; },
    submit: async () => { if (!connected) throw Object.assign(Error('ACCOUNT_REQUIRED'), { code: 'ACCOUNT_REQUIRED' });
      return { transactionId: 'A'.repeat(52) }; },
  } });
  await f.mode('Continuous'); f.send('DASHBOARD_PRIVATE_CANARY');
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  let state = await api('/dashboard/state');
  assert.equal(state.integration.healthy, true); assert.equal(state.integration.connected, true);
  assert.equal(state.history.counts.prompts, 1); assert.equal(state.history.counts.conversations, 1);
  assert.ok(f.runtime.session.vault.inspect().records.length > 1);
  assert.equal(state.history.prompts[0].anchor, 'SOURCE_CORROBORATED');
  assert.doesNotMatch(JSON.stringify(state), /DASHBOARD_PRIVATE_CANARY|recordDigest|objectDigest/);
  const before = state.history;
  assert.equal((await api('/close')).engine, 'RUNNING');
  await f.command('SET_PAUSE', { paused: true });
  state = await api('/dashboard/state'); assert.equal(state.integration.code, 'PAUSED');
  assert.equal(state.integration.healthy, false); assert.ok(state.scopes.every(scope => scope.effectiveMode === 'Off'));
  // Disconnected sponsorship is a fixture object; this cannot contact a service.
  await api('/managed/disconnect');
  assert.deepEqual((await api('/dashboard/state')).history, before);
  const preview = await api('/receipts/preview', { ids: [state.history.prompts[0].receiptId] });
  const exported = await api('/receipts/export', { previewId: preview.previewId });
  assert.ok(verifyPortable(Buffer.from(exported.content)).records.every(value => value.integrity === 'VALID'));
  const recovery = await api('/dashboard/recovery', { confirmed: true });
  const recovered = inspectRecovery(Buffer.from(recovery.package), Buffer.from(recovery.recoveryKey, 'base64'));
  assert.equal(recovered.records.length, f.runtime.session.vault.inspect().records.length);
  await f.command('SET_PAUSE', { paused: false });
  await f.mode('Continuous'); f.send('DASHBOARD_PRIVATE_CANARY');
  await until(() => f.runtime.session.receipts.list().length === 2); await f.runtime.engine.drain();
  assert.equal((await api('/dashboard/state')).history.counts.prompts, 2, 'two equal sends are two prompts');
});

test('reversible integration changes invalidate scopes and preserve preferences, keys and unrelated configuration', async t => {
  const { root, f, api, installation } = await fixture(t);
  const unrelated = join(root, 'chrome/unrelated-settings.json'); await writeFile(unrelated, 'UNRELATED_SETTINGS');
  await f.mode('Continuous'); f.send('RETAINED_AFTER_REMOVAL');
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  const history = (await api('/dashboard/state')).history;
  const preferences = f.runtime.engine.state().preferences;
  await api('/installation/disable');
  assert.equal((await installation.status()).integration, 'DISABLED');
  assert.deepEqual(f.runtime.engine.state().scopes, []);
  assert.equal(f.runtime.browserState(), null);
  await api('/installation/enable');
  assert.equal((await installation.status()).integration, 'ENABLED');
  assert.equal((await api('/dashboard/state')).integration.code, 'DISCONNECTED');
  assert.deepEqual(f.runtime.engine.state().preferences, preferences);
  assert.deepEqual((await api('/dashboard/state')).history, history);
  await api('/installation/export-opportunity');
  assert.deepEqual(await api('/installation/remove', { exportDecision: 'keep-local' }),
    { integration: 'DISABLED', evidence: 'RETAINED', keys: 'RETAINED' });
  await api('/installation/enable');
  assert.equal((await readFile(unrelated, 'utf8')), 'UNRELATED_SETTINGS');
  const changed = { arbitrary: 'USER_OWNED_CONFIG' }; await writeFile(installation.manifestPath, JSON.stringify(changed), { mode: 0o600 });
  await assert.rejects(installation.enable(), /INTEGRATION_CONFLICT/);
  await assert.rejects(installation.disable(), /INTEGRATION_CONFLICT/);
  assert.deepEqual(JSON.parse(await readFile(installation.manifestPath)), changed);
  await f.restart();
  assert.equal((await api('/dashboard/state')).history.counts.prompts, 1);
  assert.equal((await api('/dashboard/state')).integration.code, 'CONFIGURATION_CONFLICT');
});

test('prompt summaries preserve cancellation and uncertainty without counting internal or derivative records', () => {
  const receipts = [{ id: 'one', prompt: { mode: 'Sealed', cancelled: true, savedAt: '2026-09-15', anchor: 'PENDING' } },
    { id: 'two', prompt: { mode: 'Sealed', outcome: 'OUTCOME_UNKNOWN', cancelled: true, anchor: 'SOURCE_CORROBORATED' } },
    { id: 'derivative', derivative: true, title: 'Derivative' }, { id: 'cancel', title: 'Unassociated cancellation' }];
  const result = promptHistory(receipts, []);
  assert.equal(result.counts.prompts, 2); assert.equal(result.counts.conversations, 0);
  assert.equal(result.counts.unassigned, 2); assert.equal(result.counts.needsAttention, 1);
  assert.deepEqual(result.prompts.map(value => value.state), ['OUTCOME_UNKNOWN', 'CANCELLED']);
  assert.equal(result.otherReceipts.length, 2);
  const state = { available: true, scopes: [{ effectiveMode: 'Sealed' }], preferences: { paused: false }, capabilities: { privilegedPanel: false } };
  assert.equal(integrationStatus(state, { integration: 'ENABLED' }, true).healthy, false);
  assert.equal(integrationStatus({ ...state, scopes: [] }, { integration: 'ENABLED' }, true).code, 'SELECT_CONVERSATION');
});

test('disabling during confirmation ends future release without deleting the pending prompt', async t => {
  let complete;
  const confirmation = new Promise(resolve => { complete = resolve; });
  t.after(() => complete({ synthetic: true }));
  const { f, api } = await fixture(t, { defaultMode: 'Sealed', collectFast: () => confirmation });
  await f.command('PROTECT_AND_SEND', { scope: f.scopes.get(17), operationId: crypto.randomUUID(),
    text: 'PENDING_SYNTHETIC_PROMPT', editRevision: 1 });
  await until(() => f.confirmed === 1);
  await api('/installation/disable'); complete({ synthetic: true }); await f.runtime.engine.drain();
  assert.equal(f.releases.length, 0);
  const state = await api('/dashboard/state');
  assert.equal(state.history.counts.prompts, 1); assert.equal(state.history.prompts[0].state, 'CANCELLED');
  assert.equal(state.history.prompts[0].localSave, 'SAVED');
});

test('resident pipe sends content-free authoritative status and rejects stale controls', async t => {
  const { f } = await fixture(t), input = new PassThrough(), output = new PassThrough(), events = [];
  let bytes = Buffer.alloc(0), exited = false;
  output.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4 && bytes.length >= bytes.readUInt32BE() + 4) {
      const length = bytes.readUInt32BE(); events.push(JSON.parse(bytes.subarray(4, length + 4))); bytes = bytes.subarray(length + 4);
    }
  });
  const channel = startDesktopChannel(f.runtime, { input, output, onExit: async () => { exited = true; } });
  t.after(() => channel.close());
  const send = value => { const body = Buffer.from(JSON.stringify({ profile: 'pap-desktop-command/1', ...value }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); input.write(Buffer.concat([prefix, body])); };
  await until(() => events.length); const initial = events.at(-1);
  assert.equal(initial.code, 'SCOPES_READY');
  assert.doesNotMatch(JSON.stringify(initial), /fixture-17|"scope":|url|token|text|digest/i);
  send({ kind: 'PAUSE', runtimeEpoch: initial.runtimeEpoch, revision: initial.revision, paused: true });
  await until(() => events.at(-1).paused); assert.equal(events.at(-1).code, 'PAUSED');
  send({ kind: 'PAUSE', runtimeEpoch: initial.runtimeEpoch, revision: initial.revision, paused: false });
  await until(() => events.at(-1).code === 'ACTION_FAILED'); assert.equal(f.runtime.engine.state().preferences.paused, true);
  send({ kind: 'OPEN', section: 'https://untrusted.invalid/secret' });
  await until(() => events.length >= 4); assert.equal(exited, false);
  input.end(); await until(() => exited);
});

test('private installation uses its consent journal and removes only owned configuration', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-private-integration-test-'); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { chrome: join(root, 'chrome'), control: join(root, 'control') };
  for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
  const installation = privateInstallation(paths, join(root, 'synthetic-host'));
  assert.equal((await installation.status()).integration, 'DISABLED');
  await installation.enable(); await installation.enable(); assert.equal((await installation.status()).integration, 'ENABLED');
  await installation.disable(); await installation.enable();
  const manifest = join(paths.chrome, 'NativeMessagingHosts/ai.provenance.consumer.json');
  await writeFile(manifest, JSON.stringify({ changed: 'UNRELATED' }), { mode: 0o600 });
  await assert.rejects(installation.disable(), /NATIVE_REGISTRATION_CHANGED/);
  assert.deepEqual(JSON.parse(await readFile(manifest)), { changed: 'UNRELATED' });
});

test('a delayed enable cannot restore bridge authority after a later disable', async t => {
  const { f, api, installation } = await fixture(t);
  await api('/installation/disable');
  let resume, installed = false;
  const held = new Promise(resolve => { resume = resolve; }); t.after(() => resume());
  const enable = installation.enable.bind(installation);
  installation.enable = async () => { const value = await enable(); installed = true; await held; return value; };
  const enabling = api('/installation/enable'); await until(() => installed);
  const disabling = api('/installation/disable');
  resume(); await Promise.all([enabling, disabling]);
  assert.equal((await installation.status()).integration, 'DISABLED');
  const input = new PassThrough(), output = new PassThrough(); let socket;
  try {
    await assert.rejects(async () => { socket = await runNativeHost({
      extensionOrigin: `chrome-extension://${CHATGPT_EXTENSION_ID}/`, rendezvousPath: f.runtime.rendezvousPath,
      input, output, onClose: () => {},
    }); });
  } finally { socket?.destroy(); input.destroy(); output.destroy(); }
  assert.equal(f.runtime.browserState(), null); assert.deepEqual(f.runtime.engine.state().scopes, []);
});

test('launch stays quiet and simultaneous free-verifier requests share one server', async t => {
  const opened = [], { f } = await fixture(t, { openDashboard: async url => { opened.push(url); } });
  assert.deepEqual(opened, [], 'startup must not open a composer or dashboard');
  await Promise.all([f.runtime.openVerifier(), f.runtime.openVerifier()]);
  assert.equal(opened.length, 2); assert.equal(opened[0], opened[1]);
  const url = new URL(opened[0]);
  const response = await fetch(new URL('/close', url), { method: 'POST',
    headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` }, body: '{}' });
  assert.equal(response.status, 200); await until(async () => {
    try { await fetch(url); return false; } catch { return true; }
  });
  await f.runtime.openVerifier(); assert.notEqual(opened[2], opened[0]);
});
