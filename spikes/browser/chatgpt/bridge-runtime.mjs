import { createServer } from 'node:net';
import { getuid } from 'node:process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { canonical, keys, parseCanonical, unb64 } from '../../vault/format.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID } from './adapter.mjs';
import { ChromeBridgeController } from './bridge.mjs';
import { ChatGPTProtectionSession } from './session.mjs';
import { NATIVE_BRIDGE_PROFILE, rendezvousRecord } from './native-host.mjs';

const MAX_LINE_BYTES = 512 * 1024;
const AUTH_TIMEOUT_MS = 2_000;
const RENDEZVOUS_LIFETIME_MS = 4 * 60_000;

function bridgeError(message) {
  const error = Error(message); error.code = 'UNSUPPORTED_PATH'; return error;
}

async function ownerDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (typeof getuid === 'function' && info.uid !== getuid()) || await realpath(path) !== path) {
    throw bridgeError('Browser bridge directory must be owner-only and canonical');
  }
}

async function safeExistingFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || (typeof getuid === 'function' && info.uid !== getuid()) || await realpath(path) !== path) {
      throw bridgeError('Unsafe existing browser bridge rendezvous');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function atomicOwnerWrite(path, value) {
  await safeExistingFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(value); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path); renamed = true;
    const parent = await open(dirname(path), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    if (!renamed) try { await unlink(temporary); } catch {}
  }
}

function parseLine(line, canonicalOnly = false) {
  if (!line.length || line.length > MAX_LINE_BYTES) throw bridgeError('Browser bridge message limit exceeded');
  if (canonicalOnly) return parseCanonical(line, MAX_LINE_BYTES);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
  catch { throw bridgeError('Invalid browser bridge JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw bridgeError('Invalid browser bridge message');
  return value;
}

const listen = (server, path) => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(path, () => { server.off('error', reject); resolveListen(); });
});

const stop = server => new Promise(resolveStop => server.close(resolveStop));

/**
 * Owns the authenticated native rendezvous and composes the production chain:
 * Chrome native messaging -> controller -> adapter -> protected session.
 */
export async function startChromeProtectionRuntime(directory, {
  extensionId = CHATGPT_EXTENSION_ID, fastTrust, vault = null, vaultKey = null,
  collectFast, verifyFast, verifyArchive, fault, controllerTimeoutMs = 5_000,
  rendezvousPath = join(directory, 'browser-bridge.json'), socketPath = null,
  now = Date.now,
} = {}) {
  if (!isAbsolute(directory) || !/^[a-p]{32}$/.test(extensionId)) throw bridgeError('Invalid browser bridge configuration');
  await ownerDirectory(directory);
  const canonicalDirectory = await realpath(directory);
  if (resolve(rendezvousPath) !== rendezvousPath || dirname(rendezvousPath) !== canonicalDirectory) {
    throw bridgeError('Rendezvous must be an absolute file in the owner-only bridge directory');
  }
  const runtimeEpoch = randomUUID();
  const selectedSocket = socketPath ?? join(canonicalDirectory, `bridge-${runtimeEpoch.slice(0, 12)}.sock`);
  if (!isAbsolute(selectedSocket) || !resolve(selectedSocket).startsWith(`${canonicalDirectory}${sep}`)
      || Buffer.byteLength(selectedSocket) > 100) throw bridgeError('Unsafe or overlong browser bridge socket path');

  let controller = null, activeSocket = null, latestBrowserState = null, closed = false;
  let currentToken = randomBytes(32), expiresAt = 0, refreshTimer, publishTail = Promise.resolve();
  let pairedResolve;
  const paired = new Promise(resolvePaired => { pairedResolve = resolvePaired; });
  const extensionOrigin = `chrome-extension://${extensionId}/`;
  const adapter = new ChatGPTChromeAdapter(command => {
    if (!controller) {
      const error = bridgeError('Authenticated Chrome bridge is disconnected'); error.exposure = 'NONE';
      return Promise.reject(error);
    }
    return controller.sendRelease(command);
  }, { extensionId });
  const session = await new ChatGPTProtectionSession(directory, adapter, {
    vault, vaultKey, fastTrust,
    ...(collectFast === undefined ? {} : { collectFast }),
    ...(verifyFast === undefined ? {} : { verifyFast }),
    ...(verifyArchive === undefined ? {} : { verifyArchive }),
    ...(fault === undefined ? {} : { fault }),
  }).init();

  const publishRendezvous = () => {
    const operation = publishTail.then(async () => {
      if (closed) return;
      currentToken = randomBytes(32); expiresAt = now() + RENDEZVOUS_LIFETIME_MS;
      await atomicOwnerWrite(rendezvousPath, rendezvousRecord({
        extensionOrigin, socketPath: selectedSocket, runtimeEpoch,
        expiresAt: new Date(expiresAt).toISOString(), token: currentToken,
      }));
    });
    publishTail = operation.catch(() => {});
    return operation;
  };

  const server = createServer(socket => {
    if (closed || activeSocket) { socket.destroy(); return; }
    let authenticated = false, bytes = Buffer.alloc(0), connectionController = null;
    const authTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    const fail = () => socket.destroy();
    socket.on('error', () => {});
    socket.on('data', chunk => {
      try {
        bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
        if (bytes.length > MAX_LINE_BYTES * 2) return fail();
        for (;;) {
          const newline = bytes.indexOf(0x0a); if (newline < 0) break;
          const line = bytes.subarray(0, newline); bytes = bytes.subarray(newline + 1);
          if (!authenticated) {
            const auth = parseLine(line, true);
            keys(auth, ['kind', 'profile', 'extensionOrigin', 'runtimeEpoch', 'token', 'browser', 'platform']);
            keys(auth.browser, ['product', 'channel', 'major']);
            keys(auth.platform, ['product', 'arch', 'version']);
            const supplied = unb64(auth.token, 32);
            if (activeSocket || auth.kind !== 'PAP_BRIDGE_AUTH' || auth.profile !== NATIVE_BRIDGE_PROFILE
                || auth.extensionOrigin !== extensionOrigin || auth.runtimeEpoch !== runtimeEpoch
                || now() >= expiresAt || !timingSafeEqual(supplied, currentToken)) return fail();
            authenticated = true; clearTimeout(authTimer); activeSocket = socket;
            connectionController = new ChromeBridgeController(adapter, message => {
              if (socket.destroyed) throw bridgeError('Browser bridge disconnected');
              socket.write(`${canonical(message)}\n`);
            }, { timeoutMs: controllerTimeoutMs, localBrowser: auth.browser, localPlatform: auth.platform });
            controller = connectionController;
            // Consume the just-used token. A replacement is published for a
            // later Chrome reconnect while this socket remains the only peer.
            publishRendezvous().catch(() => socket.destroy());
            continue;
          }
          const message = parseLine(line);
          connectionController.receive(message);
          if (message.kind === 'PAP_HELLO' || message.kind === 'PAP_STATE') {
            latestBrowserState = { ...structuredClone(message), browser: undefined, platform: undefined };
            delete latestBrowserState.browser; delete latestBrowserState.platform;
            if (message.kind === 'PAP_HELLO') pairedResolve();
          }
        }
      } catch { fail(); }
    });
    socket.once('close', () => {
      clearTimeout(authTimer);
      if (activeSocket === socket) activeSocket = null;
      if (controller === connectionController) controller = null;
      latestBrowserState = null;
      connectionController?.disconnect();
    });
  });

  try {
    await listen(server, selectedSocket);
    await chmod(selectedSocket, 0o600);
    await publishRendezvous();
    refreshTimer = setInterval(() => publishRendezvous().catch(() => {
      controller?.disconnect(); activeSocket?.destroy();
    }), RENDEZVOUS_LIFETIME_MS / 2);
    refreshTimer.unref();
  } catch (error) {
    session.close();
    try { await unlink(selectedSocket); } catch {}
    throw error;
  }

  return {
    adapter, session, runtimeEpoch, rendezvousPath, socketPath: selectedSocket,
    waitForPairing: () => paired,
    browserState: () => structuredClone(latestBrowserState),
    async close() {
      if (closed) return; closed = true; clearInterval(refreshTimer);
      activeSocket?.destroy(); controller?.disconnect(); controller = null;
      await session.drain(); session.close(); await stop(server);
      await publishTail;
      try { await unlink(selectedSocket); } catch {}
      try {
        const record = parseCanonical(await readFile(rendezvousPath), 16 * 1024);
        if (record.runtimeEpoch === runtimeEpoch) await unlink(rendezvousPath);
      } catch {}
    },
  };
}
