import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Vault } from '../spikes/vault/vault.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { ManagedAnchoringClient } from '../spikes/managed/client.mjs';
import { ManagedSponsorship } from '../spikes/managed/service.mjs';
import { FEE_MICROALGOS, MANAGED_NETWORK } from '../spikes/managed/protocol.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { ChatGPTRecordingSession } from '../spikes/browser/chatgpt/session.mjs';
import { ResidentEngine } from '../spikes/browser/chatgpt/engine.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID, CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';

test('resumed batches reconcile lost replies through the unchanged durable sponsor reservation', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-anchor-recovery-test-');
  let session, engine, service;
  const vault = new Vault(join(root, 'vault'), randomBytes(32), undefined, { create: true });
  t.after(async () => { engine?.stop(); await engine?.drain(); session?.close(); service?.close(); vault.close(); await rm(root, { recursive: true, force: true }); });
  let time = Date.UTC(2026, 8, 21), submissions = 0, preparations = 0, broadcasts = 0, confirmations = 0, recovered = false;
  const payloads = [], transactionId = 'A'.repeat(52);
  const sponsor = {
    async prepare() {
      preparations++;
      return { transactionId, signedTransaction: Buffer.from('SYNTHETIC_TRANSACTION').toString('base64'),
        feeMicroAlgos: FEE_MICROALGOS, network: MANAGED_NETWORK };
    },
    async broadcast(prepared) { assert.equal(prepared.transactionId, transactionId); broadcasts++; },
  };
  service = new ManagedSponsorship(join(root, 'test-sponsor'), { sponsor, now: () => time });
  const account = service.provision({ paidThrough: time + 86400000 });
  const client = new ManagedAnchoringClient({ origin: 'https://synthetic.invalid', keyStore: new MemoryKeyStore(),
    request: async (_origin, path, token, body) => {
      if (path === '/v1/account') return service.account(token);
      assert.equal(path, '/v1/anchors'); submissions++; payloads.push(body.payload); time += 11000;
      const reply = await service.anchor(token, body);
      if (submissions <= 4) throw Object.assign(Error('SYNTHETIC_LOST_REPLY'), { code: 'SERVICE_UNAVAILABLE' });
      return reply;
    } });
  await client.connect(account.accessCode);
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID });
  const options = { vault, managed: client, fastTrust: { profile: FAST_CONFIRM_PROFILE },
    collectFast: async request => {
      confirmations++; assert.equal(request.transactionId, transactionId);
      if (!recovered) throw Object.assign(Error('SYNTHETIC_PENDING'), { code: 'PENDING_FAST_CONFIRMATION' });
      return {};
    }, verifyFast: () => ({ authorized: true, anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED', assurance: FAST_CONFIRM_PROFILE, round: 42 }) };
  session = await new ChatGPTRecordingSession(root, adapter, options).init();
  const saved = session.observeNormal({ kind: 'request-observed', eventId: randomUUID(), inputMethod: 'provider-request',
    text: 'SYNTHETIC_RECOVERABLE_PROMPT', request: { profile: 'chatgpt-new-user-text/2', path: '/backend-api/conversation', messageId: 'recovery-message', conversationId: 'test' },
    source: { adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT, scope: randomUUID(),
      runtimeEpoch: randomUUID(), browserSessionId: 'synthetic-browser', tabId: 17, windowId: 1,
      tabEpoch: 'synthetic-tab', documentId: 'synthetic-document', destination: 'conversation:test' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  engine = await new ResidentEngine(root, session, adapter, randomUUID()).init(); await engine.drain();
  t.mock.timers.tick(5000); await engine.drain(); t.mock.timers.tick(30000); await engine.drain();
  t.mock.timers.tick(100000); await engine.drain();
  assert.equal(submissions, 3); assert.equal(session.status().versions[0].anchorAttempts, 3);
  engine.stop(); session.close(); service.close();
  service = new ManagedSponsorship(join(root, 'test-sponsor'), { sponsor, now: () => time });
  session = await new ChatGPTRecordingSession(root, adapter, options).init();
  engine = await new ResidentEngine(root, session, adapter, randomUUID()).init(); await engine.drain();
  t.mock.timers.tick(5000); await engine.drain();
  assert.equal(submissions, 5); assert.equal(session.status().versions[0].managed.transactionId, transactionId);
  assert.equal(session.status().versions[0].anchorAttempts, 5);
  engine.stop(); session.close(); client.disconnect(); recovered = true;
  session = await new ChatGPTRecordingSession(root, adapter, options).init();
  engine = await new ResidentEngine(root, session, adapter, randomUUID()).init(); await engine.drain();
  const result = session.status().versions[0];
  assert.equal(result.anchor, 'SOURCE_CORROBORATED'); assert.equal(result.anchorAttempts, 6);
  assert.equal(result.recordDigest, saved.recordDigest); assert.equal(session.receipts.list().length, 1);
  assert.equal(preparations, 1); assert.equal(broadcasts, 3); assert.equal(submissions, 5); assert.equal(confirmations, 2);
  assert.equal(new Set(payloads).size, 1); assert.equal(service.account(account.accessCode).remaining, 999);
  engine.stop(); session.close(); session = await new ChatGPTRecordingSession(root, adapter, options).init();
  assert.equal(session.status().versions[0].anchorAttempts, 6);
  assert.equal(session.status().versions[0].anchor, 'SOURCE_CORROBORATED');
});
