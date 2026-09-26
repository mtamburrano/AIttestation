import { createServer } from 'node:net';
import { getuid } from 'node:process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { canonical, keys, parseCanonical, unb64 } from '../../vault/format.mjs';
import { ChatGPTFirefoxAdapter } from '../firefox/adapter.mjs';
import { FIREFOX_EXTENSION_ID } from '../shared/profiles.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID, CHATGPT_ADAPTER_PROFILE } from './adapter.mjs';
import { ChromeBridgeController } from './bridge.mjs';
import { startRecordingCore } from '../../core/runtime.mjs';
import { SourceRegistry } from '../../core/source-registry.mjs';
import { ChatGPTCaptureAdmission } from './admission.mjs';
import { browserControl } from './control.mjs';
import { ChatGPTRecordingSession } from './session.mjs';
import { EngineStateStore, lockResidentEngine } from './engine-store.mjs';
import { NATIVE_BRIDGE_PROFILE, FIREFOX_NATIVE_BRIDGE_PROFILE, rendezvousRecord } from './native-host.mjs';
import { LocalDiagnostics, emit } from '../../diagnostics/local.mjs';

const MAX_LINE_BYTES = 512 * 1024;
const AUTH_TIMEOUT_MS = 2_000;
const HELLO_TIMEOUT_MS = 6_000;
const RENDEZVOUS_LIFETIME_MS = 4 * 60_000;
import { attestNativePeer } from '../../platform/macos/peer-validation.mjs';
export { attestNativePeer, NATIVE_PEER_VALIDATION_PROFILE } from '../../platform/macos/peer-validation.mjs';

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
 * Chrome native messaging -> controller -> adapter -> recording session.
 */
export async function startChromeRecordingRuntime(directory, {
  extensionId = CHATGPT_EXTENSION_ID, firefoxExtensionId = FIREFOX_EXTENSION_ID, fastTrust, vault = null, vaultKey = null,
  collectFast, verifyFast, verifyArchive, managed = null, fault, controllerTimeoutMs = 5_000,
  rendezvousPath = join(directory, 'browser-bridge.json'), socketPath = null,
  now = Date.now, attestPeer = attestNativePeer, peerValidatorPath,
  diagnostics = new LocalDiagnostics(),
  openDashboard = null,
  integrationEnabled = true,
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

  const connections = new Map();
  let closed = false, integrationDisabled = !integrationEnabled;
  let refreshTimer, publishTail = Promise.resolve();
  const browserTokens = new Map();
  let pairedResolve;
  const paired = new Promise(resolvePaired => { pairedResolve = resolvePaired; });
  const extensionOrigin = `chrome-extension://${extensionId}/`;
  const firefoxOrigin = `firefox-extension:${firefoxExtensionId}`;
  const firefoxRendezvousPath = join(directory, 'firefox-bridge.json');
  const browserDefinitions = new Map([
    [extensionOrigin, { profile: NATIVE_BRIDGE_PROFILE, product: 'Google Chrome', integrationId: 'chrome-chatgpt', id: extensionId, path: rendezvousPath, Adapter: ChatGPTChromeAdapter }],
    [firefoxOrigin, { profile: FIREFOX_NATIVE_BRIDGE_PROFILE, product: 'Firefox', integrationId: 'firefox-chatgpt', id: firefoxExtensionId, path: firefoxRendezvousPath, Adapter: ChatGPTFirefoxAdapter }],
  ]);
  const adapter = new ChatGPTChromeAdapter({ extensionId, diagnostics: events, runtimeEpoch });
  const sources = new SourceRegistry(new ChatGPTCaptureAdmission(adapter, runtimeEpoch));
  let initialChromePeer = sources.primary;
  const core = await startRecordingCore({ directory, sources, runtimeEpoch, diagnostics: events,
    createSession: options => new ChatGPTRecordingSession(directory, adapter, options),
    platform: { lock: lockResidentEngine, stateStore: (path, selectedVault) => new EngineStateStore(path, selectedVault) },
    integrations: [
      { id: 'chrome-chatgpt', previouslyEnabled: true, supported: true },
      { id: 'codex', previouslyEnabled: false, supported: true },
      { id: 'claude-code', previouslyEnabled: false, supported: true },
      { id: 'firefox-chatgpt', previouslyEnabled: false, supported: true },
    ],
    vault, vaultKey, fastTrust, managed,
    ...(collectFast === undefined ? {} : { collectFast }),
    ...(verifyFast === undefined ? {} : { verifyFast }),
    ...(verifyArchive === undefined ? {} : { verifyArchive }),
    ...(fault === undefined ? {} : { fault }),
  });
  const { session } = core, engine = browserControl(core.engine, adapter);
  engine.subscribe(() => {
    for (const connection of connections.values()) connection.controller?.publishCapturePolicy();
  });

  const publishRendezvous = origin => {
    const operation = publishTail.then(async () => {
      if (closed) return;
      for (const [selectedOrigin, definition] of browserDefinitions) {
        if (origin && selectedOrigin !== origin) continue;
        const token = randomBytes(32), expiresAt = now() + RENDEZVOUS_LIFETIME_MS;
        browserTokens.set(selectedOrigin, { token, expiresAt });
        await atomicOwnerWrite(definition.path, rendezvousRecord({ profile: definition.profile,
          extensionOrigin: selectedOrigin, socketPath: selectedSocket, runtimeEpoch,
          expiresAt: new Date(expiresAt).toISOString(), token }));
      }
    });
    publishTail = operation.catch(() => {});
    return operation;
  };

  const server = createServer({ pauseOnConnect: true }, socket => {
    if (closed || connections.size >= 8) { socket.destroy(); return; }
    const connection = { controller: null, source: null, state: null };
    connections.set(socket, connection);
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
            const supplied = unb64(auth.token, 32), definition = browserDefinitions.get(auth.extensionOrigin);
            const credentials = browserTokens.get(auth.extensionOrigin);
            if (!definition || definition.product !== peerIdentity.browser.product || !credentials
                || definition.integrationId === 'chrome-chatgpt' && integrationDisabled
                || auth.kind !== 'PAP_BRIDGE_AUTH' || auth.profile !== definition.profile
                || auth.runtimeEpoch !== runtimeEpoch || now() >= credentials.expiresAt
                || !timingSafeEqual(supplied, credentials.token)) return fail();
            authenticated = true; clearTimeout(authTimer); browserTokens.delete(auth.extensionOrigin);
            connection.integrationId = definition.integrationId;
            authTimer = setTimeout(() => fail('BRIDGE_HELLO_TIMEOUT'), HELLO_TIMEOUT_MS);
            emit(connectionEvents, 'BRIDGE_AUTHENTICATED', { durationMs: performance.now() - connectedAt });
            const useInitial = definition.integrationId === 'chrome-chatgpt' && initialChromePeer;
            const soleChrome = definition.integrationId === 'chrome-chatgpt' && ![...connections.values()].some(value => value.controller && value.integrationId === 'chrome-chatgpt');
            const peerAdapter = useInitial || soleChrome ? adapter : new definition.Adapter({ extensionId: definition.id, diagnostics: connectionEvents, runtimeEpoch });
            connection.source = useInitial ? initialChromePeer : sources.attach({
              integrationId: definition.integrationId, installationId: definition.id,
              boundary: new ChatGPTCaptureAdmission(peerAdapter, runtimeEpoch),
            });
            if (useInitial) initialChromePeer = null;
            const capture = engine.captureChannel(connection.source);
            connectionController = new ChromeBridgeController(peerAdapter, message => {
              if (socket.destroyed) throw bridgeError('Browser bridge disconnected');
              const body = `${canonical(message)}\n`;
              if (socket.writableLength + Buffer.byteLength(body) > MAX_LINE_BYTES * 2) {
                socket.destroy(); throw bridgeError('Browser bridge output limit exceeded');
              }
              socket.write(body);
            }, { timeoutMs: controllerTimeoutMs, localBrowser: peerIdentity.browser,
              localPlatform: peerIdentity.platform, diagnostics: connectionEvents,
              engine: { ...browserControl(core.engine, peerAdapter), ...capture }, openDashboard });
            connection.controller = connectionController;
            socket.write(`${canonical({ kind: 'PAP_BRIDGE_READY', profile: definition.profile, runtimeEpoch })}\n`);
            // Consume the just-used token. A replacement is published for an
            // independently authenticated peer or reconnect.
            publishRendezvous(auth.extensionOrigin).catch(() => socket.destroy());
            continue;
          }
          const message = parseLine(line);
          connectionController.receive(message);
          if (message.kind === 'PAP_HELLO' || message.kind === 'PAP_STATE') {
            connection.state = { ...structuredClone(message), browser: undefined, platform: undefined };
            delete connection.state.browser; delete connection.state.platform;
            if (message.kind === 'PAP_HELLO') { clearTimeout(authTimer); pairedResolve(); }
          }
        }
      } catch { fail(); }
    };
    socket.once('close', () => {
      emit(connectionEvents, 'BRIDGE_DISCONNECTED', { durationMs: performance.now() - connectedAt });
      clearTimeout(authTimer);
      connectionController?.disconnect();
      if (connection.source) sources.detach(connection.source);
      connections.delete(socket);
    });
    Promise.resolve().then(() => attestPeer(socket,
      peerValidatorPath === undefined ? {} : { validatorPath: peerValidatorPath })).then(identity => {
      keys(identity, ['browser', 'platform']);
      keys(identity.browser, ['product', 'channel', 'major']);
      keys(identity.platform, ['product', 'arch', 'version']);
      if (closed || identity?.browser?.product === 'Google Chrome' && integrationDisabled || socket.destroyed) return fail();
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
      for (const [socket, peer] of connections) { peer.controller?.disconnect(); socket.destroy(); }
    }), RENDEZVOUS_LIFETIME_MS / 2);
    refreshTimer.unref();
  } catch (error) {
    emit(events, 'BRIDGE_LISTEN_FAILED');
    await core.close();
    try { await unlink(selectedSocket); } catch {}
    throw error;
  }

  return {
    adapter, session, engine, coreEngine: core.engine, sources, diagnostics, runtimeEpoch, rendezvousPath, firefoxRendezvousPath, socketPath: selectedSocket,
    waitForPairing: () => paired,
    browserState: () => structuredClone([...connections.values()].find(peer => peer.integrationId === 'chrome-chatgpt' && peer.state)?.state ?? null),
    browserStates: () => [...connections.values()].filter(peer => peer.state).map(peer => structuredClone(peer.state)),
    disableIntegration() {
      integrationDisabled = true; adapter.disconnect();
      for (const [socket, peer] of connections) {
        if (peer.integrationId !== 'chrome-chatgpt') continue;
        peer.controller?.disconnect(); if (peer.source) sources.detach(peer.source);
        peer.state = null; socket.destroy();
      }
    },
    async enableIntegration() {
      if (closed) throw Error('ENGINE_UNAVAILABLE');
      await publishRendezvous(); integrationDisabled = false;
    },
    async close() {
      if (closed) return; closed = true; clearInterval(refreshTimer);
      engine.stop();
      for (const [socket, peer] of connections) { peer.controller?.disconnect(); socket.destroy(); }
      await stop(server);
      await publishTail;
      try { await unlink(selectedSocket); } catch {}
      for (const path of [rendezvousPath, firefoxRendezvousPath]) try {
        const record = parseCanonical(await readFile(path), 16 * 1024);
        if (record.runtimeEpoch === runtimeEpoch) await unlink(path);
      } catch {}
      await core.close();
    },
  };
}
