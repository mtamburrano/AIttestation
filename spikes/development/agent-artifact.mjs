import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Specialize only the private build's inputs, before compilation and signing.
// Exact matches make source drift a build failure, never a partial rewrite.
export function replaceAgentInput(source, before, after) {
  if (source.split(before).length !== 2) throw Error('AGENT_BUILD_INPUT_CHANGED');
  return source.replace(before, () => after);
}
const swiftString = value => `String(data: Data(base64Encoded: "${Buffer.from(value).toString('base64')}")!, encoding: .utf8)!`;

export function agentNativeSources({ host, helper, browser }, agent, paths) {
  const guard = `
private func agentCanonicalPath(_ path: String) -> Bool {
  guard let resolved = realpath(path, nil) else { return false }
  defer { free(resolved) }
  return String(cString: resolved) == path
}
private func agentValidateAccount() throws {
  guard let record = getpwuid(getuid()), let name = record.pointee.pw_name, let home = record.pointee.pw_dir,
    getuid() == ${agent.account.uid}, String(cString: name) == ${swiftString(agent.account.username)},
    String(cString: home) == ${swiftString(paths.home)} else { throw HostFailure.spawn }
  for path in [${['root', 'control', 'support', 'chrome', 'extension', 'browser', 'builds'].map(key => swiftString(paths[key])).join(', ')}] {
    var info = stat()
    guard agentCanonicalPath(path),
      lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
      info.st_uid == getuid(), (info.st_mode & 0o077) == 0 else { throw HostFailure.spawn }
  }
}
`;
  host = replaceAgentInput(host, 'private let maximumRequestBytes', `${guard}\nprivate let maximumRequestBytes`);
  host = replaceAgentInput(host, '.appendingPathComponent("Library/Application Support/Private Provenance", isDirectory: true)',
    `.appendingPathComponent(${swiftString(`.attestamp-agent-${agent.namespace}/support`)}, isDirectory: true)`);
  host = replaceAgentInput(host, 'directory.resolvingSymlinksInPath().path == directory.path', 'agentCanonicalPath(directory.path)');
  host = replaceAgentInput(host, 'guard let record = getpwuid(getuid()), let name = record.pointee.pw_name,\n        String(cString: name) == "attestamp-test", getuid() >= 501 else { throw HostFailure.spawn }',
    `try agentValidateAccount()\n  guard CommandLine.arguments.count == 2, ["--agent-session", "--agent-preflight", "--agent-bootstrap"].contains(CommandLine.arguments[1]) else { throw HostFailure.spawn }`);
  host = replaceAgentInput(host, 'Resources/spikes/development/runtime.mjs', 'Resources/spikes/development/agent-runtime.mjs');
  host = replaceAgentInput(host, 'try process.run(); input.fileHandleForReading.closeFile()', `try process.run()
    let deadline = DispatchWorkItem { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 8, execute: deadline)
    defer { deadline.cancel() }
    input.fileHandleForReading.closeFile()`);
  host = replaceAgentInput(host, '#if PRIVATE_DEVELOPMENT\n  let scriptURL', `
  if CommandLine.arguments[1] != "--agent-session" {
    var request: [String: Any] = ["profile": "pap-keychain-request/1", "operation": "get",
      "service": ${swiftString(paths.keychainService)}, "account": "agent:readiness"]
    if CommandLine.arguments[1] == "--agent-bootstrap" {
      request["operation"] = "set"; request["value"] = "YWdlbnQtcmVhZGluZXNzLXYx"
    }
    var response = helperResponse(try JSONSerialization.data(withJSONObject: request), helperURL: helperURL)
    if CommandLine.arguments[1] == "--agent-bootstrap" {
      let written = try JSONSerialization.jsonObject(with: response) as? [String: Any]
      if written?["status"] as? String == "OK" {
        request["operation"] = "get"; request.removeValue(forKey: "value")
        response = helperResponse(try JSONSerialization.data(withJSONObject: request), helperURL: helperURL)
      }
    }
    let value = try JSONSerialization.jsonObject(with: response) as? [String: Any]
    let ready = value?["profile"] as? String == "pap-keychain-response/1" && value?["status"] as? String == "OK"
      && value?["value"] as? String == "YWdlbnQtcmVhZGluZXNzLXYx"
    let reason = value?["status"] as? String == "MISSING" ? "VAULT_KEYCHAIN_BOOTSTRAP_REQUIRED" : "VAULT_KEYCHAIN_UNAVAILABLE"
    let report: [String: Any] = ready ? ["status": "READY"] : ["status": "OWNER_ACTION_REQUIRED", "reason": reason]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report))
    exit(ready ? EXIT_SUCCESS : 2)
  }
#if PRIVATE_DEVELOPMENT
  let scriptURL`);
  host = replaceAgentInput(host, 'if status != 0 {\n        let alert', 'if false {\n        let alert');
  helper = replaceAgentInput(helper, 'private let allowedService = "ai.provenance.evidence-vault"',
    `private let allowedService = ${swiftString(paths.keychainService)}`);
  helper = replaceAgentInput(helper, 'import Security', 'import Security\nimport LocalAuthentication');
  helper = replaceAgentInput(helper, 'private let requestProfile', `${guard.replaceAll('HostFailure.spawn', 'HelperFailure.rejected')}\nprivate let requestProfile`);
  helper = replaceAgentInput(helper, 'let accessGroup = try authorizeParentAndGetAccessGroup()',
    `try agentValidateAccount()
  guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { throw HelperFailure.rejected }
  let accessGroup = try authorizeParentAndGetAccessGroup()`);
  helper = replaceAgentInput(helper, 'let query = baseQuery(service: service, account: account, accessGroup: accessGroup)',
    `var query = baseQuery(service: service, account: account, accessGroup: accessGroup)
  let authentication = LAContext(); authentication.interactionNotAllowed = true
  query[kSecUseAuthenticationContext as String] = authentication`);
  helper = replaceAgentInput(helper, '|managed:anchoring:[A-Za-z0-9_-]{43})$', '|agent:readiness)$');
  browser = replaceAgentInput(browser, 'private let applicationIdentifier', `${guard}\nprivate let applicationIdentifier`);
  browser = replaceAgentInput(browser, '_ = try parentChromeBundle()',
    `try agentValidateAccount()\n  guard try parentChromeBundle().bundleURL.resolvingSymlinksInPath().path == ${swiftString(paths.chromeApplication)} else { throw HostFailure.rejected }`);
  browser = replaceAgentInput(browser, 'Resources/spikes/browser/chatgpt/native-host.mjs', 'Resources/spikes/development/agent-relay.mjs');
  return { host, helper, browser };
}

export async function specializeAgentArtifact(root, contents, work, agent, paths, run) {
  const sources = agentNativeSources({
    host: await readFile(join(root, 'spikes/vault/native/macos-app-host.swift'), 'utf8'),
    helper: await readFile(join(root, 'spikes/vault/native/macos-keychain-helper.swift'), 'utf8'),
    browser: await readFile(join(root, 'spikes/browser/chatgpt/native/macos-browser-host.swift'), 'utf8'),
  }, agent, paths);
  for (const [kind, target] of [
    ['host', 'MacOS/provenance-app-host'],
    ['helper', 'Helpers/Private Provenance Keychain.app/Contents/MacOS/provenance-keychain-helper'],
    ['browser', 'MacOS/provenance-browser-host'],
  ]) {
    const source = join(work, `agent-${kind}.swift`); await writeFile(source, sources[kind], { mode: 0o600 });
    run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(work, 'swift-cache'), '-O',
      '-D', 'PRODUCT_CHATGPT', '-D', 'PRODUCT_RELEASE', '-D', 'PRIVATE_DEVELOPMENT', '-framework', 'Security',
      source, '-o', join(contents, target)]);
  }
  const keyStore = join(contents, 'Resources/spikes/vault/key-lifecycle.mjs');
  await writeFile(keyStore, replaceAgentInput(await readFile(keyStore, 'utf8'),
    "const DEFAULT_SERVICE = 'ai.provenance.evidence-vault';", `const DEFAULT_SERVICE = ${JSON.stringify(paths.keychainService)};`));
}
