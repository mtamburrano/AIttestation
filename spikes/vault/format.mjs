import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// These are limits for individual evidence objects and portable/legacy packages, not retained vault history.
export const LIMITS = Object.freeze({ object: 32 * 2 ** 20, manifest: 2 ** 20, objects: 512,
  entries: 1024, total: 256 * 2 ** 20, depth: 32, field: 256 * 2 ** 10, wire: 384 * 2 ** 20 });
export class VaultError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new VaultError(code, message); };
export const hash = (...parts) => createHash('sha256').update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest();
export const b64 = b => Buffer.from(b).toString('base64url');
export function unb64(s, length) {
  if (typeof s !== 'string' || s.length > LIMITS.field || !/^[A-Za-z0-9_-]*$/.test(s)) fail('INVALID', 'Invalid binary field');
  const b = Buffer.from(s, 'base64url');
  if (b64(b) !== s || (length !== undefined && b.length !== length)) fail('INVALID', 'Invalid binary length/encoding');
  return b;
}
export function keys(value, names) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail('INVALID', 'Unknown/missing fields');
}
export function canonical(value, depth = 0) {
  if (depth > LIMITS.depth) fail('LIMIT_EXCEEDED', 'JSON depth');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('INVALID'); return JSON.stringify(value); }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) fail('INVALID', 'Non-Unicode string');
    if (Buffer.byteLength(value) > LIMITS.field) fail('LIMIT_EXCEEDED', 'Metadata field');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(',')}]`;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID', 'Not a JSON object');
  return `{${Object.keys(value).sort().map(k => `${canonical(k, depth + 1)}:${canonical(value[k], depth + 1)}`).join(',')}}`;
}
export function parseCanonical(input, max = LIMITS.wire) {
  if (Buffer.byteLength(input) > max) fail('LIMIT_EXCEEDED', 'Encoded material');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(input)); } catch { fail('INVALID', 'UTF-8'); }
  let depth = 0, quoted = false, escape = false;
  for (const c of text) {
    if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') { if (++depth > LIMITS.depth + 1) fail('LIMIT_EXCEEDED', 'JSON depth'); }
    else if (c === '}' || c === ']') depth--;
  }
  let value;
  try { value = JSON.parse(text); } catch { fail('INVALID', 'JSON syntax'); }
  // Exact round-trip also rejects duplicate names and alternate/non-canonical encodings.
  if (canonical(value) !== text) fail('INVALID', 'Non-canonical JSON');
  return value;
}
export function pack(bytes) {
  const b = Buffer.from(bytes), chunks = [];
  for (let i = 0; i < b.length; i += 128 * 1024) chunks.push(b64(b.subarray(i, i + 128 * 1024)));
  return chunks;
}
export function unpack(chunks, max = LIMITS.total) {
  if (!Array.isArray(chunks) || chunks.length > Math.ceil(max / (128 * 1024))) fail('LIMIT_EXCEEDED');
  const values = chunks.map((c, i) => {
    const b = unb64(c);
    if (!b.length || b.length > 128 * 1024 || (i < chunks.length - 1 && b.length !== 128 * 1024)) fail('INVALID', 'Noncanonical chunks');
    return b;
  });
  const bytes = Buffer.concat(values); if (bytes.length > max) fail('LIMIT_EXCEEDED'); return bytes;
}
export function encrypt(key, bytes, aad, nonce = randomBytes(12)) {
  if (key.length !== 32) fail('UNRECOVERABLE', 'Missing encryption key');
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(canonical(aad)));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { algorithm: 'AES-256-GCM', nonce: b64(nonce), tag: b64(cipher.getAuthTag()), ciphertext: pack(ciphertext) };
}
export function decrypt(key, envelope, aad, max = LIMITS.total) {
  if (!key || key.length !== 32) fail('UNRECOVERABLE', 'Missing decryption key');
  keys(envelope, ['algorithm', 'nonce', 'tag', 'ciphertext']);
  if (envelope.algorithm !== 'AES-256-GCM') fail('UNSUPPORTED', 'AEAD algorithm');
  const nonce = unb64(envelope.nonce, 12), tag = unb64(envelope.tag, 16), ciphertext = unpack(envelope.ciphertext, max);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(canonical(aad))); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { fail('INVALID', 'Authentication failed'); }
}
export const objectDigest = bytes => b64(hash('PAP/object/v1\0', bytes));
export const aad = (domain, vaultId, role, id, packageId = null, snapshotId = null) => ({
  domain, profile: 'pap-poc-crypto/1', vaultId, role, id, packageId, snapshotId,
});
