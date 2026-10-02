import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateScale } from '../spikes/development/performance-fixtures.mjs';

test('release guardrails accept historical bounded reads and reject scan, resource and missing-result regressions', async () => {
  const historical = JSON.parse(await readFile(new URL('../spikes/vault/scaling-benchmark.json', import.meta.url))).results;
  for (const baseline of historical.filter(row => row.prompts >= 10000)) {
    const value = { ...baseline, commonAccess: baseline.recentAccess, transfer: { exportAccess: { recordsRead: 40, objectsRead: 50 },
      exportBytes: 50000, exportMs: 50, verifierMs: 50, verifierRecords: 10, recoveryRecords: baseline.prompts * 2,
      recoveryBytes: baseline.prompts * 8000, recoveryMs: 30000, recoveryVerifyMs: 30000 } };
    assert.equal(evaluateScale(value, value.prompts).status, 'PASS');
    for (const mutate of [v => { v.startupAccess = { recordsRead: 1, objectsRead: 0 }; },
      v => { v.commonAccess = { recordsRead: v.prompts, objectsRead: v.prompts }; },
      v => { v.peakRssMiB = 769; }, v => { v.diskMiB = 10000; }, v => { v.transfer.exportBytes = 2 ** 20 + 1; },
      v => { v.transfer.recoveryRecords--; }, v => { v.transfer.recoveryVerifyMs = 180001; },
      v => { v.recentMs = NaN; }, v => { delete v.transfer; }]) {
      const bad = structuredClone(value); mutate(bad);
      const report = evaluateScale(bad, value.prompts); assert.equal(report.status, 'FAIL');
      assert.ok(report.checks.some(check => check.status === 'FAIL' && typeof check.path === 'string'));
    }
  }
});
