import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DurableVault, MacOSKeychainStore } from '../../vault/key-lifecycle.mjs';
import { parseCanonical } from '../../vault/format.mjs';
import { startChromeRecordingRuntime } from './bridge-runtime.mjs';
import { startProductDashboard } from './product-server.mjs';
import { ManagedAnchoringClient } from '../../managed/client.mjs';
import { MANAGED_NETWORK, MANAGED_GENESIS } from '../../managed/protocol.mjs';
import { InstallationLifecycle, STORE_URL } from '../../distribution/lifecycle.mjs';
import { DesktopUpdater } from '../../distribution/updater.mjs';
import { RELEASE_CHANNELS, validateInstalledRelease, validateReleaseCandidate } from '../../distribution/config.mjs';
import { startRecipient } from '../../recipient/server.mjs';
import { startDesktopChannel } from './desktop-channel.mjs';

const defaultSupportDirectory = join(homedir(), 'Library', 'Application Support', 'Private Provenance');

export async function startPackagedChatGPT({
  supportDirectory = defaultSupportDirectory, fastTrust = null, keyStore, vault = null,
  collectFast, verifyFast, verifyArchive, attestPeer, managed = undefined, openBrowser = false,
  installation = undefined,
  diagnostics, controllerTimeoutMs, debugSession = null,
  openDashboard, desktopChannel = null,
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
  let bridge, dashboard, desktop, recipient, recipientStarting;
  try {
    const openLocal = path => new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/open', [path], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
      child.once('error', () => reject(Error('Unable to open the selected release resource')));
      child.once('exit', code => code === 0 ? resolve() : reject(Error('Unable to open the selected release resource')));
    });
    const showDashboard = (section = '') => {
      if (!dashboard) throw Error('Dashboard unavailable');
      const url = new URL(dashboard.dashboardURL);
      if (section) url.searchParams.set('section', section);
      return (openDashboard ?? openLocal)(url.href);
    };
    bridge = await startChromeRecordingRuntime(supportDirectory, {
      fastTrust: trust, vault, managed,
      openDashboard: () => showDashboard(),
      integrationEnabled: installation ? (await installation.status()).integration === 'ENABLED' : true,
      ...(collectFast === undefined ? {} : { collectFast }),
      ...(verifyFast === undefined ? {} : { verifyFast }),
      ...(verifyArchive === undefined ? {} : { verifyArchive }),
      ...(attestPeer === undefined ? {} : { attestPeer }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(controllerTimeoutMs === undefined ? {} : { controllerTimeoutMs }),
    });
    bridge.debugSession = debugSession;
    const updater = installedRelease ? new DesktopUpdater({ config: installedRelease, lifecycle: installation,
      schema: () => vault.schemaInfo(), directory: join(supportDirectory, 'Updates') }) : null;
    let maintenanceTail = Promise.resolve();
    const changeIntegration = operation => {
      const next = maintenanceTail.then(operation); maintenanceTail = next.catch(() => {}); return next;
    };
    bridge.maintenance = installation ? {
      status: () => installation.status(),
      enable: () => changeIntegration(async () => {
        const state = await installation.enable(); await bridge.enableIntegration(); return state;
      }),
      disable() {
        bridge.disableIntegration();
        return changeIntegration(() => { bridge.disableIntegration(); return installation.disable(); });
      },
      async store() { await installation.record('storeOpened'); await openLocal(STORE_URL); return { opened: true }; },
      async offerExport() { await installation.record('exportOffered'); return { evidence: 'RETAINED', exportAvailable: true }; },
      async remove(data) {
        // Revoke capture before removing the browser registration.
        bridge.disableIntegration();
        return changeIntegration(() => { bridge.disableIntegration(); return installation.remove(data); });
      },
      diagnostics: () => installation.diagnostics({ paired: bridge.browserState() !== null, update: updater?.state }),
      async checkUpdate() { if (!updater) throw Error('Updates are not configured'); return updater.check(); },
      async downloadUpdate() {
        if (!updater) throw Error('Updates are not configured');
        const result = await updater.download(); await openLocal(result.path);
        return { state: result.state, instruction: 'Close Attestamp, replace the app in Finder, then reopen Chrome. Evidence stays on this Mac.' };
      },
    } : null;
    bridge.openVerifier = async () => {
      if (closing) throw Error('ENGINE_UNAVAILABLE');
      if (!recipient || recipient.closed) {
        recipientStarting ??= startRecipient();
        try { recipient = await recipientStarting; } finally { recipientStarting = null; }
      }
      if (closing) { await recipient.close(); throw Error('ENGINE_UNAVAILABLE'); }
      await (openDashboard ?? openLocal)(recipient.url);
      return { opened: true };
    };
    bridge.openDashboard = showDashboard;
    if (installation) bridge.waitForPairing().then(() => installation.record('paired')).catch(() => {});
    let closing;
    const close = () => closing ??= (async () => {
      // Revoke authority before draining; closing a browser view never calls this.
      bridge.engine.stop();
      desktop?.close(); await recipientStarting?.catch(() => {}); await recipient?.close();
      await dashboard?.close(); await bridge.close(); if (ownedVault) vault.close();
    })();
    dashboard = await startProductDashboard(bridge, { onExit: close });
    if (desktopChannel) desktop = startDesktopChannel(bridge, { ...desktopChannel, onExit: close });
    if (openBrowser) {
      await showDashboard();
    }
    return {
      ...bridge, dashboardURL: dashboard.dashboardURL,
      close,
    };
  } catch (error) {
    desktop?.close(); await recipient?.close();
    try { await dashboard?.close(); } catch {}
    try { await bridge?.close(); } catch {}
    if (ownedVault) vault.close();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startPackagedChatGPT({ openBrowser: process.argv.includes('--open'),
    desktopChannel: process.argv.includes('--resident') ? { requestFD: 6, responseFD: 7 } : null }).then(runtime => {
    const close = () => runtime.close().finally(() => process.exit());
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }).catch(() => { process.stderr.write('PRIVATE_PROVENANCE_START_FAILED\n'); process.exitCode = 1; });
}
