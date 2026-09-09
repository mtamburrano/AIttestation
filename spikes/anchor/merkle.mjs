import { hash, b64, unb64, fail, keys } from '../vault/format.mjs';

const leaf = data => hash(Buffer.from([0]), data);
const branch = (left, right) => hash(Buffer.from([1]), left, right);
const split = n => 2 ** Math.floor(Math.log2(n - 1));
export function merkleRoot(entries) {
  if (!Array.isArray(entries) || entries.length > 512) fail('LIMIT_EXCEEDED');
  const values = entries.map(e => Buffer.from(e));
  if (values.some(e => e.length !== 32)) fail('INVALID', 'Record digest length');
  function root(list) {
    if (!list.length) return hash(Buffer.alloc(0));
    if (list.length === 1) return leaf(list[0]);
    const k = split(list.length); return branch(root(list.slice(0, k)), root(list.slice(k)));
  }
  return root(values);
}
export function inclusion(entries, position) {
  if (!Number.isSafeInteger(position) || position < 0 || position >= entries.length) fail('INVALID');
  merkleRoot(entries);
  function path(list, index) {
    if (list.length === 1) return [];
    const k = split(list.length);
    return index < k ? [...path(list.slice(0, k), index), b64(merkleRoot(list.slice(k)))]
      : [...path(list.slice(k), index - k), b64(merkleRoot(list.slice(0, k)))];
  }
  return { profile: 'rfc9162-sha256/1', treeSize: String(entries.length), position: String(position),
    root: b64(merkleRoot(entries)), path: path(entries, position) };
}
export function verifyInclusion(recordDigest, proof) {
  keys(proof, ['profile', 'treeSize', 'position', 'root', 'path']);
  if (proof.profile !== 'rfc9162-sha256/1') fail('UNSUPPORTED', 'Merkle profile');
  if (typeof proof.treeSize !== 'string' || !/^[1-9][0-9]{0,2}$/.test(proof.treeSize)
      || typeof proof.position !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(proof.position)) fail('INVALID');
  const size = Number(proof.treeSize), position = Number(proof.position);
  if (size > 512 || position >= size || !Array.isArray(proof.path) || proof.path.length > 9) fail('INVALID');
  const entry = unb64(recordDigest, 32), expected = unb64(proof.root, 32), path = proof.path.map(p => unb64(p, 32));
  let used = 0;
  function reconstruct(n, index) {
    if (n === 1) return leaf(entry);
    const k = split(n);
    const child = index < k ? reconstruct(k, index) : reconstruct(n - k, index - k);
    if (used >= path.length) fail('INVALID', 'Truncated inclusion path');
    const sibling = path[used++];
    return index < k ? branch(child, sibling) : branch(sibling, child);
  }
  return reconstruct(size, position).equals(expected) && used === path.length;
}
export function anchorPayload(root) {
  const bytes = Buffer.from(root); if (bytes.length !== 32) fail('INVALID');
  return Buffer.concat([Buffer.from('PAP'), Buffer.from([1]), bytes]);
}
