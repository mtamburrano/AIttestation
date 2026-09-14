import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Do not propagate credentials, HOME, proxy/TLS/Node options or app settings.
// The worker allocates its own directory and never reads a retained test kit.
const result = spawnSync(process.execPath, [fileURLToPath(new URL('product-test-worker.mjs', import.meta.url)), ...process.argv.slice(2)], {
  env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024,
});
if (result.error || ![0, 1, 2].includes(result.status)) {
  process.stdout.write(`${JSON.stringify({ profile: 'pap-product-test/1', mode: 'SYNTHETIC_FIXTURE',
    status: 'FAIL', reason: result.error?.code === 'ETIMEDOUT' ? 'RUNNER_TIMEOUT' : 'RUNNER_FAILED' })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(result.stdout); process.exitCode = result.status;
}
