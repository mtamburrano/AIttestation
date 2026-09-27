import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, keys, parseCanonical, unpack } from '../vault/format.mjs';
import { isUUID } from '../recipient/normal-observation.mjs';
import { atomicWrite, readOwned } from '../distribution/files.mjs';
import { CodingAdmission } from './admission.mjs';
import { HOOK_IPC_PROFILE, HOOK_INPUT_LIMIT, HOOK_WIRE_LIMIT, decodeHook } from './protocol.mjs';
import { HookHealth } from './health.mjs';

export async function startCodingRuntime({ directory, engine, sources, runtimeEpoch, integrations, attestPeer }) {
  if (typeof attestPeer !== 'function') throw Error('EXPLICIT_HOOK_PEER_VALIDATION_REQUIRED');
  const path = join(directory, `hook-${runtimeEpoch.slice(0, 12)}.sock`), rendezvous = join(directory, 'coding-bridge.json');
  if (Buffer.byteLength(path) > 100) throw Error('HOOK_SOCKET_PATH_LIMIT');
  const sockets = new Map(), peers = new Map(), sessions = new Map(); let closed = false;
  const health = integrations.health ?? new HookHealth();
  const retire = () => {
    for (const [key, entry] of peers) {
      if (integrations.enrollment(entry.peer.integrationId, entry.peer.installationId)?.operationId === entry.operationId) continue;
      peers.delete(key); sources.detach(entry.peer);
      for (const [id, session] of sessions) if (session.owner === key) sessions.delete(id);
    }
    for (const [socket, attempt] of sockets) if (attempt.enrollment
        && integrations.enrollment(attempt.client, attempt.installationId)?.operationId !== attempt.enrollment.operationId) {
      attempt.reject('ENROLLMENT_CHANGED'); socket.destroy();
    }
  };
  const unsubscribe = integrations.onChange?.(retire);
  const server = createServer(socket => {
    if (closed || sockets.size >= 16) { health.record('unknown', 'BUSY'); health.flushLater(); socket.destroy(); return; }
    const authority = engine.beginAdmission();
    const unavailable = authority ? null : engine.admissionAvailability();
    const attempt = { client: 'unknown', enrollment: null, authenticated: false };
    sockets.set(socket, attempt);
    let buffer = Buffer.alloc(0), stage = 'hello', channel, eventId;
    const started = performance.now();
    const reject = reason => {
      if (stage === 'rejected' || stage === 'released') return;
      health.record(attempt.client, reason, attempt.authenticated); stage = 'rejected';
      if (eventId) channel?.cancelAdmission(eventId);
      socket.destroy();
    };
    attempt.reject = reject;
    const timer = setTimeout(() => reject('EXPIRED'), 160);
    socket.on('error', () => reject('UNAVAILABLE'));
    socket.once('close', () => {
      clearTimeout(timer);
      if (stage !== 'rejected' && stage !== 'released') reject('CANCELLED');
      sockets.delete(socket); health.flushLater();
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > HOOK_WIRE_LIMIT) { reject('UNSUPPORTED'); return; }
      const index = buffer.indexOf(10); if (index < 0) return;
      const line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
      try {
        const message = parseCanonical(line, HOOK_WIRE_LIMIT);
        if (stage === 'admitted') {
          keys(message, ['profile', 'kind', 'eventId']);
          if (message.profile !== HOOK_IPC_PROFILE || message.kind !== 'RELEASE' || message.eventId !== eventId
              || buffer.length || performance.now() - started >= 160) throw Error('INVALID_RELEASE');
          if (!channel.releaseAdmission(eventId)) throw Error('INVALID_RELEASE');
          stage = 'released'; health.record(attempt.client, 'RELEASED');
          socket.end(`${canonical({ profile: HOOK_IPC_PROFILE, state: 'RELEASED', eventId })}\n`); return;
        }
        if (stage !== 'hello' || buffer.length) throw Error('INVALID_HOOK_MESSAGE');
        keys(message, ['profile', 'kind', 'client', 'installationId', 'invocationId', 'input']);
        if (message.profile !== HOOK_IPC_PROFILE || message.kind !== 'ADMIT' || !isUUID(message.invocationId)) throw Error('INVALID_HOOK_MESSAGE');
        attempt.client = ['codex', 'claude-code'].includes(message.client) ? message.client : 'unknown';
        health.record(attempt.client, 'RECEIVED');
        const enrollment = integrations.enrollment(message.client, message.installationId);
        if (!enrollment) return reject('UNKNOWN_INSTALLATION');
        attempt.enrollment = enrollment; attempt.installationId = message.installationId;
        if (!authority) return reject(unavailable);
        stage = 'authenticating';
        Promise.resolve().then(() => attestPeer(socket, enrollment)).then(identity => {
          if (socket.destroyed || closed) return;
          if (performance.now() - started >= 150) return reject('EXPIRED');
          if (integrations.enrollment(message.client, message.installationId)?.operationId !== enrollment.operationId) return reject('ENROLLMENT_CHANGED');
          if (identity.client !== enrollment.client || !['enrolled-local-executable', 'vendor-signed-process'].includes(identity.origin)) return reject('AUTH_REJECTED');
          stage = 'authenticated'; attempt.authenticated = true; health.record(attempt.client, 'AUTHENTICATED');
          const payload = decodeHook(message.client, unpack(message.input, HOOK_INPUT_LIMIT));
          const key = `${message.client}:${message.installationId}`;
          let entry = peers.get(key);
          if (!entry) {
            if (peers.size >= 4) return reject('PEER_LIMIT');
            const boundary = new CodingAdmission({ integrationId: message.client, installationId: message.installationId, runtimeEpoch, origin: identity.origin });
            const peer = sources.attach({ integrationId: message.client, installationId: message.installationId, boundary, notify: false });
            entry = { peer, operationId: enrollment.operationId }; peers.set(key, entry);
          }
          const sessionKey = `${key}:${payload.sessionId}`;
          if (!sessions.has(sessionKey)) {
            if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
            sessions.set(sessionKey, { owner: key, scope: randomUUID() });
          }
          channel = engine.captureChannel(entry.peer);
          const result = channel.admit({ ...payload, invocationId: message.invocationId, scope: sessions.get(sessionKey).scope }, { deadline: started + 150, authority });
          eventId = result.eventId; stage = 'admitted'; health.record(attempt.client, 'ADMITTED');
          socket.write(`${canonical({ profile: HOOK_IPC_PROFILE, ...result })}\n`);
          // Node pauses a Socket passed as child stdio. Resume only after the
          // native validator exits so the receiver's RELEASE can be consumed.
          socket.resume();
        }).catch(error => reject(stage === 'authenticating' ? 'AUTH_REJECTED'
          : error?.message === 'ADMISSION_BUSY' ? 'BUSY' : error?.message === 'CAPTURE_NOT_ENABLED' ? 'DISABLED'
            : error?.message === 'ADMISSION_EXPIRED' ? 'EXPIRED' : error?.message === 'SOURCE_PEER_LIMIT' ? 'PEER_LIMIT' : 'UNSUPPORTED'));
      } catch { reject('UNSUPPORTED'); }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
    await chmod(path, 0o600);
    await atomicWrite(rendezvous, canonical({ profile: 'pap-hook-rendezvous/1', socketPath: path, runtimeEpoch }));
  } catch (error) { unsubscribe?.(); for (const socket of sockets.keys()) socket.destroy(); server.close(); await unlink(path).catch(() => {}); throw error; }
  return { health, async close() {
    if (closed) return; closed = true;
    unsubscribe?.();
    for (const socket of sockets.keys()) socket.destroy();
    for (const { peer } of peers.values()) sources.detach(peer);
    peers.clear(); sessions.clear();
    await new Promise(resolve => server.close(resolve));
    const current = await readOwned(rendezvous);
    if (current && parseCanonical(current).runtimeEpoch === runtimeEpoch) await unlink(rendezvous);
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}
