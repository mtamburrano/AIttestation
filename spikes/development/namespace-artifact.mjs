import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIVATE_ACCEPTANCE_NAMESPACE, TEST_USER } from './environment.mjs';

export const PRIVATE_ACCEPTANCE_SUPPORT = `/Users/${TEST_USER}/.attestamp-private-acceptance-${PRIVATE_ACCEPTANCE_NAMESPACE}/support`;

function replacePrivateInput(source, before, after) {
  if (source.split(before).length !== 2) throw Error('PRIVATE_NAMESPACE_BUILD_INPUT_CHANGED');
  return source.replace(before, () => after);
}

export function privateAcceptanceHookSocketPath() {
  return join(PRIVATE_ACCEPTANCE_SUPPORT, `hook-${'0'.repeat(12)}.sock`);
}

export function privateAcceptanceArtifactSources({ host, hookReceiver, chromeRelay, firefoxRelay }, namespace) {
  if (namespace !== PRIVATE_ACCEPTANCE_NAMESPACE) throw Error('UNRECOGNIZED_PRIVATE_ACCEPTANCE_NAMESPACE');
  if (Buffer.byteLength(privateAcceptanceHookSocketPath()) >= 104) throw Error('PRIVATE_NAMESPACE_SOCKET_PATH_TOO_LONG');
  return privateStateArtifactSources({ host, hookReceiver, chromeRelay, firefoxRelay },
    `.attestamp-private-acceptance-${namespace}/support`, PRIVATE_ACCEPTANCE_SUPPORT);
}

export function privateStateArtifactSources({ host, hookReceiver, chromeRelay, firefoxRelay }, relativeSupport, support) {
  const suffix = `/${relativeSupport}`;
  host = replacePrivateInput(host,
    '.appendingPathComponent("Library/Application Support/Private Provenance", isDirectory: true)',
    `.appendingPathComponent("${relativeSupport}", isDirectory: true)`);
  hookReceiver = replacePrivateInput(hookReceiver,
    'String(cString: home) + "/Library/Application Support/Private Provenance"',
    `String(cString: home) + "${suffix}"`);

  chromeRelay = replacePrivateInput(chromeRelay,
    "const defaultRendezvous = join(homedir(), 'Library', 'Application Support', 'Private Provenance', 'browser-bridge.json');",
    `const defaultRendezvous = ${JSON.stringify(join(support, 'browser-bridge.json'))};`);
  chromeRelay = replacePrivateInput(chromeRelay, "import { homedir } from 'node:os';\n", '');
  chromeRelay = replacePrivateInput(chromeRelay,
    "import { dirname, isAbsolute, join, resolve, sep } from 'node:path';",
    "import { dirname, isAbsolute, resolve, sep } from 'node:path';");

  firefoxRelay = replacePrivateInput(firefoxRelay,
    "rendezvousPath: join(homedir(), 'Library', 'Application Support', 'Private Provenance', 'firefox-bridge.json')",
    `rendezvousPath: ${JSON.stringify(join(support, 'firefox-bridge.json'))}`);
  firefoxRelay = replacePrivateInput(firefoxRelay, "import { homedir } from 'node:os';\n", '');
  firefoxRelay = replacePrivateInput(firefoxRelay, "import { join } from 'node:path';\n", '');

  return { host, hookReceiver, chromeRelay, firefoxRelay };
}

export async function specializePrivateAcceptanceArtifact(root, contents, work, namespace, run) {
  const sources = privateAcceptanceArtifactSources({
    host: await readFile(join(root, 'spikes/vault/native/macos-app-host.swift'), 'utf8'),
    hookReceiver: await readFile(join(root, 'spikes/coding/native/macos-hook-receiver.swift'), 'utf8'),
    chromeRelay: await readFile(join(root, 'spikes/browser/chatgpt/native-host.mjs'), 'utf8'),
    firefoxRelay: await readFile(join(root, 'spikes/browser/firefox/native-host.mjs'), 'utf8'),
  }, namespace);

  const appHostSource = join(work, 'private-acceptance-app-host.swift');
  await writeFile(appHostSource, sources.host, { mode: 0o600 });
  run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(work, 'swift-cache'), '-O',
    '-D', 'PRODUCT_CHATGPT', '-D', 'PRODUCT_RELEASE', '-D', 'PRIVATE_DEVELOPMENT', '-framework', 'Security',
    appHostSource, '-o', join(contents, 'MacOS/provenance-app-host')]);

  const hookReceiverSource = join(work, 'private-acceptance-hook-receiver.swift');
  await writeFile(hookReceiverSource, sources.hookReceiver, { mode: 0o600 });
  run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(work, 'swift-cache'), '-O', '-framework', 'Security',
    join(root, 'spikes/coding/native/macos-hook-security.swift'), hookReceiverSource,
    '-o', join(contents, 'MacOS/provenance-hook-receiver')]);

  await writeFile(join(contents, 'Resources/spikes/browser/chatgpt/native-host.mjs'), sources.chromeRelay);
  await writeFile(join(contents, 'Resources/spikes/browser/firefox/native-host.mjs'), sources.firefoxRelay);
}
