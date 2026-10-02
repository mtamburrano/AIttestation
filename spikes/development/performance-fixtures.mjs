import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeCodingFixture } from './coding-fixtures.mjs';

export const PERFORMANCE_SCENARIOS = Object.freeze(['performance-scale-10k', 'performance-scale-50k', 'performance-native']);
export const PERFORMANCE_LIMITS = Object.freeze({ scaleTimeoutMs: 600_000, nativeTimeoutMs: 120_000,
  viewMs: 1500, peakRssMiB: 768, diskBytesPerPrompt: 16384, recoveryBytesPerPrompt: 16384,
  archiveOperationMs: 180_000, exportBytes: 1024 * 1024 });

export function evaluateScale(value, count) {
  const checks = [];
  const bounded = (path, actual, maximum, minimum = 0) => checks.push({ path,
    status: Number.isFinite(actual) && actual >= minimum && actual <= maximum ? 'PASS' : 'FAIL',
    actual: Number.isFinite(actual) ? actual : null, maximum });
  bounded('prompts', value.prompts, count, count);
  for (const [name, records, objects] of [['startup', 0, 0], ['recent', 40, 60], ['page', 40, 60], ['search', 40, 60], ['common', 40, 60]]) {
    bounded(`${name}.recordsRead`, value[`${name}Access`]?.recordsRead, records);
    bounded(`${name}.objectsRead`, value[`${name}Access`]?.objectsRead, objects);
  }
  bounded('startup.headersRead', value.startupAccess?.headersRead, 2);
  for (const name of ['startupMs', 'recentMs', 'pagedMs', 'searchMs', 'commonSearchMs']) bounded(name, value[name], PERFORMANCE_LIMITS.viewMs);
  bounded('peakRssMiB', value.peakRssMiB, PERFORMANCE_LIMITS.peakRssMiB, 1);
  bounded('diskBytesPerPrompt', value.diskMiB * 2 ** 20 / count, PERFORMANCE_LIMITS.diskBytesPerPrompt, 1);
  const transfer = value.transfer ?? {};
  bounded('export.recordsRead', transfer.exportAccess?.recordsRead, 60);
  bounded('export.objectsRead', transfer.exportAccess?.objectsRead, 80);
  bounded('export.bytes', transfer.exportBytes, PERFORMANCE_LIMITS.exportBytes, 1);
  bounded('verifier.records', transfer.verifierRecords, 10, 10);
  for (const name of ['exportMs', 'verifierMs']) bounded(name, transfer[name], PERFORMANCE_LIMITS.viewMs);
  for (const name of ['recoveryMs', 'recoveryVerifyMs']) bounded(name, transfer[name], PERFORMANCE_LIMITS.archiveOperationMs);
  bounded('recovery.records', transfer.recoveryRecords, count * 2, count * 2);
  bounded('recovery.bytesPerPrompt', transfer.recoveryBytes / count, PERFORMANCE_LIMITS.recoveryBytesPerPrompt, 1);
  return { status: checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL', checks };
}

export async function performanceProductFixture(directory, scenario) {
  if (scenario === 'performance-native') return nativeCodingFixture(directory, scenario);
  const count = scenario === 'performance-scale-10k' ? 10000 : 50000;
  const result = spawnSync(process.execPath, ['--expose-gc', 'test/vault-scale-benchmark.mjs', '--child', String(count), '4096', '--mixed', '--guardrails'],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { HOME: directory, PATH: '/usr/bin:/bin' },
      timeout: PERFORMANCE_LIMITS.scaleTimeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8' });
  if (result.error || result.status !== 0) return { scenario, status: 'FAIL', classification: result.error ? 'HARNESS' : 'PRODUCT',
    reason: result.error?.code === 'ETIMEDOUT' ? 'SCALE_TIMEOUT' : 'SCALE_FIXTURE_FAILED', prompts: count };
  const value = JSON.parse(result.stdout), evaluated = evaluateScale(value, count);
  return { scenario, ...evaluated, measurements: value, providerAttempts: 0, sponsorBroadcasts: 0,
    cache: 'WARM_FILESYSTEM', timingScope: 'SYNTHETIC_NOT_A_LATENCY_GUARANTEE', authority: 'NONE' };
}
