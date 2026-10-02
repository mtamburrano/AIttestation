import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownerAcceptanceAccount } from './owner-acceptance.mjs';
import { privateStateArtifactSources } from './namespace-artifact.mjs';
import { replaceAgentInput } from './agent-artifact.mjs';

const swiftString = value => `String(data: Data(base64Encoded: "${Buffer.from(value).toString('base64')}")!, encoding: .utf8)!`;

export function ownerAcceptanceArtifactSources(source, owner, info) {
  const paths = ownerAcceptanceAccount(owner, info);
  const guard = failure => `
private func ownerAcceptanceValidateAccount() throws {
  guard let record = getpwuid(getuid()), let name = record.pointee.pw_name, let home = record.pointee.pw_dir,
    getuid() == ${owner.account.uid}, String(cString: name) == ${swiftString(owner.account.username)},
    String(cString: home) == ${swiftString(paths.home)} else { throw ${failure} }
  for path in [${['root', 'control', 'support', 'chrome', 'builds'].map(key => swiftString(paths[key])).join(', ')}] {
    var info = stat()
    guard let resolved = realpath(path, nil) else { throw ${failure} }
    defer { free(resolved) }
    guard String(cString: resolved) == path,
      lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
      info.st_uid == getuid(), (info.st_mode & 0o077) == 0 else { throw ${failure} }
  }
}
`;
  let { host, hookReceiver, chromeRelay, firefoxRelay } = privateStateArtifactSources(source,
    `.attestamp-owner-${owner.namespace}/support`, paths.support);
  host = replaceAgentInput(host, 'private let maximumRequestBytes', `${guard('HostFailure.spawn')}\nprivate let maximumRequestBytes`);
  host = replaceAgentInput(host, '  // Development keeps the production Keychain group and bridge identities, so\n  // its authority must be confined to a separate OS account before any storage.\n  guard let record = getpwuid(getuid()), let name = record.pointee.pw_name,\n        String(cString: name) == "attestamp-test", getuid() >= 501 else { throw HostFailure.spawn }',
    '  try ownerAcceptanceValidateAccount()\n  guard CommandLine.arguments.count == 1 else { throw HostFailure.spawn }');
  let helper = replaceAgentInput(source.helper, 'private let requestProfile', `${guard('HelperFailure.rejected')}\nprivate let requestProfile`);
  helper = replaceAgentInput(helper, 'private let allowedService = "ai.provenance.evidence-vault"',
    `private let allowedService = ${swiftString(paths.keychainService)}`);
  helper = replaceAgentInput(helper, 'let accessGroup = try authorizeParentAndGetAccessGroup()',
    'try ownerAcceptanceValidateAccount()\n  let accessGroup = try authorizeParentAndGetAccessGroup()');
  helper = replaceAgentInput(helper, '|managed:anchoring:[A-Za-z0-9_-]{43}', '');
  hookReceiver = replaceAgentInput(hookReceiver, 'private func deadlineHandler', `${guard('HookFailure.rejected')}\nprivate func deadlineHandler`);
  hookReceiver = replaceAgentInput(hookReceiver, 'try hookValidateBundle()', 'try ownerAcceptanceValidateAccount()\n    try hookValidateBundle()');
  return { host, helper, hookReceiver, chromeRelay, firefoxRelay };
}

export async function specializeOwnerAcceptanceArtifact(root, contents, work, owner, run, info) {
  const sources = ownerAcceptanceArtifactSources({
    host: await readFile(join(root, 'spikes/vault/native/macos-app-host.swift'), 'utf8'),
    helper: await readFile(join(root, 'spikes/vault/native/macos-keychain-helper.swift'), 'utf8'),
    hookReceiver: await readFile(join(root, 'spikes/coding/native/macos-hook-receiver.swift'), 'utf8'),
    chromeRelay: await readFile(join(root, 'spikes/browser/chatgpt/native-host.mjs'), 'utf8'),
    firefoxRelay: await readFile(join(root, 'spikes/browser/firefox/native-host.mjs'), 'utf8'),
  }, owner, info);
  for (const [kind, target] of [
    ['host', 'MacOS/provenance-app-host'],
    ['helper', 'Helpers/Private Provenance Keychain.app/Contents/MacOS/provenance-keychain-helper'],
    ['hookReceiver', 'MacOS/provenance-hook-receiver'],
  ]) {
    const source = join(work, `owner-${kind}.swift`); await writeFile(source, sources[kind], { mode: 0o600 });
    run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(work, 'swift-cache'), '-O',
      '-D', 'PRODUCT_CHATGPT', '-D', 'PRODUCT_RELEASE', '-D', 'PRIVATE_DEVELOPMENT', '-framework', 'Security',
      ...(kind === 'hookReceiver' ? [join(root, 'spikes/coding/native/macos-hook-security.swift')] : []),
      source, '-o', join(contents, target)]);
  }
  const keyStore = join(contents, 'Resources/spikes/platform/macos/key-store.mjs');
  await writeFile(keyStore, replaceAgentInput(await readFile(keyStore, 'utf8'),
    "const DEFAULT_SERVICE = 'ai.provenance.evidence-vault';",
    `const DEFAULT_SERVICE = ${JSON.stringify(ownerAcceptanceAccount(owner, info).keychainService)};`));
  await writeFile(join(contents, 'Resources/spikes/browser/chatgpt/native-host.mjs'), sources.chromeRelay);
  await writeFile(join(contents, 'Resources/spikes/browser/firefox/native-host.mjs'), sources.firefoxRelay);
}
