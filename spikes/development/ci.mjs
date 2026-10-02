import { mkdtemp, mkdir, rm, writeFile, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const lane = process.argv[2], root = fileURLToPath(new URL('../../', import.meta.url));
if (!['portable', 'macos'].includes(lane) || ![3, 4].includes(process.argv.length)) throw Error('SELECT_PORTABLE_OR_MACOS');
const output = process.argv[3] ? resolve(process.argv[3]) : join(root, 'artifacts', `ci-${lane}`), home = await realpath(await mkdtemp(join(tmpdir(), 'attestamp-ci-home-test-')));
const report = { profile: 'attestamp-ci/1', lane, status: 'PASS', checks: [], externalEvidence: 'NOT_TESTED' };
try {
  await mkdir(join(root, 'artifacts'), { recursive: true }); await mkdir(output, { mode: 0o700 });
  const commands = lane === 'portable' ? [
    ['bootstrap', ['spikes/development/bootstrap.mjs']],
    ['clean-clone', ['spikes/development/bootstrap.mjs', '--clean']],
    ['dependencies', ['spikes/development/dependency-report.mjs', join(output, 'dependency-inventory.json')]],
    ['ci-policy', ['--test', 'test/ci-policy.test.mjs', 'test/dependency-inventory.test.mjs', 'test/performance-guardrails.test.mjs']],
    ['adversarial-boundaries', ['--test', 'test/adversarial-boundaries.test.mjs']],
  ] : [
    ['coding-acceptance', ['spikes/development/product-test.mjs', '--suite', 'coding', '--output', join(home, 'coding')]],
    ['mac-integrations', ['--test', 'test/coding-integrations.test.mjs', 'test/coding-runtime.test.mjs', 'test/firefox-integration.test.mjs', 'test/mixed-observations.test.mjs']],
  ];
  for (const [name, args] of commands) {
    const result = spawnSync(process.execPath, args, { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: home },
      timeout: name === 'coding-acceptance' ? 180_000 : 60_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    const passed = !result.error && result.status === 0;
    report.checks.push({ name, status: passed ? 'PASS' : 'FAIL', exitCode: result.status,
      ...(args[0] === '--test' ? { tests: Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1] ?? 0) } : {}) });
    if (!passed) report.status = 'FAIL';
    if (name === 'coding-acceptance') {
      // The product runner refuses work/output under any checkout. Copy only its
      // bounded content-free reports into the CI upload directory afterward.
      try {
        await mkdir(join(output, 'coding'), { mode: 0o700 });
        for (const file of ['result.json', 'diagnostics.json', 'report.html']) {
          const bytes = await readFile(join(home, 'coding', file));
          if (bytes.length > 512 * 1024) throw Error('REPORT_LIMIT');
          await writeFile(join(output, 'coding', file), bytes, { flag: 'wx', mode: 0o600 });
        }
      } catch { report.status = 'FAIL'; report.checks.push({ name: 'coding-report', status: 'FAIL' }); }
    }
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} catch { report.status = 'FAIL'; report.reason = 'FRESH_OUTPUT_OR_RUNNER_REQUIRED'; }
finally { await rm(home, { recursive: true, force: true }); }
process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = report.status === 'PASS' ? 0 : 1;
