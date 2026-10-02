import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2), report = { profile: 'attestamp-bootstrap/1', status: 'PASS', checks: [] };
const temporary = await mkdtemp(join(tmpdir(), 'attestamp-bootstrap-test-'));
try {
  if (args.length > 1 || args.length && args[0] !== '--clean') throw Error('INVALID_OPTIONS');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 13) throw Error('NODE_22_13_REQUIRED');
  await mkdir(join(temporary, 'home'));
  const env = { PATH: '/usr/bin:/bin', HOME: join(temporary, 'home'), TMPDIR: temporary,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
  let cwd = source;
  const run = (name, exe, command) => {
    const result = spawnSync(exe, command, { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    const passed = result.status === 0 && !result.error;
    report.checks.push({ name, status: passed ? 'PASS' : 'FAIL', ...(name === 'smoke' ? {
      tests: Number(/^# tests (\d+)$/m.exec(result.stdout ?? '')?.[1] ?? 0) } : {}) });
    if (!passed) throw Error(name);
  };
  if (args[0] === '--clean') {
    run('clean-clone', '/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--local', '--no-hardlinks', source, join(temporary, 'checkout')]);
    cwd = join(temporary, 'checkout');
  }
  run('hygiene', process.execPath, ['spikes/development/repository-hygiene.mjs']);
  run('smoke', process.execPath, ['--test', 'test/core-sources.test.mjs', 'test/coding-discovery.test.mjs', 'test/coding-dashboard.test.mjs', 'test/repository-hygiene.test.mjs']);
} catch (error) { report.status = 'FAIL'; report.failedCheck = /^[a-zA-Z0-9_-]+$/.test(error.message) ? error.message : 'BOOTSTRAP_FAILED'; }
finally { await rm(temporary, { recursive: true, force: true }); }
process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = report.status === 'PASS' ? 0 : 1;
