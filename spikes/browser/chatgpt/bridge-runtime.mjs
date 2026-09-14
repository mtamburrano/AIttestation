import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { getuid } from 'node:process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { canonical, keys, parseCanonical, unb64 } from '../../vault/format.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID } from './adapter.mjs';
import { ChromeBridgeController } from './bridge.mjs';
import { ChatGPTProtectionSession } from './session.mjs';
import { ResidentEngine } from './engine.mjs';
import { lockResidentEngine } from './engine-store.mjs';
import { NATIVE_BRIDGE_PROFILE, rendezvousRecord } from './native-host.mjs';
import { LocalDiagnostics, emit } from '../../release/diagnostics.mjs';

const MAX_LINE_BYTES = 512 * 1024;
const MAX_PEER_RESULT_BYTES = 4 * 1024;
const AUTH_TIMEOUT_MS = 2_000;
const HELLO_TIMEOUT_MS = 6_000;
const PEER_VALIDATION_TIMEOUT_MS = 5_000;
const RENDEZVOUS_LIFETIME_MS = 4 * 60_000;
export const NATIVE_PEER_VALIDATION_PROFILE = 'pap-native-peer-validation/1';

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
 * Duplicates the accepted Unix socket into a fixed-purpose native validator.
 * On macOS, LOCAL_PEERPID remains attached to the duplicated descriptor; the
 * helper checks the live relay -> signed browser host -> Google Chrome ancestry
 * before returning the browser/platform identity used by the adapter.
 */
export function attestNativePeer(socket, {
  validatorPath = join(dirname(process.execPath), 'provenance-bridge-peer-validator'),
} = {}) {
  return new Promise((resolvePeer, rejectPeer) => {
    let child;
    try {
      child = spawn(validatorPath, [], { env: {}, stdio: ['ignore', 'pipe', 'ignore', socket], windowsHide: true });
    } catch (cause) { rejectPeer(bridgeError(`Native peer validator unavailable: ${cause.message}`)); return; }
    let settled = false, size = 0; const chunks = [];
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.off('close', disconnected); callback(value);
    };
    const fail = message => {
      child.kill('SIGKILL'); finish(rejectPeer, bridgeError(message));
    };
    const disconnected = () => fail('Browser bridge peer disconnected during validation');
    const timer = setTimeout(() => fail('Native peer validation timed out'), PEER_VALIDATION_TIMEOUT_MS);
    socket.once('close', disconnected);
    child.once('error', () => fail('Native peer validator unavailable'));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_PEER_RESULT_BYTES) fail('Native peer validator exceeded its output limit');
      else chunks.push(Buffer.from(chunk));
    });
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) { finish(rejectPeer, bridgeError('Unauthorized browser bridge peer')); return; }
      try {
        const identity = parseCanonical(Buffer.concat(chunks), MAX_PEER_RESULT_BYTES);
        keys(identity, ['profile', 'browser', 'platform']);
        keys(identity.browser, ['product', 'channel', 'major']);
        keys(identity.platform, ['product', 'arch', 'version']);
        if (identity.profile !== NATIVE_PEER_VALIDATION_PROFILE) throw bridgeError('Invalid native peer identity');
        finish(resolvePeer, { browser: structuredClone(identity.browser), platform: structuredClone(identity.platform) });
      } catch { finish(rejectPeer, bridgeError('Invalid native peer identity')); }
    });
  });
}

/**
 * Owns the authenticated native rendezvous and composes the production chain:
 * Chrome native messaging -> controller -> adapter -> protected session.
 */
export async function startChromeProtectionRuntime(directory, {
  extensionId = CHATGPT_EXTENSION_ID, fastTrust, vault = null, vaultKey = null,
  collectFast, verifyFast, verifyArchive, managed = null, fault, controllerTimeoutMs = 5_000,
  rendezvousPath = join(directory, 'browser-bridge.json'), socketPath = null,
  now = Date.now, attestPeer = attestNativePeer, peerValidatorPath,
  diagnostics = new LocalDiagnostics(),
  openDashboard = null,
} = {}) {
  if (!isAbsolute(directory) || !/^[a-p]{32}$/.test(extensionId) || typeof attestPeer !== 'function') {
    throw bridgeError('Invalid browser bridge configuration');
  }
  await ownerDirectory(directory);
  const canonicalDirectory = await realpath(directory);
  if (resolve(rendezvousPath) !== rendezvousPath || dirname(rendezvousPath) !== canonicalDirectory) {
    throw bridgeError('Rendezvous must be an absolute file in the owner-only bridge directory');
  }
  const runtimeEpoch = randomUUID();
  const events = diagnostics.scope({ epochId: runtimeEpoch });
  const selectedSocket = socketPath ?? join(canonicalDirectory, `bridge-${runtimeEpoch.slice(0, 12)}.sock`);
  if (!isAbsolute(selectedSocket) || !resolve(selectedSocket).startsWith(`${canonicalDirectory}${sep}`)
      || Buffer.byteLength(selectedSocket) > 100) throw bridgeError('Unsafe or overlong browser bridge socket path');

  let controller = null, candidateSocket = null, activeSocket = null, latestBrowserState = null, closed = false, integrationDisabled = false;
  let currentToken = randomBytes(32), expiresAt = 0, refreshTimer, publishTail = Promise.resolve();
  let pairedResolve;
  const paired = new Promise(resolvePaired => { pairedResolve = resolvePaired; });
  const extensionOrigin = `chrome-extension://${extensionId}/`;
  const adapter = new ChatGPTChromeAdapter((command, diagnosticRefs) => {
    if (!controller) {
      const error = bridgeError('Authenticated Chrome bridge is disconnected'); error.exposure = 'NONE';
      return Promise.reject(error);
    }
    return controller.sendRelease(command, diagnosticRefs);
  }, { extensionId, diagnostics: events, runtimeEpoch });
  const unlock = lockResidentEngine(directory);
  let session, engine;
  try {
    session = await new ChatGPTProtectionSession(directory, adapter, {
      vault, vaultKey, fastTrust, managed, diagnostics: events,
      ...(collectFast === undefined ? {} : { collectFast }),
      ...(verifyFast === undefined ? {} : { verifyFast }),
      ...(verifyArchive === undefined ? {} : { verifyArchive }),
      ...(fault === undefined ? {} : { fault }),
    }).init();
    engine = await new ResidentEngine(directory, session, adapter, runtimeEpoch, events).init();
    engine.subscribe(() => controller?.publishCapturePolicy());
  } catch (error) { session?.close(); unlock(); throw error; }

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

  const server = createServer({ pauseOnConnect: true }, socket => {
    if (closed || integrationDisabled || candidateSocket || activeSocket) { socket.destroy(); return; }
    candidateSocket = socket;
    const connectionEvents = events.scope({ bridgeId: randomUUID() }), connectedAt = performance.now();
    emit(connectionEvents, 'BRIDGE_CONNECTED');
    let authenticated = false, peerIdentity = null, bytes = Buffer.alloc(0), connectionController = null;
    let authTimer;
    const fail = (code = 'BRIDGE_REJECTED') => { emit(connectionEvents, code); socket.destroy(); };
    socket.on('error', () => fail('BRIDGE_SOCKET_ERROR'));
    socket.once('end', () => fail('BRIDGE_PEER_EOF'));
    const receive = chunk => {
      try {
        bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
        if (bytes.length > MAX_LINE_BYTES * 2) return fail();
        for (;;) {
          const newline = bytes.indexOf(0x0a); if (newline < 0) break;
          const line = bytes.subarray(0, newline); bytes = bytes.subarray(newline + 1);
          if (!authenticated) {
            const auth = parseLine(line, true);
            keys(auth, ['kind', 'profile', 'extensionOrigin', 'runtimeEpoch', 'token']);
            const supplied = unb64(auth.token, 32);
            if (activeSocket || auth.kind !== 'PAP_BRIDGE_AUTH' || auth.profile !== NATIVE_BRIDGE_PROFILE
                || auth.extensionOrigin !== extensionOrigin || auth.runtimeEpoch !== runtimeEpoch
                || now() >= expiresAt || !timingSafeEqual(supplied, currentToken)) return fail();
            authenticated = true; clearTimeout(authTimer); candidateSocket = null; activeSocket = socket;
            authTimer = setTimeout(() => fail('BRIDGE_HELLO_TIMEOUT'), HELLO_TIMEOUT_MS);
            emit(connectionEvents, 'BRIDGE_AUTHENTICATED', { durationMs: performance.now() - connectedAt });
            connectionController = new ChromeBridgeController(adapter, message => {
              if (socket.destroyed) throw bridgeError('Browser bridge disconnected');
              socket.write(`${canonical(message)}\n`);
            }, { timeoutMs: controllerTimeoutMs, localBrowser: peerIdentity.browser,
              localPlatform: peerIdentity.platform, diagnostics: connectionEvents, engine, openDashboard });
            controller = connectionController;
            socket.write(`${canonical({ kind: 'PAP_BRIDGE_READY', profile: NATIVE_BRIDGE_PROFILE, runtimeEpoch })}\n`);
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
            if (message.kind === 'PAP_HELLO') { clearTimeout(authTimer); pairedResolve(); }
          }
        }
      } catch { fail(); }
    };
    socket.once('close', () => {
      emit(connectionEvents, 'BRIDGE_DISCONNECTED', { durationMs: performance.now() - connectedAt });
      clearTimeout(authTimer);
      if (candidateSocket === socket) candidateSocket = null;
      if (activeSocket === socket) activeSocket = null;
      if (connectionController && controller === connectionController) {
        controller = null; latestBrowserState = null; connectionController.disconnect();
      }
    });
    Promise.resolve().then(() => attestPeer(socket,
      peerValidatorPath === undefined ? {} : { validatorPath: peerValidatorPath })).then(identity => {
      keys(identity, ['browser', 'platform']);
      keys(identity.browser, ['product', 'channel', 'major']);
      keys(identity.platform, ['product', 'arch', 'version']);
      if (closed || socket.destroyed) return fail();
      peerIdentity = structuredClone(identity);
      authTimer = setTimeout(() => fail('BRIDGE_AUTH_TIMEOUT'), AUTH_TIMEOUT_MS);
      socket.on('data', receive); socket.resume();
    }).catch(() => fail('BRIDGE_PEER_REJECTED'));
  });

  try {
    await listen(server, selectedSocket);
    await chmod(selectedSocket, 0o600);
    await publishRendezvous();
    emit(events, 'BRIDGE_LISTENING');
    refreshTimer = setInterval(() => publishRendezvous().catch(() => {
      controller?.disconnect(); activeSocket?.destroy();
    }), RENDEZVOUS_LIFETIME_MS / 2);
    refreshTimer.unref();
  } catch (error) {
    emit(events, 'BRIDGE_LISTEN_FAILED');
    engine.stop(); await engine.drain(); session.close(); unlock();
    try { await unlink(selectedSocket); } catch {}
    throw error;
  }

  return {
    adapter, session, engine, diagnostics, runtimeEpoch, rendezvousPath, socketPath: selectedSocket,
    waitForPairing: () => paired,
    browserState: () => structuredClone(latestBrowserState),
    disableIntegration() {
      integrationDisabled = true; adapter.invalidate('integration removed');
      candidateSocket?.destroy(); activeSocket?.destroy(); controller?.disconnect(); latestBrowserState = null;
    },
    async close() {
      if (closed) return; closed = true; clearInterval(refreshTimer);
      engine.stop();
      candidateSocket?.destroy(); activeSocket?.destroy(); controller?.disconnect(); controller = null;
      await engine.drain(); await session.drain(); session.close(); await stop(server);
      await publishTail;
      try { await unlink(selectedSocket); } catch {}
      try {
        const record = parseCanonical(await readFile(rendezvousPath), 16 * 1024);
        if (record.runtimeEpoch === runtimeEpoch) await unlink(rendezvousPath);
      } catch {}
      unlock();
    },
  };
}
