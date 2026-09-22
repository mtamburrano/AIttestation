import { copyFile, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./native/signing-access.m', import.meta.url));
const reasons = new Set(['INVALID_SELECTION', 'INTERACTION_GUARD_UNAVAILABLE', 'KEYCHAIN_UNAVAILABLE',
  'KEYCHAIN_LOCKED', 'IDENTITY_UNAVAILABLE', 'IDENTITY_AMBIGUOUS', 'ACCESS_UNAVAILABLE',
  'CODESIGN_AUTHORIZATION_REQUIRED', 'PARTITION_AUTHORIZATION_REQUIRED']);
export const ownerAction = reason => ({ status: 'OWNER_ACTION_REQUIRED', reason });
const execute = (command, args, timeout = 15000, temporaryDirectory) => execFileSync(command, args, {
  env: { PATH: '/usr/bin:/bin', ...(temporaryDirectory ? { TMPDIR: temporaryDirectory } : {}) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  timeout, killSignal: 'SIGKILL', maxBuffer: 65536,
});

export function inspectSigningAccess(helper, config, run = execute) {
  let output, failed = false;
  try { output = run(helper, [config.signingIdentity, config.signingKeychain]); }
  catch (error) {
    failed = true;
    if (error.code === 'ETIMEDOUT') return ownerAction('PREFLIGHT_TIMED_OUT');
    output = error.stdout;
  }
  const label = typeof output === 'string' && output.trim();
  if (!failed && label === 'AUTHORIZED') return { status: 'AUTHORIZED' };
  return ownerAction(reasons.has(label) ? label : 'PREFLIGHT_UNAVAILABLE');
}

export async function withSigningAccess(config, operation, run = execute) {
  if (!config.signingKeychain) return ownerAction('KEYCHAIN_SELECTION_REQUIRED');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return ownerAction('APPLE_SILICON_MAC_REQUIRED');
  try {
    const info = await lstat(config.signingKeychain);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
        || (info.mode & 0o077) || await realpath(config.signingKeychain) !== config.signingKeychain) {
      return ownerAction('KEYCHAIN_UNAVAILABLE');
    }
  } catch { return ownerAction('KEYCHAIN_UNAVAILABLE'); }
  const work = await realpath(await mkdtemp('/private/tmp/attestamp-signing-preflight-'));
  try {
    const helper = join(work, 'signing-access');
    try {
      run('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-Wno-deprecated-declarations',
        '-framework', 'Foundation', '-framework', 'Security', source, '-o', helper], 60000, work);
    } catch { return ownerAction('PREFLIGHT_UNAVAILABLE'); }
    const inspect = () => inspectSigningAccess(helper, config, run);
    const access = inspect();
    if (access.status !== 'AUTHORIZED') return access;
    const probe = join(work, 'signing-probe');
    await copyFile('/usr/bin/true', probe);
    try {
      run('/usr/bin/codesign', ['--force', '--sign', config.signingIdentity,
        '--keychain', config.signingKeychain, '--timestamp=none', '--dryrun', probe]);
    } catch (error) {
      return ownerAction(error.code === 'ETIMEDOUT' ? 'SIGNING_PROBE_TIMED_OUT' : 'SIGNING_PROBE_FAILED');
    }
    return await operation(inspect);
  } finally { await rm(work, { recursive: true, force: true }); }
}

export async function preflightSigning(config) {
  return withSigningAccess(config, async () => ({ status: 'READY' }));
}
