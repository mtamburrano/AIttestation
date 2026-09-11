import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DurableVault, MacOSKeychainStore } from '../../vault/key-lifecycle.mjs';
import { parseCanonical } from '../../vault/format.mjs';
import { startChromeProtectionRuntime } from './bridge-runtime.mjs';
import { startProductComposer } from './product-server.mjs';
import { ManagedAnchoringClient } from '../../managed/client.mjs';
import { MANAGED_NETWORK, MANAGED_GENESIS } from '../../managed/protocol.mjs';

const defaultSupportDirectory = join(homedir(), 'Library', 'Application Support', 'Private Provenance');

export async function startPackagedChatGPT({
  supportDirectory = defaultSupportDirectory, fastTrust = null, keyStore, vault = null,
  collectFast, verifyFast, verifyArchive, attestPeer, managed = undefined, openBrowser = false,
} = {}) {
  await mkdir(supportDirectory, { recursive: true, mode: 0o700 });
  const trust = fastTrust ?? parseCanonical(await readFile(new URL('fast-trust.json', import.meta.url)), 16 * 1024);
  if (managed === undefined) {
    const config = parseCanonical((await readFile(new URL('managed-config.json', import.meta.url), 'utf8')).trim(), 4096);
    if (Object.keys(config).join(',') !== 'origin') throw Error('Invalid packaged managed service configuration');
    if (config.origin !== null) {
      managed = new ManagedAnchoringClient({ origin: config.origin, keyStore: keyStore ?? new MacOSKeychainStore() });
      if (trust.network !== MANAGED_NETWORK || trust.genesis !== MANAGED_GENESIS
          || trust.operators.some(operator => new URL(operator.endpoint).origin === config.origin)) {
        throw Error('Managed service cannot supply independent anchor confirmation');
      }
      trust.applicationServiceOrigin = config.origin;
    } else managed = null;
  }
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
      fastTrust: trust, vault, managed,
      ...(collectFast === undefined ? {} : { collectFast }),
      ...(verifyFast === undefined ? {} : { verifyFast }),
      ...(verifyArchive === undefined ? {} : { verifyArchive }),
      ...(attestPeer === undefined ? {} : { attestPeer }),
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
