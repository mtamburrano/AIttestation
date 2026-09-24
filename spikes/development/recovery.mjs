import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DurableVault } from '../vault/key-lifecycle.mjs';
import { inspectRecoveryFile } from '../vault/recovery-stream.mjs';
import { inspectRecovery } from '../vault/vault.mjs';
import { LocalReceipts } from '../recipient/local.mjs';
import { readReleaseFile, assertReleasePath } from '../distribution/release-inputs.mjs';
import { exists, newDirectory, ownerDirectory, writeNewJSON } from './environment.mjs';

function insideTestHome(path, paths) {
  if (typeof path !== 'string' || resolve(path) !== path || !path.startsWith(`${paths.home}${sep}`)) {
    throw Error('RECOVERY_PATH_MUST_BE_IN_TEST_HOME');
  }
}

function recoveryOutput(path, paths) {
  insideTestHome(path, paths);
  for (const reserved of [paths.control, paths.support, paths.chrome]) {
    if (path === reserved || path.startsWith(`${reserved}${sep}`)) throw Error('RECOVERY_OUTPUT_MUST_BE_SEPARATE');
  }
}

export async function backupDevelopment(paths, outputDirectory, keyStore) {
  recoveryOutput(outputDirectory, paths);
  await newDirectory(outputDirectory);
  const vault = DurableVault.open(join(paths.support, 'vault'), { keyStore });
  try {
    const streaming = !vault.recoveryFitsJSON();
    const packageFile = join(outputDirectory, streaming ? 'encrypted-recovery.pap-recovery' : 'encrypted-recovery.json');
    const snapshot = streaming ? vault.exportRecoveryFile(packageFile) : vault.exportRecovery();
    try {
      const secrets = join(paths.control, 'recovery-secrets');
      if (!await exists(secrets)) await mkdir(secrets, { mode: 0o700 });
      await ownerDirectory(secrets);
      const recoverySecretFile = join(secrets, `${randomUUID()}.key`);
      await writeFile(recoverySecretFile, snapshot.recoveryKey, { flag: 'wx', mode: 0o600 });
      if (!streaming) await writeFile(packageFile, snapshot.package, { flag: 'wx', mode: 0o600 });
      return { backup: 'COMPLETE', packageFile, recoverySecretFile, keyIncludedInPackage: false };
    } finally { snapshot.recoveryKey.fill(0); }
  } finally { vault.close(); }
}

export async function restoreDevelopment(paths, outputDirectory, packageFile, secretFile, keyStore) {
  for (const path of [outputDirectory, packageFile, secretFile]) insideTestHome(path, paths);
  recoveryOutput(outputDirectory, paths);
  const streaming = packageFile.endsWith('.pap-recovery');
  await assertReleasePath(packageFile, { privateFile: true });
  const packageBytes = streaming ? null : await readReleaseFile(packageFile, { privateFile: true, limit: 16 * 1024 * 1024 });
  const recoveryKey = await readReleaseFile(secretFile, { privateFile: true, limit: 32 });
  let restored;
  try {
    const snapshot = streaming ? inspectRecoveryFile(packageFile, recoveryKey) : inspectRecovery(packageBytes, recoveryKey);
    const recordCount = streaming ? snapshot.count : snapshot.records.length;
    await newDirectory(outputDirectory);
    const vaultPath = join(outputDirectory, 'restored-vault');
    restored = streaming ? DurableVault.restoreFile(packageFile, recoveryKey, vaultPath, { keyStore })
      : DurableVault.restore(packageBytes, recoveryKey, vaultPath, { keyStore });
    restored.close(); restored = DurableVault.open(vaultPath, { keyStore });
    if (restored.verifyAll().count !== recordCount
        || restored.status().historicalSendAuthorization !== 'NONE') throw Error('RECOVERY_VERIFICATION_FAILED');
    const receipts = new LocalReceipts(restored); let exportedReceipts = 0;
    for (const kind of ['prompt', 'derivative', 'unassociated']) {
      let before = Number.MAX_SAFE_INTEGER;
      do {
        const page = restored.recordPage({ kind, before, limit: 100 });
        for (const record of page.records) {
          const preview = receipts.prepare({ ids: [record.manifest.eventId] });
          await writeFile(join(outputDirectory, `receipt-${String(++exportedReceipts).padStart(4, '0')}.json`),
            receipts.export(preview.previewId), { flag: 'wx', mode: 0o600 });
        }
        before = page.next;
      } while (before !== null);
    }
    const report = { snapshot: 'COMPLETE', latestState: 'NOT_PROVEN', records: recordCount,
      exportedReceipts, historicalSendAuthorization: 'NONE', activeVaultReplaced: false };
    await writeNewJSON(join(outputDirectory, 'recovery-report.json'), report);
    return report;
  } finally { restored?.close(); recoveryKey.fill(0); }
}
