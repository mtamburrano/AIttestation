import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startPackagedChatGPT } from '../browser/chatgpt/runtime-main.mjs';
import { CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT, CHATGPT_RELEASE_PROTOCOL,
  CHATGPT_EXTENSION_ID, CHROME_BASELINE_MAJOR } from '../browser/chatgpt/adapter.mjs';
import { runNativeHost, NativeFrameDecoder, encodeNativeFrame } from '../browser/chatgpt/native-host.mjs';
import { FAST_CONFIRM_PROFILE, collectFastEvidence } from '../anchor/algorand/fast-confirm.mjs';
import { ManagedSponsorship } from '../managed/service.mjs';
import { ManagedAnchoringClient } from '../managed/client.mjs';
import { MANAGED_NETWORK } from '../managed/protocol.mjs';
import { MemoryKeyStore } from '../vault/key-lifecycle.mjs';
import { verifyPortable } from '../recipient/portable.mjs';

export const PRODUCT_SCENARIOS = Object.freeze(['sealed-success', 'sealed-delayed-confirmation', 'confirmation-unavailable',
  'confirmation-rejected', 'bridge-timeout', 'bridge-response-mismatch', 'account-disconnected', 'account-disconnected-cancel']);
export const SYNTHETIC_CANARY = 'SYNTHETIC_PRIVATE_PROMPT_e\u0301☕_https://private.invalid/c/secret?token=SECRET_CANARY_<div>PRIVATE_DOM</div>';
const transactionId = 'A'.repeat(52), sponsorOrigin = 'https://synthetic-sponsor.invalid';
const trust = Object.freeze({ profile: FAST_CONFIRM_PROFILE, network: MANAGED_NETWORK, genesis: 'synthetic-genesis',
  applicationServiceOrigin: sponsorOrigin,
  operators: [{ id: 'a', organization: 'Synthetic A', endpoint: 'https://synthetic-a.invalid' },
    { id: 'b', organization: 'Synthetic B', endpoint: 'https://synthetic-b.invalid' }] });

export function invariant(condition, code = 'SCENARIO_ASSERTION_FAILED') {
  if (!condition) { const error = Error(code); error.code = code; throw error; }
}
export async function deadline(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(Error('SCENARIO_TIMEOUT'), { code: 'SCENARIO_TIMEOUT' })), ms);
  })]); } finally { clearTimeout(timer); }
}
async function assertEncrypted(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertEncrypted(path);
    else if (entry.isFile()) invariant(!(await readFile(path)).includes(Buffer.from(SYNTHETIC_CANARY)), 'EVIDENCE_PLAINTEXT_FOUND');
  }
}

// Only this development module creates synthetic authorities. Packaged product
// resources exclude this directory, and every dependency is passed explicitly.
export async function productFixture(directory, scenario, diagnostics, network) {
  invariant(PRODUCT_SCENARIOS.includes(scenario), 'UNKNOWN_SCENARIO');
  invariant(typeof network?.allowRuntime === 'function', 'FIXTURE_NETWORK_FORBIDDEN');
  const disconnected = scenario.startsWith('account-disconnected');
  const keyStore = new MemoryKeyStore(), input = new PassThrough(), output = new PassThrough();
  let runtime, socket, payload, providerAttempts = 0, broadcasts = 0, preparations = 0, sponsorRequests = 0, failure, revokeNetwork;
  const observations = { a: 0, b: 0 };
  const service = new ManagedSponsorship(join(directory, 'synthetic-ledger'), { sponsor: {
    async prepare(value) {
      preparations++;
      payload = value;
      return { network: MANAGED_NETWORK, transactionId, feeMicroAlgos: 1000,
        signedTransaction: Buffer.from('SYNTHETIC_TRANSACTION_NO_NETWORK').toString('base64') };
    },
    async broadcast() { broadcasts++; },
  } });
  const account = service.provision({ paidThrough: Date.now() + 60_000 });
  const initialRemaining = service.account(account.accessCode).remaining;
  const managed = new ManagedAnchoringClient({ origin: sponsorOrigin, keyStore,
    request: async (origin, path, token, body) => {
      invariant(origin === sponsorOrigin, 'FIXTURE_NETWORK_FORBIDDEN');
      if (path === '/v1/account' && body === undefined) return service.account(token);
      if (path === '/v1/anchors') { sponsorRequests++; return service.anchor(token, body); }
      invariant(false, 'FIXTURE_NETWORK_FORBIDDEN');
    } });
  const observe = async (operator, request) => {
    invariant(request.transactionId === transactionId);
    const attempt = observations[operator.id]++;
    if (scenario === 'confirmation-unavailable') throw Object.assign(Error(SYNTHETIC_CANARY), { code: 'ALGOD_NOT_YET_OBSERVABLE' });
    if (scenario === 'sealed-delayed-confirmation' && attempt < (operator.id === 'a' ? 1 : 2)) {
      throw Object.assign(Error(SYNTHETIC_CANARY), { code: operator.id === 'a' ? 'ALGOD_NOT_YET_OBSERVABLE' : 'ALGOD_NOT_YET_CONFIRMED' });
    }
    return { profile: FAST_CONFIRM_PROFILE, network: MANAGED_NETWORK, genesis: 'synthetic-genesis',
      consensus: 'synthetic', transaction: 'synthetic', signedTxnInBlock: 'synthetic', fullHeader: 'synthetic', transactionProof: { synthetic: true },
      transactionId, confirmedRound: 42, blockHeaderHash: 'synthetic', sourceClaimedTime: 'synthetic',
      poolError: '', error: '', expired: false };
  };
  try {
    runtime = await startPackagedChatGPT({ supportDirectory: join(directory, 'engine'), keyStore, fastTrust: trust,
      managed, installation: null, diagnostics, openBrowser: false, controllerTimeoutMs: 50,
      collectFast: request => collectFastEvidence({ ...request, observe, waitMs: scenario === 'sealed-delayed-confirmation' ? 1500 : 250 }),
      verifyFast: (evidence, _trust, expected) => {
        invariant(evidence.profile === FAST_CONFIRM_PROFILE && evidence.transaction === 'synthetic' && expected === payload);
        if (scenario === 'confirmation-rejected') throw Object.assign(Error(SYNTHETIC_CANARY), { code: 'INVALID_FAST_CONFIRMATION' });
        return { authorized: true, anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED',
          assurance: FAST_CONFIRM_PROFILE, round: 42, reason: 'SYNTHETIC_FIXTURE_ONLY' };
      },
      verifyArchive: () => { throw Error('SYNTHETIC_ARCHIVE_NOT_CONFIGURED'); },
      attestPeer: async () => ({ browser: { product: 'Google Chrome', channel: 'stable', major: CHROME_BASELINE_MAJOR },
        platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' } }),
    });
    revokeNetwork = network.allowRuntime(runtime);
    const url = new URL(runtime.composerURL), origin = url.origin, secret = url.hash.slice(1);
    const api = async (path, data = {}, authorized = true) => {
      invariant(/^\/[a-z/-]+$/.test(path), 'FIXTURE_NETWORK_FORBIDDEN');
      const response = await fetch(new URL(path, origin), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Origin: origin, Authorization: `Bearer ${authorized ? secret : 'invalid'}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data) });
      return { status: response.status, body: await response.json() };
    };
    const decoder = new NativeFrameDecoder();
    output.on('data', chunk => {
      try {
        for (const command of decoder.push(chunk)) {
          if (command.kind === 'PAP_READY') continue;
          invariant(command.kind === 'PAP_RELEASE'); providerAttempts++;
          invariant(Buffer.from(command.textBytes, 'base64').toString('utf8') === SYNTHETIC_CANARY);
          const state = runtime.session.runtime.snapshot(), attempt = state.attempts[command.attemptId];
          invariant(attempt.state === 'DISPATCHING' && state.seals[attempt.sealId].authorization === null);
          if (scenario === 'bridge-timeout') continue;
          const response = { ...command, exposure: 'DOM_INJECTED', submitted: true, observation: 'LOCAL_CLICK_DISPATCHED',
            arbitraryDOM: SYNTHETIC_CANARY };
          delete response.textBytes;
          if (scenario === 'bridge-response-mismatch') response.destination = SYNTHETIC_CANARY;
          input.write(encodeNativeFrame(response));
        }
      } catch (error) { failure = error; socket?.destroy(); }
    });
    socket = await runNativeHost({ extensionOrigin: `chrome-extension://${CHATGPT_EXTENSION_ID}/`,
      rendezvousPath: runtime.rendezvousPath, input, output });
    socket.on('error', () => { failure = Object.assign(Error('FIXTURE_BRIDGE_FAILED'), { code: 'FIXTURE_BRIDGE_FAILED' }); });
    input.write(encodeNativeFrame({ kind: 'PAP_HELLO', extensionId: CHATGPT_EXTENSION_ID,
      adapterProfile: CHATGPT_ADAPTER_PROFILE, releaseProtocol: CHATGPT_RELEASE_PROTOCOL, pageContract: CHATGPT_PAGE_CONTRACT,
      browserSessionId: 'synthetic-browser-session', permissions: ['nativeMessaging'], hostPermission: 'https://chatgpt.com/*',
      permissionState: 'granted', tabs: [{ id: 17, url: 'https://chatgpt.com/c/synthetic-private-conversation',
        active: true, destination: 'synthetic-private-conversation', surfaceSupported: true, composerEmpty: true, attachmentsPresent: false }] }));
    await deadline(runtime.waitForPairing());
    input.write(encodeNativeFrame({ ...runtime.browserState(), kind: 'PAP_STATE' }));
    invariant((await api('/diagnostics/preview', {}, false)).status === 400);
    invariant((await api('/enroll', { tabId: 17, destination: 'synthetic-private-conversation' })).status === 200);
    const scope = runtime.session.status().scope;
    const frozen = await api('/freeze', { text: SYNTHETIC_CANARY, mode: 'Sealed', scope, editRevision: 1 });
    invariant(frozen.status === 200 && frozen.body.state === 'PENDING_FAST_CONFIRMATION' && providerAttempts === 0);
    const version = frozen.body, request = { id: version.id, scope, currentText: SYNTHETIC_CANARY, editRevision: 1 };
    invariant(runtime.session.vault.inspect().objects.some(object => runtime.session.vault.read(object.digest).equals(Buffer.from(SYNTHETIC_CANARY))));
    if (!disconnected) invariant((await api('/managed/connect', { accessCode: account.accessCode })).status === 200);
    const confirmation = await api('/managed/anchor', request);
    let observed;
    if (scenario.startsWith('confirmation-') || disconnected) {
      invariant(confirmation.status === (disconnected ? 200 : 400));
      invariant(runtime.session.status().versions[0].state === 'PENDING_FAST_CONFIRMATION');
      invariant(runtime.session.runtime.snapshot().seals[version.id].authorization === null);
      invariant(providerAttempts === 0);
      invariant((await api('/release', request)).status === 400);
      observed = disconnected ? 'ACCOUNT_REQUIRED'
        : scenario === 'confirmation-unavailable' ? 'CONFIRMATION_PENDING' : 'CONFIRMATION_REJECTED';
      if (scenario === 'account-disconnected-cancel') {
        const before = (await api('/receipts')).body;
        invariant(before.length === 1 && before[0].recordIds.length === 2);
        const cancelled = await api('/cancel', request);
        invariant(cancelled.status === 200 && cancelled.body.state === 'CANCELLED');
        invariant(Object.values(cancelled.body.actions).every(value => value === false) && !cancelled.body.managed.message);
        const recordCount = runtime.session.vault.inspect().records.length;
        for (const path of ['/cancel', '/managed/anchor', '/confirm', '/release', '/anchor-request']) {
          invariant((await api(path, { ...request, transactionId })).status === 400);
        }
        invariant(runtime.session.vault.inspect().records.length === recordCount);
        invariant((await api('/status')).body.protection.versions[0].state === 'CANCELLED');
        const history = (await api('/receipts')).body;
        invariant(history.length === 1 && history[0].recordIds.length === 3);
        const preview = await api('/receipts/preview', { ids: [history[0].id] });
        const exported = await api('/receipts/export', { previewId: preview.body.previewId });
        invariant(preview.status === 200 && exported.status === 200);
        const report = verifyPortable(Buffer.from(exported.body.content));
        const target = report.records.find(record => record.recordDigest === version.recordDigest);
        invariant(report.records.length === 3 && report.publicProofs.objects === 0);
        invariant(target.localAssertions.length === 1 && target.localAssertions[0].kind === 'release-cancelled'
          && target.localAssertions[0].assurance === 'CLIENT_ASSERTION_ONLY' && target.localAssertions[0].providerNonEgress === 'NOT_PROVEN');
        invariant(target.releaseControl === 'UNKNOWN' && target.anchor === 'INDETERMINATE' && target.timestamp === 'LOCAL_CLAIMED');
        invariant(observations.a === 0 && observations.b === 0 && providerAttempts === 0);
        observed = 'OPERATION_CANCELLED';
      }
    } else {
      invariant(confirmation.status === 200 && confirmation.body.state === 'SEALED_NOT_SENT');
      const released = await api('/release', request);
      observed = scenario.startsWith('sealed-') ? 'SUBMISSION_OBSERVED' : 'OUTCOME_UNKNOWN';
      invariant(released.status === 200 && released.body.state === observed && providerAttempts === 1);
      invariant((await api('/release', request)).status === 400 && providerAttempts === 1);
    }
    invariant(broadcasts === (disconnected ? 0 : 1));
    invariant(preparations === broadcasts && sponsorRequests === broadcasts);
    invariant(service.account(account.accessCode).remaining === initialRemaining - broadcasts);
    if (scenario === 'sealed-delayed-confirmation') invariant(observations.a === 2 && observations.b === 3);
    if (scenario === 'confirmation-rejected') invariant(observations.a === 1 && observations.b === 1);
    if (failure) throw failure;
    const selected = diagnostics.id('operationId', version.id);
    const preview = await api('/diagnostics/preview', { operationIds: [selected] });
    invariant(preview.status === 200 && preview.body.report.events.length > 0);
    invariant(preview.body.report.events.every(event => event.operationId === selected));
    const exported = await api('/diagnostics/export', { previewId: preview.body.previewId });
    invariant(exported.status === 200 && exported.body.content === JSON.stringify(preview.body.report));
    invariant((await api('/diagnostics/export', { previewId: preview.body.previewId })).status === 400);
    const forbidden = [SYNTHETIC_CANARY, account.accessCode, secret, scope, version.id, version.digest, version.recordDigest,
      'https://', 'synthetic-private-conversation', createHash('sha256').update(SYNTHETIC_CANARY).digest('hex')];
    const allDiagnostics = JSON.stringify(diagnostics.preview().report);
    invariant(forbidden.every(value => !allDiagnostics.includes(value)), 'DIAGNOSTIC_LEAK_FOUND');
    await assertEncrypted(join(directory, 'engine'));
    return { scenario, status: 'PASS', observed, operationId: selected,
      epochId: diagnostics.id('epochId', runtime.runtimeEpoch), providerAttempts, sponsorBroadcasts: broadcasts,
      evidence: 'ENCRYPTED_TEMPORARY_VAULT', providerReceipt: 'UNKNOWN' };
  } finally {
    input.end(); socket?.destroy();
    try { await runtime?.close(); } finally { service.close(); revokeNetwork?.(); }
  }
}
