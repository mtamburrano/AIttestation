#!/usr/bin/env node
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { b64, canonical, keys, parseCanonical, unb64 } from '../../vault/format.mjs';

export const NATIVE_BRIDGE_PROFILE = 'pap-chrome-native-bridge/2';
const MAX_MESSAGE_BYTES = 512 * 1024;
const defaultRendezvous = join(homedir(), 'Library', 'Application Support', 'Private Provenance', 'browser-bridge.json');

export function encodeNativeFrame(message) {
  const bytes = bridgeBytes(message);
  if (!bytes.length || bytes.length > MAX_MESSAGE_BYTES) throw Error('Native message limit exceeded');
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

function bridgeBytes(message) {
  if (!message || Array.isArray(message) || typeof message !== 'object') throw Error('Invalid native message');
  let encoded;
  try { encoded = JSON.stringify(message); } catch { throw Error('Invalid native message'); }
  if (typeof encoded !== 'string') throw Error('Invalid native message');
  const bytes = Buffer.from(encoded);
  if (!bytes.length || bytes.length > MAX_MESSAGE_BYTES) throw Error('Native message limit exceeded');
  return bytes;
}

function parseBridgeBytes(bytes) {
  if (!bytes.length || bytes.length > MAX_MESSAGE_BYTES) throw Error('Native message limit exceeded');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error('Invalid native message'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Invalid native message');
  return value;
}

export class NativeFrameDecoder {
  #bytes = Buffer.alloc(0);
  push(chunk) {
    this.#bytes = Buffer.concat([this.#bytes, Buffer.from(chunk)]);
    const messages = [];
    while (this.#bytes.length >= 4) {
      const length = this.#bytes.readUInt32LE(0);
      if (!length || length > MAX_MESSAGE_BYTES) throw Error('Native message limit exceeded');
      if (this.#bytes.length < length + 4) break;
      const raw = this.#bytes.subarray(4, length + 4); this.#bytes = this.#bytes.subarray(length + 4);
      messages.push(parseBridgeBytes(raw));
    }
    return messages;
  }
}

async function rendezvous(path, extensionOrigin, now) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || await realpath(path) !== path) {
    throw Error('Unsafe browser bridge rendezvous file');
  }
  const value = parseCanonical(await readFile(path), 16 * 1024);
  keys(value, ['profile', 'extensionOrigin', 'socketPath', 'token', 'runtimeEpoch', 'expiresAt']);
  if (value.profile !== NATIVE_BRIDGE_PROFILE || value.extensionOrigin !== extensionOrigin || !isAbsolute(value.socketPath)
      || resolve(value.socketPath) !== value.socketPath
      || !value.socketPath.startsWith(`${dirname(path)}${sep}`)
      || typeof value.runtimeEpoch !== 'string' || unb64(value.token, 32).length !== 32) throw Error('Invalid browser bridge rendezvous');
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now() || expiry > now() + 5 * 60_000) throw Error('Expired browser bridge rendezvous');
  const socket = await lstat(value.socketPath);
  if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && socket.uid !== process.getuid())
      || await realpath(value.socketPath) !== value.socketPath) throw Error('Unsafe browser bridge socket');
  return value;
}

export async function runNativeHost({
  extensionOrigin, rendezvousPath = defaultRendezvous, input = process.stdin, output = process.stdout,
  connect = path => createConnection(path), now = Date.now,
} = {}) {
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(extensionOrigin ?? '')) throw Error('Untrusted Chrome extension origin');
  const entry = await rendezvous(rendezvousPath, extensionOrigin, now), socket = connect(entry.socketPath);
  const ready = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  await ready;
  socket.write(`${canonical({ kind: 'PAP_BRIDGE_AUTH', profile: NATIVE_BRIDGE_PROFILE, extensionOrigin,
    runtimeEpoch: entry.runtimeEpoch, token: entry.token })}\n`);
  const decoder = new NativeFrameDecoder(); let buffered = Buffer.alloc(0);
  input.on('data', chunk => {
    try { for (const message of decoder.push(chunk)) socket.write(Buffer.concat([bridgeBytes(message), Buffer.from('\n')])); }
    catch { socket.destroy(); }
  });
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (buffered.length > MAX_MESSAGE_BYTES * 2) return socket.destroy();
    for (;;) {
      const newline = buffered.indexOf(0x0a); if (newline < 0) break;
      const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
      try { output.write(encodeNativeFrame(parseBridgeBytes(line))); }
      catch { socket.destroy(); break; }
    }
  });
  input.on('end', () => socket.end());
  return socket;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runNativeHost({ extensionOrigin: process.argv[2] }).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}

export function rendezvousRecord({ extensionOrigin, socketPath, runtimeEpoch, expiresAt, token }) {
  if (!Buffer.isBuffer(token) || token.length !== 32) throw Error('A fresh 32-byte bridge token is required');
  return canonical({ profile: NATIVE_BRIDGE_PROFILE, extensionOrigin, socketPath, runtimeEpoch, expiresAt,
    token: b64(token) });
}
