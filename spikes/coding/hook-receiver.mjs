import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonical, keys, pack, parseCanonical } from '../vault/format.mjs';
import { isUUID } from '../recipient/normal-observation.mjs';
import { HOOK_INPUT_LIMIT, HOOK_IPC_PROFILE, HOOK_RECEIVER_MS } from './protocol.mjs';

// Portable protocol driver for isolated fixtures. The packaged native receiver
// speaks the same bounded protocol directly, without a per-invocation runtime.
export function receiveHook({ client, installationId, socket, input, timeoutMs = HOOK_RECEIVER_MS }) {
  return new Promise(resolve => {
    let finished = false, bytes = 0, response = Buffer.alloc(0), stage = 'input', eventId;
    const chunks = [], invocationId = randomUUID();
    const finish = state => {
      if (finished) return;
      finished = true; clearTimeout(timer); input.off('data', data); input.pause();
      chunks.length = 0; socket.destroy(); resolve({ state });
    };
    const timer = setTimeout(() => finish('TIMEOUT'), Math.min(HOOK_RECEIVER_MS, timeoutMs));
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > HOOK_INPUT_LIMIT) finish('UNSUPPORTED');
      else chunks.push(Buffer.from(chunk));
    };
    socket.on('error', () => finish('UNAVAILABLE'));
    socket.once('close', () => finish('UNAVAILABLE'));
    input.once('error', () => finish('UNSUPPORTED'));
    input.on('data', data);
    input.once('end', () => {
      if (finished) return;
      try {
        if (!isUUID(installationId)) throw Error('INVALID_INSTALLATION');
        const input = pack(Buffer.concat(chunks)); chunks.length = 0;
        stage = 'admission';
        socket.write(`${canonical({ profile: HOOK_IPC_PROFILE, kind: 'ADMIT', client, installationId, invocationId, input })}\n`);
      } catch { finish('UNSUPPORTED'); }
    });
    socket.on('data', chunk => {
      if (finished || !['admission', 'release'].includes(stage)) return finish('UNAVAILABLE');
      response = Buffer.concat([response, chunk]);
      if (response.length > 1024) return finish('UNAVAILABLE');
      if (!response.includes(10)) return;
      try {
        const result = parseCanonical(response.subarray(0, response.indexOf(10)), 1024);
        keys(result, ['profile', 'state', 'eventId']);
        if (result.profile !== HOOK_IPC_PROFILE || !isUUID(result.eventId)
            || response.indexOf(10) !== response.length - 1) return finish('UNAVAILABLE');
        if (stage === 'release') return finish(result.state === 'RELEASED' && result.eventId === eventId ? 'ADMITTED' : 'UNAVAILABLE');
        if (result.state !== 'ADMITTED') return finish('UNAVAILABLE');
        // Release only an acknowledged admission. Timeout/disconnection before
        // this message leaves no durable backlog; the resident discards the copy.
        stage = 'release'; eventId = result.eventId; response = Buffer.alloc(0);
        // Wait for the resident's in-memory release acknowledgement before
        // destroying an inherited native descriptor. No durable work is awaited.
        socket.write(`${canonical({ profile: HOOK_IPC_PROFILE, kind: 'RELEASE', eventId })}\n`);
      } catch { finish('UNAVAILABLE'); }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const socket = new Socket({ fd: 3, readable: true, writable: true });
    receiveHook({ client: process.argv[2], installationId: process.argv[3], socket, input: process.stdin })
      .catch(() => {}).finally(() => process.exit(0));
  } catch { process.exit(0); }
}
