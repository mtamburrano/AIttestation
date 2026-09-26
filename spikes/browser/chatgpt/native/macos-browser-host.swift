import Darwin
import Foundation
import Security

private let applicationIdentifier = "ai.provenance.consumer.host"
#if FIREFOX
private let chromeIdentifier = "org.mozilla.firefox"
private let chromeTeamIdentifier = "43AQ936H96"
private let extensionOrigin = "attestamp-chatgpt@attestamp.app"
#else
private let chromeIdentifier = "com.google.Chrome"
private let chromeTeamIdentifier = "EQHXZ8M8AV"
private let extensionOrigin = "chrome-extension://medilhopfckldjgdnchfkpmfmfnkadca/"
#endif

private enum HostFailure: Error { case rejected, spawn }

private func validateSignedApplication() throws {
  var code: SecStaticCode?
  guard Bundle.main.bundleIdentifier == applicationIdentifier,
        SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
        let code,
        SecStaticCodeCheckValidity(code,
          SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures), nil) == errSecSuccess else {
    throw HostFailure.rejected
  }
}

private func parentChromeBundle() throws -> Bundle {
  var parent: SecCode?
  let attributes = [kSecGuestAttributePid as String: NSNumber(value: getppid())] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &parent) == errSecSuccess,
        let parent else { throw HostFailure.rejected }

  let requirementText = "anchor apple generic and identifier \"\(chromeIdentifier)\" and certificate leaf[subject.OU] = \"\(chromeTeamIdentifier)\""
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(requirementText as CFString, SecCSFlags(), &requirement) == errSecSuccess,
        let requirement,
        SecCodeCheckValidity(parent, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else {
    throw HostFailure.rejected
  }

  var staticCode: SecStaticCode?
  var informationValue: CFDictionary?
  guard SecCodeCopyStaticCode(parent, SecCSFlags(), &staticCode) == errSecSuccess,
        let staticCode,
        SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &informationValue) == errSecSuccess,
        let information = informationValue as? [String: Any],
        information[kSecCodeInfoIdentifier as String] as? String == chromeIdentifier,
        information[kSecCodeInfoTeamIdentifier as String] as? String == chromeTeamIdentifier else {
    throw HostFailure.rejected
  }

  var executableValue: CFURL?
  guard SecCodeCopyPath(staticCode, SecCSFlags(), &executableValue) == errSecSuccess,
        let executableURL = executableValue as URL? else { throw HostFailure.rejected }
  var candidate = executableURL
  while candidate.pathExtension != "app" && candidate.path != "/" {
    candidate.deleteLastPathComponent()
  }
  guard candidate.pathExtension == "app", let bundle = Bundle(url: candidate),
        bundle.bundleIdentifier == chromeIdentifier else { throw HostFailure.rejected }
  return bundle
}

private func ownedHome() throws -> String {
  guard let record = getpwuid(getuid()), let home = record.pointee.pw_dir else { throw HostFailure.spawn }
  return String(cString: home)
}

private func runFixedRelay(origin: String) throws -> Int32 {
  let contents = Bundle.main.bundleURL.appendingPathComponent("Contents", isDirectory: true)
  let node = contents.appendingPathComponent("MacOS/node")
  #if FIREFOX
  let script = contents.appendingPathComponent("Resources/spikes/browser/firefox/native-host.mjs")
  #else
  let script = contents.appendingPathComponent("Resources/spikes/browser/chatgpt/native-host.mjs")
  #endif
  let process = Process()
  process.executableURL = node
  process.arguments = [script.path, origin]
  process.environment = ["HOME": try ownedHome(), "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
  process.standardInput = FileHandle.standardInput
  process.standardOutput = FileHandle.standardOutput
  process.standardError = FileHandle.standardError
  try process.run()
  process.waitUntilExit()
  guard process.terminationReason == .exit else { throw HostFailure.spawn }
  return process.terminationStatus
}

do {
  signal(SIGPIPE, SIG_IGN)
  #if FIREFOX
  guard CommandLine.arguments.count == 3, CommandLine.arguments[2] == extensionOrigin,
        CommandLine.arguments[1].hasSuffix("/ai.provenance.consumer.firefox.json") else { throw HostFailure.rejected }
  #else
  guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == extensionOrigin else {
    throw HostFailure.rejected
  }
  #endif
  try validateSignedApplication()
  _ = try parentChromeBundle()
  let status = try runFixedRelay(origin: extensionOrigin)
  exit(status)
} catch {
  exit(EXIT_FAILURE)
}
