import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Extend the product runner with the existing crash/updater tests. No alternate
// migrator, installer, updater, recovery implementation or shipping claim.
export const RELEASE_SCENARIOS = Object.freeze(['release-migration', 'release-update-authority', 'release-recovery-removal']);
const checks = {
  'release-migration': { pattern: 'migration process death|missing or incompatible migration metadata', files: ['distribution'], minimum: 2,
    coverage: ['synthetic-schema-one-and-three', 'crash-after-ddl-before-and-after-commit', 'exact-disclosure-reopen', 'incompatible-reader-rejection'] },
  'release-update-authority': { pattern: 'release metadata authenticates|verified downloads require|restart preserves rollback|consented integration', files: ['distribution'], minimum: 4,
    coverage: ['ephemeral-ed25519-metadata', 'stale-sequence-schema-and-signature-rejection', 'interrupted-tampered-oversized-artifact', 'injected-apple-rejection', 'current-app-preserved'] },
  'release-recovery-removal': { pattern: 'release recovery|clean-device recovery', files: ['release-recovery', 'key-lifecycle'], minimum: 3,
    coverage: ['stream-and-json-recovery', 'restore-interruption-before-and-after-commit', 'exact-evidence-and-export', 'restored-off-and-stale-authority-rejected', 'forward-repair-sequence', 'verifier-after-app-removal'] },
};
export function releaseProductFixture(directory, scenario) {
  const check = checks[scenario];
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `--test-name-pattern=${check.pattern}`,
    ...check.files.map(name => `test/${name}.test.mjs`)], { cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { HOME: directory, PATH: '/usr/bin:/bin' }, timeout: 60_000, maxBuffer: 512 * 1024, encoding: 'utf8' });
  const tests = Number(/^# pass (\d+)$/m.exec(result.stdout)?.[1] ?? 0);
  const passed = !result.error && result.status === 0 && tests >= check.minimum;
  return { scenario, status: passed ? 'PASS' : 'FAIL', classification: passed ? 'NONE' : result.error ? 'HARNESS' : 'PRODUCT',
    reason: passed ? undefined : result.error?.code === 'ETIMEDOUT' ? 'SCENARIO_TIMEOUT' : 'RELEASE_REHEARSAL_FAILED',
    tests, coverage: check.coverage, predecessor: 'SYNTHETIC_LOCAL_NOT_SHIPPED', appleSignatureEvidence: 'INJECTED_NOT_TESTED',
    providerAttempts: 0, sponsorBroadcasts: 0, authority: 'NONE' };
}
