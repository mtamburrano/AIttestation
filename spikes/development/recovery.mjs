import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DurableVault } from '../vault/key-lifecycle.mjs';
import { inspectRecovery } from '../vault/vault.mjs';
import { LocalReceipts } from '../recipient/local.mjs';
import { readReleaseFile } from '../distribution/release-inputs.mjs';
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
    const snapshot = vault.exportRecovery();
    try {
      const secrets = join(paths.control, 'recovery-secrets');
      if (!await exists(secrets)) await mkdir(secrets, { mode: 0o700 });
      await ownerDirectory(secrets);
      const recoverySecretFile = join(secrets, `${randomUUID()}.key`);
      await writeFile(recoverySecretFile, snapshot.recoveryKey, { flag: 'wx', mode: 0o600 });
      await writeFile(join(outputDirectory, 'encrypted-recovery.json'), snapshot.package, { flag: 'wx', mode: 0o600 });
      return { backup: 'COMPLETE', recoverySecretFile, keyIncludedInPackage: false };
    } finally { snapshot.recoveryKey.fill(0); }
  } finally { vault.close(); }
}

export async function restoreDevelopment(paths, outputDirectory, packageFile, secretFile, keyStore) {
  for (const path of [outputDirectory, packageFile, secretFile]) insideTestHome(path, paths);
  recoveryOutput(outputDirectory, paths);
  const packageBytes = await readReleaseFile(packageFile, { privateFile: true, limit: 16 * 1024 * 1024 });
  const recoveryKey = await readReleaseFile(secretFile, { privateFile: true, limit: 32 });
  let restored;
  try {
    const snapshot = inspectRecovery(packageBytes, recoveryKey);
    await newDirectory(outputDirectory);
    const vaultPath = join(outputDirectory, 'restored-vault');
    restored = DurableVault.restore(packageBytes, recoveryKey, vaultPath, { keyStore });
    restored.close(); restored = DurableVault.open(vaultPath, { keyStore });
    if (restored.verifyAll().count !== snapshot.records.length
        || restored.status().historicalSendAuthorization !== 'NONE') throw Error('RECOVERY_VERIFICATION_FAILED');
    const receipts = new LocalReceipts(restored), groups = receipts.list();
    for (const [index, receipt] of groups.entries()) {
      const preview = receipts.prepare({ ids: [receipt.id] });
      await writeFile(join(outputDirectory, `receipt-${String(index + 1).padStart(4, '0')}.json`),
        receipts.export(preview.previewId), { flag: 'wx', mode: 0o600 });
    }
    const report = { snapshot: 'COMPLETE', latestState: 'NOT_PROVEN', records: snapshot.records.length,
      exportedReceipts: groups.length, historicalSendAuthorization: 'NONE', activeVaultReplaced: false };
    await writeNewJSON(join(outputDirectory, 'recovery-report.json'), report);
    return report;
  } finally { restored?.close(); recoveryKey.fill(0); }
}
