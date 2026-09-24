import { openSync, readSync, writeSync, closeSync, fsyncSync, unlinkSync, rmSync, constants, fstatSync } from 'node:fs';
import { randomBytes, createHmac } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { canonical, parseCanonical, encrypt, decrypt, hash, b64, pack, unpack, LIMITS, fail, keys } from './format.mjs';
import { verifyRecord } from './records.mjs';
import { Vault } from './vault.mjs';

const wire = value => Buffer.from(canonical(value));
const MAX_FRAME = 64 * 1024 * 1024;
function frameKey(secret, seq) { return createHmac('sha256', secret).update(`PAP/recovery-frame-key/v1\0${Math.floor(seq / 1024)}`).digest(); }
function frameAAD(header, seq) { return { domain: 'PAP/recovery-frame/v1', header: b64(hash(wire(header))), seq }; }
function seal(secret, header, seq, value) {
  const key = frameKey(secret, seq), nonce = Buffer.alloc(12); nonce.writeUInt32BE(seq % 1024, 8);
  try { return encrypt(key, wire(value), frameAAD(header, seq), nonce); } finally { key.fill(0); }
}
function unseal(secret, header, seq, box) {
  const key = frameKey(secret, seq);
  try { return parseCanonical(decrypt(key, box, frameAAD(header, seq), MAX_FRAME), MAX_FRAME); } finally { key.fill(0); }
}
function writeFrame(fd, value) {
  const bytes = wire(value); if (bytes.length > MAX_FRAME) fail('LIMIT_EXCEEDED', 'Recovery frame');
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  for (const part of [length, bytes]) { let offset = 0; while (offset < part.length) offset += writeSync(fd, part, offset); }
}
function readExact(fd, length, allowEOF = false) {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, null);
    if (!count) { if (allowEOF && !offset) return null; fail('INCOMPLETE', 'Truncated recovery frame'); }
    offset += count;
  }
  return bytes;
}
function readFrame(fd, allowEOF = false) {
  const length = readExact(fd, 4, allowEOF); if (!length) return null;
  const size = length.readUInt32BE(); if (size < 2 || size > MAX_FRAME) fail('LIMIT_EXCEEDED', 'Recovery frame');
  return parseCanonical(readExact(fd, size), MAX_FRAME);
}

// A fresh package key and framed authenticated chain permit arbitrarily many
// records while bounding memory to one record, one prompt and the SQLite cache.
export function exportRecoveryFile(vault, path) {
  const checkpoint = vault.checkpoint;
  const recoveryKey = randomBytes(32), header = { profile: 'pap-recovery-stream/1', vaultId: vault.vaultId,
    packageId: b64(randomBytes(16)), checkpoint: checkpoint.sequence };
  const fd = openSync(path, 'wx', 0o600); let success = false;
  try {
    writeFrame(fd, header); let count = 0, chain = null, previous = null;
    for (const record of vault.records()) {
      if (count === header.checkpoint) break;
      count++;
      const bytes = vault.read(record.manifest.evidence[0].objectDigest), result = verifyRecord(record, bytes);
      if (result.integrity !== 'VALID' || result.keyAttribution !== 'SIGNATURE_VALID'
          || record.manifest.sequence !== String(count) || record.manifest.previousRecordDigest !== previous) fail('INVALID', 'Invalid recovery evidence');
      const compressed = deflateRawSync(bytes), beneficial = compressed.length + 32 < bytes.length;
      const box = seal(recoveryKey, header, count, { kind: 'record', previous: chain, record,
        codec: beneficial ? 'deflate-raw' : 'raw', length: bytes.length, bytes: pack(beneficial ? compressed : bytes) });
      writeFrame(fd, box); chain = b64(hash(wire(box))); previous = record.recordDigest;
    }
    if (count !== header.checkpoint || previous !== checkpoint.recordDigest) fail('INCOMPLETE', 'Recovery checkpoint changed');
    writeFrame(fd, seal(recoveryKey, header, count + 1, { kind: 'complete', count, previous: chain, head: previous }));
    fsyncSync(fd); success = true; return { recoveryKey, records: count, path };
  } finally { closeSync(fd); if (!success) { recoveryKey.fill(0); unlinkSync(path); } }
}

export function inspectRecoveryFile(path, recoveryKey, { onRecord = () => {} } = {}) {
  if (!Buffer.isBuffer(recoveryKey) || recoveryKey.length !== 32) fail('UNRECOVERABLE');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) fail('INVALID', 'Recovery input must be a regular file');
    const header = readFrame(fd); keys(header, ['profile', 'vaultId', 'packageId', 'checkpoint']);
    if (header.profile !== 'pap-recovery-stream/1') fail('UNSUPPORTED');
    if (!Number.isSafeInteger(header.checkpoint) || header.checkpoint < 0) fail('INVALID');
    let chain = null, previous = null;
    for (let seq = 1; seq <= header.checkpoint; seq++) {
      const box = readFrame(fd), value = unseal(recoveryKey, header, seq, box);
      keys(value, ['kind', 'previous', 'record', 'codec', 'length', 'bytes']);
      if (value.kind !== 'record' || value.previous !== chain || !Number.isSafeInteger(value.length)
          || value.length < 0 || value.length > LIMITS.object || !['raw', 'deflate-raw'].includes(value.codec)) fail('INVALID');
      let bytes = unpack(value.bytes, LIMITS.object);
      if (value.codec === 'deflate-raw') {
        try { bytes = inflateRawSync(bytes, { maxOutputLength: Math.max(1, value.length) }); }
        catch { fail('INVALID', 'Compressed recovery evidence invalid'); }
      }
      const record = value.record, checked = verifyRecord(record, bytes);
      if (bytes.length !== value.length || checked.integrity !== 'VALID' || checked.keyAttribution !== 'SIGNATURE_VALID'
          || record.manifest.sequence !== String(seq) || record.manifest.previousRecordDigest !== previous) fail('INVALID', 'Recovery chain invalid');
      onRecord(record, bytes); previous = record.recordDigest; chain = b64(hash(wire(box)));
    }
    const footer = unseal(recoveryKey, header, header.checkpoint + 1, readFrame(fd));
    if (canonical(footer) !== canonical({ kind: 'complete', count: header.checkpoint, previous: chain, head: previous }) || readFrame(fd, true) !== null) fail('INVALID', 'Recovery footer mismatch');
    return { snapshot: 'COMPLETE', latestState: 'NOT_PROVEN', count: header.checkpoint, head: previous, packageId: header.packageId };
  } finally { closeSync(fd); }
}

export function restoreRecoveryFile(path, recoveryKey, newDirectory, newVMK, signing) {
  const validated = inspectRecoveryFile(path, recoveryKey);
  const vault = new Vault(newDirectory, newVMK, signing, { create: true });
  try {
    const restored = inspectRecoveryFile(path, recoveryKey, { onRecord: (record, bytes) => vault.importRecord(record, bytes) });
    if (canonical(validated) !== canonical(restored)) fail('INVALID', 'Recovery file changed during restore');
    return vault;
  } catch (error) { vault.close(); rmSync(newDirectory, { recursive: true }); throw error; }
}
