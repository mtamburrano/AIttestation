import Darwin
import Foundation
import Security

private let applicationIdentifier = "ai.provenance.consumer.host"
private let chromeIdentifier = "com.google.Chrome"
private let chromeTeamIdentifier = "EQHXZ8M8AV"
private let extensionOrigin = "chrome-extension://hdnjjomhchcpcnikfabcnmlhcehbnhbc/"
private let attestationProfile = "pap-native-browser-attestation/1"

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

private func machineArchitecture() throws -> String {
  var size = 0
  guard sysctlbyname("hw.machine", nil, &size, nil, 0) == 0, size > 1, size < 128 else {
    throw HostFailure.rejected
  }
  var bytes = [CChar](repeating: 0, count: size)
  guard sysctlbyname("hw.machine", &bytes, &size, nil, 0) == 0 else { throw HostFailure.rejected }
  return String(cString: bytes)
}

private func attestation() throws -> String {
  let chrome = try parentChromeBundle()
  guard let fullVersion = chrome.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
        let first = fullVersion.split(separator: ".").first,
        let major = Int(first), major > 0 else { throw HostFailure.rejected }
  let system = ProcessInfo.processInfo.operatingSystemVersion
  let architecture = try machineArchitecture()
  guard architecture == "arm64" else { throw HostFailure.rejected }
  let value: [String: Any] = [
    "profile": attestationProfile,
    "browser": ["product": "Google Chrome", "channel": "stable", "major": major],
    "platform": ["product": "macOS", "arch": architecture,
      "version": "\(system.majorVersion).\(system.minorVersion).\(system.patchVersion)"],
  ]
  let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  return bytes.base64EncodedString()
}

private func ownedHome() throws -> String {
  guard let record = getpwuid(getuid()), let home = record.pointee.pw_dir else { throw HostFailure.spawn }
  return String(cString: home)
}

private func runFixedRelay(origin: String, encodedAttestation: String) throws -> Int32 {
  let contents = Bundle.main.bundleURL.appendingPathComponent("Contents", isDirectory: true)
  let node = contents.appendingPathComponent("MacOS/node")
  let script = contents.appendingPathComponent("Resources/spikes/browser/chatgpt/native-host.mjs")
  let process = Process()
  process.executableURL = node
  process.arguments = [script.path, origin, encodedAttestation]
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
  guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == extensionOrigin else {
    throw HostFailure.rejected
  }
  try validateSignedApplication()
  let status = try runFixedRelay(origin: CommandLine.arguments[1], encodedAttestation: attestation())
  exit(status)
} catch {
  exit(EXIT_FAILURE)
}
