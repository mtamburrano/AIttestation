import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { keys, parseCanonical } from '../../vault/format.mjs';

const MAX_PEER_RESULT_BYTES = 4 * 1024;
const PEER_VALIDATION_TIMEOUT_MS = 5_000;
export const NATIVE_PEER_VALIDATION_PROFILE = 'pap-native-peer-validation/1';
const bridgeError = message => Object.assign(Error(message), { code: 'UNSUPPORTED_PATH' });

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

