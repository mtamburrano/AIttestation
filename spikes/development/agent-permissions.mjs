import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = fileURLToPath(new URL('native/agent-permissions.m', import.meta.url));
const run = (tool, args, timeout) => execFileSync(tool, args, { env: { PATH: '/usr/bin:/bin' },
  encoding: 'utf8', stdio: 'pipe', timeout, killSignal: 'SIGKILL', maxBuffer: 65536 });

export async function agentPermissions(paths, execute = run) {
  let work;
  try {
    work = await mkdtemp(join(paths.root, 'permissions-'));
    const helper = join(work, 'readiness');
    execute('/usr/bin/xcrun', ['clang', '-framework', 'ApplicationServices', '-framework', 'CoreGraphics', source, '-o', helper], 30000);
    let output, failed = false;
    try { output = execute(helper, [], 3000); }
    catch (error) { failed = true; output = error.stdout; }
    const label = typeof output === 'string' && output.length < 256 ? output.trim() : null;
    return (!failed || label !== 'READY') && ['READY', 'ACCESSIBILITY_PERMISSION_REQUIRED', 'SCREEN_RECORDING_PERMISSION_REQUIRED'].includes(label)
      ? label : 'AUTOMATION_PERMISSION_CHECK_UNAVAILABLE';
  } catch { return 'AUTOMATION_PERMISSION_CHECK_UNAVAILABLE'; }
  finally { if (work) await rm(work, { recursive: true, force: true }); }
}
