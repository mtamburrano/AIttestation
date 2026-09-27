import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { keys, parseCanonical } from '../../vault/format.mjs';

export function attestHookPeer(socket, enrollment, { validatorPath = join(dirname(process.execPath), 'provenance-hook-peer-validator') } = {}) {
  return new Promise((resolve, reject) => {
    const executables = enrollment.executables ?? [enrollment.executable];
    if (!Array.isArray(executables) || !executables.length || executables.length > (enrollment.client === 'codex' ? 4 : 1)
        || executables.some(value => !value)) return reject(Error('UNAUTHORIZED_HOOK_PEER'));
    const child = spawn(validatorPath, [enrollment.client, ...executables.flatMap(value => [value.path,
      value.script ? value.sha256 : value.codeHash ?? '-', value.interpreter?.path ?? '-', value.interpreter?.codeHash ?? '-'])],
      { env: {}, stdio: ['ignore', 'pipe', 'ignore', socket] });
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.off('close', closed);
      child.kill('SIGKILL'); error ? reject(Error('UNAUTHORIZED_HOOK_PEER')) : resolve(result);
    };
    const closed = () => finish(true), timer = setTimeout(closed, 120);
    socket.once('close', closed); child.once('error', closed);
    child.stdout.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 1024) closed(); });
    child.once('close', code => {
      if (code !== 0) return closed();
      try {
        const result = parseCanonical(bytes, 1024); keys(result, ['profile', 'client', 'origin']);
        if (result.profile !== 'pap-coding-peer/1' || result.client !== enrollment.client
            || result.origin !== 'enrolled-local-executable') return closed();
        finish(false, result);
      } catch { closed(); }
    });
  });
}

export function executableCodeIdentity(path, { validatorPath = join(dirname(process.execPath), 'provenance-hook-peer-validator') } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(validatorPath, ['--identity', path], { env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (value) => {
      if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL');
      value ? resolve(value) : reject(Error('CLIENT_CODE_IDENTITY_UNAVAILABLE'));
    };
    const timer = setTimeout(() => finish(), 10000);
    child.once('error', () => finish());
    child.stdout.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 1024) finish(); });
    child.once('close', code => {
      if (code !== 0) return finish();
      try {
        const result = parseCanonical(bytes, 1024); keys(result, ['profile', 'codeHash']);
        if (result.profile !== 'pap-coding-code-identity/1' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.codeHash)
            || result.codeHash.includes('\n')) return finish();
        finish(result.codeHash);
      } catch { finish(); }
    });
  });
}
