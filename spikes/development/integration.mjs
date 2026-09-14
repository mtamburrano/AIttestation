import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { exists, ownerDirectory, privateJSON, writeNewJSON } from './environment.mjs';
import { canonical } from '../vault/format.mjs';

export async function registerNativeHost(paths, browserHost) {
  const directory = join(paths.chrome, 'NativeMessagingHosts');
  if (!await exists(directory)) await mkdir(directory, { mode: 0o700 });
  await ownerDirectory(directory);
  const target = join(directory, 'ai.provenance.consumer.json');
  const manifest = { name: 'ai.provenance.consumer', description: 'Attestamp private development bridge',
    path: browserHost, type: 'stdio', allowed_origins: ['chrome-extension://medilhopfckldjgdnchfkpmfmfnkadca/'] };
  const ownership = join(paths.control, 'registration.json');
  if (await exists(target)) throw Error('NATIVE_REGISTRATION_ALREADY_EXISTS');
  // Journal ownership before installation; an interrupted install is safe to remove.
  await writeNewJSON(ownership, manifest);
  try { await writeNewJSON(target, manifest); }
  catch (error) { await unlink(ownership); throw error; }
}

export async function removeNativeHost(paths) {
  const ownership = join(paths.control, 'registration.json');
  if (!await exists(ownership)) return;
  const expected = await privateJSON(ownership);
  const target = join(paths.chrome, 'NativeMessagingHosts/ai.provenance.consumer.json');
  if (await exists(target)) {
    if (JSON.stringify(await privateJSON(target)) !== JSON.stringify(expected)) throw Error('NATIVE_REGISTRATION_CHANGED');
    await unlink(target);
  }
  await unlink(ownership);
}

export function privateInstallation(paths, browserHost) {
  let exportOffered = false;
  const status = async () => {
    const target = join(paths.chrome, 'NativeMessagingHosts/ai.provenance.consumer.json');
    const ownership = join(paths.control, 'registration.json');
    let integration = 'DISABLED';
    if (await exists(target)) {
      integration = 'CONFLICT';
      if (await exists(ownership)) {
        const expected = await privateJSON(ownership), installed = await privateJSON(target);
        if (canonical(expected) === canonical(installed) && installed.path === browserHost) integration = 'ENABLED';
      }
    }
    return { integration, releaseClass: 'PRIVATE_DEVELOPMENT', releaseChannel: null, storeURL: null };
  };
  return { status,
    async enable() {
      const current = await status();
      if (current.integration === 'CONFLICT') throw Error('NATIVE_REGISTRATION_CHANGED');
      if (current.integration !== 'ENABLED') {
        await removeNativeHost(paths);
        await registerNativeHost(paths, browserHost);
      }
      return status();
    },
    async disable() { await removeNativeHost(paths); return status(); },
    async record(event) { if (event === 'exportOffered') exportOffered = true; },
    async remove({ exportDecision }) {
      if (!exportOffered || !['keep-local', 'exported'].includes(exportDecision)) throw Error('EXPORT_OPPORTUNITY_REQUIRED');
      await removeNativeHost(paths); exportOffered = false;
      return { integration: 'DISABLED', evidence: 'RETAINED', keys: 'RETAINED' };
    },
    diagnostics: async () => ({ integration: (await status()).integration, releaseClass: 'PRIVATE_DEVELOPMENT' }),
  };
}
