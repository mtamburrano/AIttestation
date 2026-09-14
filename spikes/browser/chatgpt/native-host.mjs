#!/usr/bin/env node
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { b64, canonical, keys, parseCanonical, unb64 } from '../../vault/format.mjs';

export const NATIVE_BRIDGE_PROFILE = 'pap-chrome-native-bridge/3';
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
  connect = path => createConnection(path), now = Date.now, handshakeTimeoutMs = 8_000,
  onClose = () => {},
} = {}) {
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(extensionOrigin ?? '')) throw Error('Untrusted Chrome extension origin');
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1 || handshakeTimeoutMs > 10_000) {
    throw Error('Invalid native handshake timeout');
  }
  const entry = await rendezvous(rendezvousPath, extensionOrigin, now), socket = connect(entry.socketPath);
  return new Promise((resolveReady, rejectReady) => {
    const decoder = new NativeFrameDecoder(); let buffered = Buffer.alloc(0), ready = false, closed = false;
    const finish = reason => {
      if (closed) return;
      closed = true; clearTimeout(timer);
      input.off('data', fromChrome);
      // The browser keeps stdin open while its native port exists. Closing only
      // the socket leaves a live relay (and its waiting native wrapper) behind.
      socket.destroy(); input.destroy(); output.destroy();
      if (!ready) rejectReady(Object.assign(Error(reason), { code: reason }));
      try { onClose(reason); } catch {}
    };
    const timer = setTimeout(() => finish('NATIVE_HANDSHAKE_TIMEOUT'), handshakeTimeoutMs);
    const fromChrome = chunk => {
      if (closed) return;
      try { for (const message of decoder.push(chunk)) socket.write(Buffer.concat([bridgeBytes(message), Buffer.from('\n')])); }
      catch { finish('NATIVE_INPUT_INVALID'); }
    };
    input.once('end', () => finish('NATIVE_INPUT_ENDED'));
    input.once('close', () => finish('NATIVE_INPUT_CLOSED'));
    input.on('error', () => finish('NATIVE_INPUT_ERROR'));
    output.once('close', () => finish('NATIVE_OUTPUT_CLOSED'));
    output.on('error', () => finish('NATIVE_OUTPUT_ERROR'));
    socket.on('error', () => finish('NATIVE_BACKEND_ERROR'));
    socket.once('end', () => finish('NATIVE_BACKEND_EOF'));
    socket.once('close', () => finish('NATIVE_BACKEND_CLOSED'));
    socket.once('connect', () => {
      if (closed) return;
      socket.write(`${canonical({ kind: 'PAP_BRIDGE_AUTH', profile: NATIVE_BRIDGE_PROFILE, extensionOrigin,
        runtimeEpoch: entry.runtimeEpoch, token: entry.token })}\n`);
    });
    socket.on('data', chunk => {
      if (closed) return;
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      if (buffered.length > MAX_MESSAGE_BYTES * 2) return finish('NATIVE_BACKEND_INVALID');
      for (;;) {
        const newline = buffered.indexOf(0x0a); if (newline < 0) break;
        const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
        try {
          const message = parseBridgeBytes(line);
          if (!ready) {
            keys(message, ['kind', 'profile', 'runtimeEpoch']);
            if (message.kind !== 'PAP_BRIDGE_READY' || message.profile !== NATIVE_BRIDGE_PROFILE
                || message.runtimeEpoch !== entry.runtimeEpoch) return finish('NATIVE_HANDSHAKE_REJECTED');
            ready = true; clearTimeout(timer); input.on('data', fromChrome); resolveReady(socket);
          } else output.write(encodeNativeFrame(message));
        } catch { finish('NATIVE_BACKEND_INVALID'); break; }
      }
    });
    if (input.destroyed || input.readableEnded || output.destroyed) finish('NATIVE_STDIO_CLOSED');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runNativeHost({ extensionOrigin: process.argv[2], onClose: code => process.stderr.write(`${code}\n`) }).catch(() => {
    process.stderr.write('NATIVE_BRIDGE_START_FAILED\n'); process.exitCode = 1;
    process.stdin.destroy(); process.stdout.destroy();
  });
}

export function rendezvousRecord({ extensionOrigin, socketPath, runtimeEpoch, expiresAt, token }) {
  if (!Buffer.isBuffer(token) || token.length !== 32) throw Error('A fresh 32-byte bridge token is required');
  return canonical({ profile: NATIVE_BRIDGE_PROFILE, extensionOrigin, socketPath, runtimeEpoch, expiresAt,
    token: b64(token) });
}
