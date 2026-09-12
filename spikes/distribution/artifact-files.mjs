import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { LEAK_OVERLAP, PackageLeakError, rejectSecretBytes, rejectSecretChunk, rejectSecretName } from './package-leaks.mjs';
export { rejectSecretBytes, rejectSecretName } from './package-leaks.mjs';

const MAX_METADATA = 16 * 1024 * 1024;
export const requireArtifact = condition => { if (!condition) throw Error('ARTIFACT_REJECTED'); };
export const safeRelative = path => typeof path === 'string' && path.length <= 1024
  && path.split('/').every(part => part && part !== '.' && part !== '..') && !/[\\\x00-\x1f\x7f:]/.test(path)
  && path === path.normalize('NFC');
const stamp = info => [info.dev, info.ino, info.size, info.mode, info.mtimeMs, info.ctimeMs].join(':');

async function inspectFile(path, before, keep) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    requireArtifact(info.isFile() && info.nlink === 1 && stamp(info) === stamp(before) && info.size <= 1024 ** 3);
    const hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024), parts = [];
    let length = 0, tail = Buffer.alloc(0);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      length += bytesRead; requireArtifact(length <= info.size);
      const bytes = chunk.subarray(0, bytesRead); hash.update(bytes);
      if (length === bytesRead) requireArtifact(!isZip(bytes, path) || info.size <= MAX_METADATA);
      const scan = Buffer.concat([tail, bytes]);
      rejectSecretChunk(scan);
      tail = Buffer.from(scan.subarray(-LEAK_OVERLAP));
      if (info.size <= MAX_METADATA) parts.push(Buffer.from(bytes));
    }
    requireArtifact(length === info.size && stamp(await handle.stat()) === stamp(info));
    const bytes = info.size <= MAX_METADATA ? Buffer.concat(parts) : null;
    if (bytes) {
      rejectSecretBytes(bytes);
      if (isZip(bytes, path)) storeArchive(bytes);
    } else requireArtifact(!/\.zip$/i.test(path));
    return { bytes: length, sha256: hash.digest('hex'), mode: info.mode & 0o777, stamp: stamp(info), content: keep ? bytes : null };
  } finally { await handle.close(); }
}

export async function artifactSnapshot(directory, { keep = true } = {}) {
  requireArtifact(await realpath(directory) === resolve(directory));
  const files = new Map(), directories = new Map(), aliases = new Set();
  let total = 0, retained = 0, count = 0, ordinal = 0;
  async function walk(prefix, depth) {
    requireArtifact(depth <= 32 && ++count <= 50_000);
    const absolute = join(directory, prefix), before = await lstat(absolute);
    requireArtifact(before.isDirectory() && !before.isSymbolicLink());
    directories.set(prefix, stamp(before));
    for (const name of (await readdir(absolute)).sort()) {
      const entry = ++ordinal;
      try {
        const path = prefix ? `${prefix}/${name}` : name;
        requireArtifact(safeRelative(path) && !aliases.has(path.toLowerCase())); aliases.add(path.toLowerCase());
        rejectSecretName(path);
        const info = await lstat(join(directory, path));
        requireArtifact(!info.isSymbolicLink());
        if (info.isDirectory()) await walk(path, depth + 1);
        else {
          requireArtifact(info.isFile() && info.nlink === 1 && ++count <= 50_000);
          requireArtifact(info.size <= MAX_METADATA || /\/MacOS\/|\/algorand\/bin\/|^[^/]+\.dmg$/.test(path));
          total += info.size; requireArtifact(total <= 6 * 1024 ** 3);
          if (keep && info.size <= MAX_METADATA) { retained += info.size; requireArtifact(retained <= 256 * 1024 * 1024); }
          files.set(path, await inspectFile(join(directory, path), info, keep));
        }
      } catch (error) {
        if (error instanceof PackageLeakError) error.entry ??= entry;
        throw error;
      }
    }
    requireArtifact(stamp(await lstat(absolute)) === stamp(before));
  }
  await walk('', 0);
  return { files, directories };
}

// Used before an upload/compression boundary and after final output preparation.
// keep=false changes retention only; every byte and supported archive is scanned.
export async function assertNoPackagedLeaks(directory) {
  await artifactSnapshot(resolve(directory), { keep: false });
}

export function snapshotIdentity(snapshot) {
  return JSON.stringify({ files: [...snapshot.files].map(([path, { content, ...info }]) => [path, info]),
    directories: [...snapshot.directories] });
}

export function artifactJSON(bytes) {
  requireArtifact(bytes && bytes.length <= MAX_METADATA);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // Reject duplicate member names even in the builder's pretty-printed JSON.
  // JSON string tokens followed by ':' are the only possible member names.
  const stack = [];
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"\s*:?|[{}\[\]]/g)) {
    const value = token[0];
    if (value === '{' || value === '[') { requireArtifact(stack.length < 32); stack.push(value === '{' ? new Set() : null); }
    else if (value === '}' || value === ']') stack.pop();
    else if (value.endsWith(':')) {
      const key = JSON.parse(value.slice(0, -1).trim()), names = stack.at(-1);
      requireArtifact(names instanceof Set && !names.has(key)); names.add(key);
    }
  }
  return JSON.parse(text);
}

// The builders emit flat XML Info.plist dictionaries. Reject unsupported XML,
// duplicate keys and entities instead of delegating parsing to a bundled tool.
export function bundleInfo(bytes) {
  let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  text = text.replace(/^\s*<\?xml version="1\.0" encoding="UTF-8"\?>\s*/, '')
    .replace(/^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*/, '');
  const match = text.match(/^<plist version="1\.0">\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>\s*$/);
  requireArtifact(match);
  const result = {}, entries = match[1]; let end = 0;
  for (const item of entries.matchAll(/\s*<key>([^<&]+)<\/key>\s*(?:<string>([^<&]*)<\/string>|<(true|false)\s*\/>)/g)) {
    requireArtifact(item.index === end && !Object.hasOwn(result, item[1]));
    result[item[1]] = item[3] ? item[3] === 'true' : item[2]; end = item.index + item[0].length;
  }
  requireArtifact(!entries.slice(end).trim()); return result;
}

const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
};

const isZip = (bytes, path) => /\.zip$/i.test(path) || bytes.length >= 4
  && [0x04034b50, 0x06054b50, 0x08074b50].includes(bytes.readUInt32LE(0));

function zipExtra(bytes, central) {
  // ditto emits one legacy Unix timestamp/UID field. Reject alternative name,
  // ZIP64 and opaque extension fields that another reader might interpret differently.
  requireArtifact(!bytes.length || bytes.length === (central ? 12 : 16)
    && bytes.readUInt16LE(0) === 0x5855 && bytes.readUInt16LE(2) === (central ? 8 : 12));
}

// Read only the small Store ZIP; never extract paths or invoke an archive tool.
// Local and central headers must describe one unambiguous, contiguous archive.
export function storeArchive(bytes, budget = { bytes: 0, entries: 0 }, depth = 0) {
  requireArtifact(depth <= 3);
  requireArtifact(bytes && bytes.length >= 22 && bytes.length <= MAX_METADATA);
  const end = bytes.length - 22;
  requireArtifact(bytes.readUInt32LE(end) === 0x06054b50 && bytes.readUInt16LE(end + 20) === 0
    && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0);
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  requireArtifact(count > 0 && count <= 256 && bytes.readUInt16LE(end + 8) === count && start + size === end);
  const files = new Map(), aliases = new Set(); let cursor = start, local = 0, total = 0;
  for (let i = 0; i < count; i++) {
    requireArtifact(++budget.entries <= 256);
    try {
      requireArtifact(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50);
      const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
      const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24);
      const n = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
      const offset = bytes.readUInt32LE(cursor + 42), mode = bytes.readUInt32LE(cursor + 38) >>> 16;
      requireArtifact(cursor + 46 + n + extra + comment <= end && comment === 0 && bytes.readUInt16LE(cursor + 34) === 0
        && !(flags & ~0x808) && [0, 8].includes(method) && [0, 0o100000, 0o040000].includes(mode & 0o170000));
      zipExtra(bytes.subarray(cursor + 46 + n, cursor + 46 + n + extra), true);
      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + n), name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
      const directory = name.endsWith('/'), path = directory ? name.slice(0, -1) : name;
      requireArtifact(safeRelative(path) && !aliases.has(path.toLowerCase())); aliases.add(path.toLowerCase()); rejectSecretName(path);
      requireArtifact(offset === local && local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50
        && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method);
      const ln = bytes.readUInt16LE(local + 26), le = bytes.readUInt16LE(local + 28), data = local + 30 + ln + le;
      requireArtifact(ln === n && bytes.subarray(local + 30, local + 30 + ln).equals(nameBytes) && data + compressed <= start);
      zipExtra(bytes.subarray(local + 30 + ln, data), false);
      if (!(flags & 8)) requireArtifact(bytes.readUInt32LE(local + 14) === crc
        && bytes.readUInt32LE(local + 18) === compressed && bytes.readUInt32LE(local + 22) === length);
      total += length; budget.bytes += length; requireArtifact(total <= MAX_METADATA && budget.bytes <= MAX_METADATA);
      const packed = bytes.subarray(data, data + compressed);
      const content = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, length), info: true });
      const unpacked = method === 0 ? content : content.buffer;
      requireArtifact((method === 0 || content.engine.bytesWritten === compressed) && unpacked.length === length && crc32(unpacked) === crc);
      local = data + compressed;
      if (flags & 8) {
        if (bytes.readUInt32LE(local) === 0x08074b50) local += 4;
        requireArtifact(local + 12 <= start && bytes.readUInt32LE(local) === crc
          && bytes.readUInt32LE(local + 4) === compressed && bytes.readUInt32LE(local + 8) === length); local += 12;
      }
      requireArtifact(!directory || !length);
      if (!directory) {
        rejectSecretBytes(unpacked);
        if (isZip(unpacked, path)) storeArchive(unpacked, budget, depth + 1);
        files.set(path, unpacked);
      }
      cursor += 46 + n + extra + comment;
    } catch (error) {
      if (error instanceof PackageLeakError) error.archiveEntries = [i + 1, ...(error.archiveEntries ?? [])];
      throw error;
    }
  }
  requireArtifact(cursor === end && local === start); return files;
}
