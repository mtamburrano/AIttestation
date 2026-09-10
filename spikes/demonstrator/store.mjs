import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, parseCanonical, objectDigest } from '../vault/format.mjs';

// The pointer contains only an event identifier. State and selected bytes live in
// the encrypted vault; pointer publication happens after the vault's FULL commit.
export class VaultReleaseStore {
  constructor(directory, vault) { this.directory = directory; this.vault = vault; }
  capture(bytes) {
    const ref = objectDigest(bytes);
    if (this.vault.inspect().objects.some(o => o.digest === ref)) {
      if (!this.vault.read(ref).equals(bytes)) throw Error('Evidence mismatch');
      return ref;
    }
    return this.vault.capture(bytes).manifest.evidence[0].objectDigest;
  }
  async save(state) {
    const stored = structuredClone(state);
    for (const seal of Object.values(stored.seals)) {
      seal.payload = {
        textRef: this.capture(Buffer.from(seal.payload.text)),
        attachments: seal.payload.attachments.map(a => ({ name: a.name, objectRef: this.capture(Buffer.from(a.bytes, 'base64')) })),
      };
    }
    const record = this.vault.capture(Buffer.from(canonical({ profile: 'pap-demo-release-state/1', state: stored })));
    const temporary = join(this.directory, `pointer-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(record.manifest.eventId); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(this.directory, 'release-pointer'));
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async load() {
    const id = await readFile(join(this.directory, 'release-pointer'), 'utf8');
    const record = this.vault.inspect().records.find(r => r.manifest.eventId === id);
    if (!record) throw Error('Release state is missing');
    const decoded = parseCanonical(this.vault.read(record.manifest.evidence[0].objectDigest));
    if (decoded.profile !== 'pap-demo-release-state/1') throw Error('Unsupported release state');
    const state = decoded.state;
    for (const seal of Object.values(state.seals)) seal.payload = {
      text: this.vault.read(seal.payload.textRef).toString('utf8'),
      attachments: seal.payload.attachments.map(a => ({ name: a.name, bytes: this.vault.read(a.objectRef).toString('base64') })),
    };
    return state;
  }
}
