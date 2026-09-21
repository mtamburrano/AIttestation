import { spawn } from 'node:child_process';

let active = 0;

// Interactive callers share a hard process limit. Offline callers may keep
// their synchronous verifier; neither path trusts a child verdict implicitly.
export function runNativeVerifier(binary, { input, timeout, maxBuffer }) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 16 * 1024 * 1024
      || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000
      || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 128 * 1024) {
    return Promise.resolve({ error: Error('Invalid verifier resource bounds') });
  }
  if (active >= 2) return Promise.resolve({ error: Object.assign(Error('Verifier busy'), { code: 'VERIFIER_BUSY' }) });
  active++;
  return new Promise(resolve => {
    let child, timer, error, size = 0, settled = false;
    const stdout = [];
    const finish = status => {
      if (settled) return;
      settled = true; clearTimeout(timer); active--;
      resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), ...(error ? { error } : {}) });
    };
    const stop = cause => { error ??= cause; child.kill('SIGKILL'); };
    try { child = spawn(binary, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (cause) { error = cause; finish(null); return; }
    timer = setTimeout(() => stop(Error('Verifier timeout')), timeout);
    child.once('error', cause => { error ??= cause; });
    child.once('close', finish);
    const count = chunk => {
      size += chunk.length;
      if (size > maxBuffer) { stop(Error('Verifier output limit')); return false; }
      return !error;
    };
    child.stdout.on('data', chunk => { if (count(chunk)) stdout.push(Buffer.from(chunk)); });
    child.stderr.on('data', count);
    child.stdin.on('error', stop);
    try { child.stdin.end(input); } catch (cause) { stop(cause); }
  });
}
