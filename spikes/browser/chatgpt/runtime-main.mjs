import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DurableVault } from '../../vault/key-lifecycle.mjs';
import { parseCanonical } from '../../vault/format.mjs';
import { startChromeProtectionRuntime } from './bridge-runtime.mjs';
import { startProductComposer } from './product-server.mjs';

const defaultSupportDirectory = join(homedir(), 'Library', 'Application Support', 'Private Provenance');

export async function startPackagedChatGPT({
  supportDirectory = defaultSupportDirectory, fastTrust = null, keyStore, vault = null,
  collectFast, verifyFast, verifyArchive, openBrowser = false,
} = {}) {
  await mkdir(supportDirectory, { recursive: true, mode: 0o700 });
  const trust = fastTrust ?? parseCanonical(await readFile(new URL('fast-trust.json', import.meta.url)), 16 * 1024);
  let ownedVault = false;
  if (!vault) {
    const vaultDirectory = join(supportDirectory, 'vault');
    vault = existsSync(join(vaultDirectory, 'vault.sqlite'))
      ? DurableVault.open(vaultDirectory, keyStore === undefined ? {} : { keyStore })
      : DurableVault.create(vaultDirectory, keyStore === undefined ? {} : { keyStore });
    ownedVault = true;
  }
  let bridge, composer;
  try {
    bridge = await startChromeProtectionRuntime(supportDirectory, {
      fastTrust: trust, vault,
      ...(collectFast === undefined ? {} : { collectFast }),
      ...(verifyFast === undefined ? {} : { verifyFast }),
      ...(verifyArchive === undefined ? {} : { verifyArchive }),
    });
    composer = await startProductComposer(bridge, { onClose: async () => {
      await bridge.close(); if (ownedVault) vault.close();
    } });
    if (openBrowser) {
      const browser = spawn('/usr/bin/open', ['-b', 'com.google.Chrome', composer.url], {
        env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', detached: true,
      });
      browser.on('error', () => {});
      browser.unref();
    }
    return {
      ...bridge, composerURL: composer.url,
      async close() { await composer.close(); },
    };
  } catch (error) {
    try { await composer?.close(); } catch {}
    try { await bridge?.close(); } catch {}
    if (ownedVault) vault.close();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startPackagedChatGPT({ openBrowser: process.argv.includes('--open') }).then(runtime => {
    const close = () => runtime.close().finally(() => process.exit());
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
