import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, keys, parseCanonical } from '../vault/format.mjs';
import { isUUID } from '../recipient/normal-observation.mjs';
import { atomicWrite, readOwned } from '../distribution/files.mjs';
import { CodingAdmission } from './admission.mjs';
import { HOOK_IPC_PROFILE, HOOK_INPUT_LIMIT } from './protocol.mjs';

export async function startCodingRuntime({ directory, engine, sources, runtimeEpoch, integrations, attestPeer }) {
  if (typeof attestPeer !== 'function') throw Error('EXPLICIT_HOOK_PEER_VALIDATION_REQUIRED');
  const path = join(directory, `hook-${runtimeEpoch.slice(0, 12)}.sock`), rendezvous = join(directory, 'coding-bridge.json');
  if (Buffer.byteLength(path) > 100) throw Error('HOOK_SOCKET_PATH_LIMIT');
  const sockets = new Set(), peers = new Map(), sessions = new Map(); let closed = false;
  const server = createServer(socket => {
    if (closed || sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    const authority = engine.beginAdmission();
    if (!authority) { sockets.delete(socket); socket.destroy(); return; }
    let buffer = Buffer.alloc(0), stage = 'hello', channel, eventId;
    const started = performance.now();
    const timer = setTimeout(() => socket.destroy(), 160);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { clearTimeout(timer); if (eventId) channel?.cancelAdmission(eventId); sockets.delete(socket); });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > HOOK_INPUT_LIMIT + 2048) { socket.destroy(); return; }
      const index = buffer.indexOf(10); if (index < 0) return;
      const line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
      try {
        const message = parseCanonical(line, HOOK_INPUT_LIMIT + 2048);
        if (stage === 'admitted') {
          keys(message, ['profile', 'kind', 'eventId']);
          if (message.profile !== HOOK_IPC_PROFILE || message.kind !== 'RELEASE' || message.eventId !== eventId
              || buffer.length || performance.now() - started >= 160) throw Error('INVALID_RELEASE');
          if (!channel.releaseAdmission(eventId)) throw Error('INVALID_RELEASE');
          stage = 'released';
          socket.end(`${canonical({ profile: HOOK_IPC_PROFILE, state: 'RELEASED', eventId })}\n`); return;
        }
        if (stage !== 'hello' || buffer.length) throw Error('INVALID_HOOK_MESSAGE');
        keys(message, ['profile', 'kind', 'client', 'installationId', 'invocationId', 'payload']);
        if (message.profile !== HOOK_IPC_PROFILE || message.kind !== 'ADMIT' || !isUUID(message.invocationId)) throw Error('INVALID_HOOK_MESSAGE');
        const enrollment = integrations.enrollment(message.client, message.installationId);
        if (!enrollment) throw Error('UNKNOWN_HOOK_INSTALLATION');
        stage = 'authenticating';
        Promise.resolve(attestPeer(socket, enrollment)).then(identity => {
          if (socket.destroyed || closed || performance.now() - started >= 150 || integrations.enrollment(message.client, message.installationId)?.operationId !== enrollment.operationId) return socket.destroy();
          if (identity.client !== enrollment.client || !['enrolled-local-executable', 'vendor-signed-process'].includes(identity.origin)) return socket.destroy();
          const key = `${message.client}:${message.installationId}`;
          let peer = peers.get(key);
          if (!peer) {
            if (peers.size >= 4) return socket.destroy();
            const boundary = new CodingAdmission({ integrationId: message.client, installationId: message.installationId, runtimeEpoch, origin: identity.origin });
            peer = sources.attach({ integrationId: message.client, installationId: message.installationId, boundary, notify: false });
            peers.set(key, peer);
          }
          const sessionKey = `${key}:${message.payload.sessionId}`;
          if (!sessions.has(sessionKey)) {
            if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
            sessions.set(sessionKey, randomUUID());
          }
          channel = engine.captureChannel(peer);
          const result = channel.admit({ ...message.payload, invocationId: message.invocationId, scope: sessions.get(sessionKey) }, { deadline: started + 150, authority });
          eventId = result.eventId; stage = 'admitted';
          socket.write(`${canonical({ profile: HOOK_IPC_PROFILE, ...result })}\n`);
          // Node pauses a Socket passed as child stdio. Resume only after the
          // native validator exits so the receiver's RELEASE can be consumed.
          socket.resume();
        }).catch(() => socket.destroy());
      } catch { socket.destroy(); }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
    await chmod(path, 0o600);
    await atomicWrite(rendezvous, canonical({ profile: 'pap-hook-rendezvous/1', socketPath: path, runtimeEpoch }));
  } catch (error) { for (const socket of sockets) socket.destroy(); server.close(); await unlink(path).catch(() => {}); throw error; }
  return { async close() {
    if (closed) return; closed = true;
    for (const socket of sockets) socket.destroy();
    for (const peer of peers.values()) sources.detach(peer);
    await new Promise(resolve => server.close(resolve));
    const current = await readOwned(rendezvous);
    if (current && parseCanonical(current).runtimeEpoch === runtimeEpoch) await unlink(rendezvous);
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}
