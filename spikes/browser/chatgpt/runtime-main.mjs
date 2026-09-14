import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DurableVault, MacOSKeychainStore } from '../../vault/key-lifecycle.mjs';
import { parseCanonical } from '../../vault/format.mjs';
import { startChromeProtectionRuntime } from './bridge-runtime.mjs';
import { startProductComposer } from './product-server.mjs';
import { ManagedAnchoringClient } from '../../managed/client.mjs';
import { MANAGED_NETWORK, MANAGED_GENESIS } from '../../managed/protocol.mjs';
import { InstallationLifecycle, STORE_URL } from '../../distribution/lifecycle.mjs';
import { DesktopUpdater } from '../../distribution/updater.mjs';
import { RELEASE_CHANNELS, validateInstalledRelease, validateReleaseCandidate } from '../../distribution/config.mjs';

const defaultSupportDirectory = join(homedir(), 'Library', 'Application Support', 'Private Provenance');

export async function startPackagedChatGPT({
  supportDirectory = defaultSupportDirectory, fastTrust = null, keyStore, vault = null,
  collectFast, verifyFast, verifyArchive, attestPeer, managed = undefined, openBrowser = false,
  installation = undefined,
  diagnostics, controllerTimeoutMs,
} = {}) {
  await mkdir(supportDirectory, { recursive: true, mode: 0o700 });
  let installedRelease = null, releaseCandidate = null;
  if (installation === undefined) {
    const installedPayload = JSON.parse(await readFile(new URL('../../distribution/installed-release.json', import.meta.url), 'utf8'));
    const candidateURL = new URL('../../distribution/release-candidate.json', import.meta.url);
    if (installedPayload !== null && existsSync(candidateURL)) throw Error('Ambiguous packaged release metadata');
    installedRelease = installedPayload === null ? null : validateInstalledRelease(installedPayload);
    releaseCandidate = installedPayload === null && existsSync(candidateURL)
      ? validateReleaseCandidate(JSON.parse(await readFile(candidateURL, 'utf8'))) : null;
    installation = installedRelease ? await new InstallationLifecycle({
      supportDirectory, chromeSupportDirectory: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
      browserHost: join(dirname(process.execPath), 'provenance-browser-host'),
      sequence: installedRelease.sequence, releaseChannel: RELEASE_CHANNELS.PRODUCTION,
    }).init() : releaseCandidate ? await new InstallationLifecycle({
      supportDirectory, chromeSupportDirectory: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
      browserHost: join(dirname(process.execPath), 'provenance-browser-host'),
      sequence: releaseCandidate.sequence, releaseChannel: RELEASE_CHANNELS.CANDIDATE,
    }).init() : null;
  }
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
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(controllerTimeoutMs === undefined ? {} : { controllerTimeoutMs }),
    });
    const updater = installedRelease ? new DesktopUpdater({ config: installedRelease, lifecycle: installation,
      schema: () => vault.schemaInfo(), directory: join(supportDirectory, 'Updates') }) : null;
    const openLocal = path => new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/open', [path], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
      child.once('error', () => reject(Error('Unable to open the selected release resource')));
      child.once('exit', code => code === 0 ? resolve() : reject(Error('Unable to open the selected release resource')));
    });
    bridge.maintenance = installation ? {
      status: () => installation.status(),
      enable: () => installation.enable(),
      async store() { await installation.record('storeOpened'); await openLocal(STORE_URL); return { opened: true }; },
      async offerExport() { await installation.record('exportOffered'); return { evidence: 'RETAINED', exportAvailable: true }; },
      async remove(data) {
        // End bridge authority before removing the registration. A concurrent
        // admitted attempt is drained by the ordinary close path, never retried.
        bridge.disableIntegration();
        return installation.remove(data);
      },
      diagnostics: () => installation.diagnostics({ paired: bridge.browserState() !== null, update: updater?.state }),
      async checkUpdate() { if (!updater) throw Error('Updates are not configured'); return updater.check(); },
      async downloadUpdate() {
        if (!updater) throw Error('Updates are not configured');
        const result = await updater.download(); await openLocal(result.path);
        return { state: result.state, instruction: 'Close Attestamp, replace the app in Finder, then reopen and pair your tab. Evidence stays on this Mac.' };
      },
    } : null;
    if (installation) bridge.waitForPairing().then(() => installation.record('paired')).catch(() => {});
    let closing;
    const close = () => closing ??= (async () => {
      // Revoke authority before draining; closing a browser view never calls this.
      bridge.engine.stop();
      await composer?.close(); await bridge.close(); if (ownedVault) vault.close();
    })();
    composer = await startProductComposer(bridge, { onExit: close });
    if (openBrowser) {
      const browser = spawn('/usr/bin/open', ['-b', 'com.google.Chrome', composer.url], {
        env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', detached: true,
      });
      browser.on('error', () => {});
      browser.unref();
    }
    return {
      ...bridge, composerURL: composer.url,
      close,
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
  }).catch(() => { process.stderr.write('PRIVATE_PROVENANCE_START_FAILED\n'); process.exitCode = 1; });
}
