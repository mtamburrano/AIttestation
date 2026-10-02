import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { repositoryDependencyInventory } from '../distribution/inventory.mjs';

try {
  if (process.argv.length > 3) throw Error('INVALID_OPTIONS');
  const report = await repositoryDependencyInventory(fileURLToPath(new URL('../../', import.meta.url)));
  const text = JSON.stringify(report, null, 2) + '\n';
  if (Buffer.byteLength(text) > 64 * 1024) throw Error('INVENTORY_TOO_LARGE');
  if (process.argv[2]) await writeFile(process.argv[2], text, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(text);
} catch { process.stderr.write('DEPENDENCY_INVENTORY_FAILED\n'); process.exitCode = 1; }
