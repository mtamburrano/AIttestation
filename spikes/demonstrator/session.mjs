import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Vault, restoreRecovery } from '../vault/vault.mjs';
import { identity, publicBytes, verifyDisclosure } from '../vault/records.mjs';
import { canonical, parseCanonical, unb64, b64 } from '../vault/format.mjs';
import { ReleaseRuntime, validatePayload, digest } from '../release/runtime.mjs';
import { VaultReleaseStore } from './store.mjs';
import { signedLogFixture } from '../anchor/fixture.mjs';
import { verifyAnchor } from '../anchor/verifier.mjs';
import { inclusion, anchorPayload } from '../anchor/merkle.mjs';
import { recoveredBundle, sharedAnchors } from './verification.mjs';

const wire = value => Buffer.from(canonical(value));
export class DemoSession {
  #tail = Promise.resolve(); #proofs = new Map(); #pendingProofs = new Map(); #versions = new Map(); #log = identity(); #dispatch;
  #scope = null; #trust = null; #policy = 'algorand'; #recovery = null;
  constructor(directory, dispatch, { fault = () => {} } = {}) {
    this.directory = directory; this.#dispatch = dispatch; this.fault = fault;
    this.vault = new Vault(join(directory, 'vault'), randomBytes(32), undefined, { create: true });
    this.store = new VaultReleaseStore(directory, this.vault);
  }
  async init() {
    this.runtime = await new ReleaseRuntime(this.directory, a => this.#dispatch(a), this.fault,
      { store: this.store, confirm: seal => this.#confirmation(seal) }).init();
    return this;
  }
  #serial(fn) { const p = this.#tail.then(fn); this.#tail = p.catch(() => {}); return p; }
  enroll(scope, policy, trust = null) {
    if (this.#versions.size || this.#scope) throw Error('Start a new session to change scope or trust');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(scope) || !['algorand', 'fixture'].includes(policy)) throw Error('Unsupported scope/policy');
    if (policy === 'algorand' && trust !== null && trust.profile !== 'pap-algorand-sp/1') throw Error('Algorand trust required');
    this.#scope = scope; this.#policy = policy;
    this.#trust = policy === 'fixture' ? { profile: 'pap-signed-log-fixture/1', network: 'synthetic-log', genesis: 'test-only-genesis',
      checkpoint: { publicKey: publicBytes(this.#log.publicKey), minimumSequence: '1' } } : structuredClone(trust);
    return { scope, policy, assurance: policy === 'fixture' ? 'TEST_LOG_KEY_SIGNATURE; no chain or UTC assurance' : 'Algorand proof required before release' };
  }
  #eligible(scope, supported) {
    if (!this.#scope || scope !== this.#scope || supported !== true) throw Error('UNSUPPORTED_PATH: only the enrolled local composer and synthetic provider are eligible');
  }
  #event(value) { return this.vault.capture(wire({ profile: 'pap-demo-observation/1', ...value })); }
  freeze({ payload, scope, mode, supported }) {
    return this.#serial(async () => {
      this.#eligible(scope, supported);
      if (!['Continuous', 'Sealed', 'Always Protect'].includes(mode)) throw Error('Unsupported mode');
      payload = validatePayload(payload);
      const text = this.vault.capture(Buffer.from(payload.text));
      const attachments = payload.attachments.map(a => ({ name: a.name, record: this.vault.capture(Buffer.from(a.bytes, 'base64')) }));
      const descriptor = this.#event({ kind: 'frozen-version', mode, scope, payloadDigest: digest(payload),
        textRecord: text.manifest.eventId, textObject: text.manifest.evidence[0].objectDigest,
        attachments: attachments.map(a => ({ name: a.name, record: a.record.manifest.eventId, object: a.record.manifest.evidence[0].objectDigest })) });
      const sealed = await this.runtime.seal(payload, scope);
      const version = { ...sealed, mode, descriptorId: descriptor.manifest.eventId, recordDigest: descriptor.recordDigest,
        state: 'PENDING_ANCHOR', anchor: 'PENDING', response: null, attempt: null };
      this.#versions.set(sealed.id, version);
      return this.#public(version);
    });
  }
  #version(id) { const v = this.#versions.get(id); if (!v) throw Error('Unknown version'); return v; }
  #public(v) { return structuredClone(v); }
  #confirmation(seal) {
    const v = this.#version(seal.id), proof = this.#pendingProofs.get(seal.id);
    if (!proof) throw Error('PENDING_ANCHOR: import and validate the exact version proof');
    const report = verifyAnchor(proof, this.#trust, v.recordDigest);
    const accepted = this.#policy === 'fixture' ? report.anchor === 'FIXTURE_VERIFIED'
      : report.anchor === 'CONSENSUS_VERIFIED' && report.timestamp === 'BLOCK_HASH_BOUND';
    if (!accepted || !report.independentlyVerified) throw Error(`Anchor rejected: ${report.reason}`);
    const receipt = this.#event({ kind: 'validated-confirmation', version: v.id, recordDigest: v.recordDigest,
      report, envelope: parseCanonical(proof) });
    return { policy: this.#policy, digest: seal.digest, result: report.anchor, receiptId: receipt.manifest.eventId };
  }
  confirm({ id, proof = null }) {
    return this.#serial(async () => {
      const v = this.#version(id);
      const bytes = proof === null && this.#policy === 'fixture'
        ? signedLogFixture([v.recordDigest], 0, this.#log) : typeof proof === 'string' ? Buffer.from(proof) : null;
      if (!bytes) throw Error('PENDING_ANCHOR: an Algorand archive is required');
      this.#pendingProofs.set(id, bytes);
      try { await this.runtime.confirm(id, v.scope, v.digest); }
      finally { this.#pendingProofs.delete(id); }
      this.#proofs.set(id, bytes);
      v.anchor = this.#policy === 'fixture' ? 'FIXTURE_VERIFIED' : 'CONSENSUS_VERIFIED';
      v.state = v.mode === 'Continuous' && v.attempt ? v.attempt.state : 'SEALED_NOT_SENT';
      return this.#public(v);
    });
  }
  release({ id, currentPayload, scope, supported }) {
    return this.#serial(async () => {
      this.#eligible(scope, supported);
      const v = this.#version(id);
      if (v.scope !== scope || digest(validatePayload(currentPayload)) !== v.digest) throw Error('Stale version');
      if (v.mode === 'Continuous') {
        if (v.attempt) throw Error('Already attempted; no automatic resend');
        // Continuous deliberately releases before anchoring. It still durably records
        // the local attempt, and never inherits a pre-disclosure Sealed claim.
        const attemptId = randomUUID();
        this.#event({ kind: 'release-attempt', version: id, attemptId, mode: v.mode, state: 'DISPATCHING', anchor: v.anchor });
        v.attempt = { attemptId, state: 'OUTCOME_UNKNOWN', providerReceipt: 'UNKNOWN' };
        let state;
        try { state = await this.#dispatch({ attemptId, sealId: id, scope, digest: v.digest, payload: validatePayload(currentPayload), continuous: true }); }
        catch { state = 'OUTCOME_UNKNOWN'; }
        v.attempt.state = ['SUBMISSION_OBSERVED', 'FAILED_BEFORE_EGRESS'].includes(state) ? state : 'OUTCOME_UNKNOWN';
      } else {
        v.attempt = await this.runtime.release({ id, scope, expectedDigest: v.digest, currentPayload });
      }
      v.state = v.attempt.state;
      this.#event({ kind: 'release-outcome', version: id, mode: v.mode, ...v.attempt });
      return this.#public(v);
    });
  }
  captureVisible({ id, text, scope }) {
    return this.#serial(async () => {
      this.#eligible(scope, true); const v = this.#version(id);
      if (!v.attempt || v.state !== 'SUBMISSION_OBSERVED' || typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw Error('No supported visible response');
      const captured = this.vault.capture(Buffer.from(text));
      this.#event({ kind: 'client-observed-visible-text', version: id, attemptId: v.attempt.attemptId,
        extraction: 'DOM textContent encoded as UTF-8', responseRecord: captured.manifest.eventId,
        providerReceipt: 'UNKNOWN', coverage: 'selected visible text; no provider-internal context' });
      v.response = captured.manifest.eventId; return this.#public(v);
    });
  }
  anchorRequest(id) {
    const v = this.#version(id), batch = inclusion([unb64(v.recordDigest, 32)], 0);
    return { recordDigest: v.recordDigest, batch, payload: b64(anchorPayload(unb64(batch.root, 32))) };
  }
  exportDisclosure() {
    const disclosure = this.vault.exportDisclosure(this.vault.inspect().records.map(r => r.manifest.eventId));
    const shared = sharedAnchors([...this.#proofs.entries()].map(([id, bytes]) => ({
      descriptorId: this.#version(id).descriptorId, envelope: bytes.toString() })));
    return { profile: 'pap-demo-export/2', disclosure: disclosure.toString(), ...shared, trust: structuredClone(this.#trust),
      report: verifyDisclosure(disclosure), claims: 'Key-attributed local assertions; no authorship, provider receipt, complete history or latest-state proof.' };
  }
  exportRecovery() {
    const seals = this.runtime.snapshot().seals;
    this.#event({ kind: 'recovery-export-index', anchors: [...this.#proofs.keys()].map(id => ({
      descriptorId: this.#version(id).descriptorId, receiptId: seals[id].confirmation.receiptId,
    })) });
    this.#recovery = this.vault.exportRecovery();
    return { package: this.#recovery.package.toString(), recoveryKey: b64(this.#recovery.recoveryKey) };
  }
  restore(packageText, recoveryKey) {
    const restored = restoreRecovery(Buffer.from(packageText), unb64(recoveryKey, 32), join(this.directory, `restored-${randomUUID()}`), randomBytes(32));
    try {
      const report = restored.verifyAll();
      const disclosure = restored.exportDisclosure(restored.inspect().records.map(r => r.manifest.eventId));
      return { ...report, verification: verifyDisclosure(disclosure), disclosure: disclosure.toString(), bundle: recoveredBundle(disclosure.toString()),
        releaseAuthority: 'NONE; restored history never authorizes sending', deviceIdentity: 'FRESH' };
    } finally { restored.close(); }
  }
  status() { return { policy: this.#policy, scope: this.#scope, versions: [...this.#versions.values()].map(v => this.#public(v)) }; }
  close() { this.#recovery?.recoveryKey.fill(0); this.vault.close(); }
  async drain() { await this.#tail; }
}
