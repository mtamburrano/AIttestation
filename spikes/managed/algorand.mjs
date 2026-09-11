import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unb64 } from '../vault/format.mjs';
import { managedError } from './protocol.mjs';

export function algorandSponsor({ seedPath, expectedAddress,
  binary = fileURLToPath(new URL('../anchor/algorand/bin/sponsor', import.meta.url)) }) {
  if (!isAbsolute(seedPath) || !isAbsolute(binary) || !/^[A-Z2-7]{58}$/.test(expectedAddress)) throw Error('Explicit dedicated sponsor configuration required');
  const run = request => new Promise((resolve, reject) => {
    const child = execFile(binary, [seedPath, expectedAddress], { env: {}, timeout: 5000,
      maxBuffer: 4096, encoding: 'utf8', killSignal: 'SIGKILL' }, (error, stdout) => {
      if (error) { reject(managedError('SERVICE_UNAVAILABLE')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(managedError('SERVICE_UNAVAILABLE')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
  });
  return {
    prepare: payload => run({ action: 'prepare', payload: unb64(payload, 36).toString('base64'), signedTransaction: null }),
    broadcast: prepared => run({ action: 'broadcast', payload: null, signedTransaction: prepared.signedTransaction }),
  };
}
