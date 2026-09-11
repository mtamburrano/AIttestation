import Darwin
import Foundation
import Security

private let applicationIdentifier = "ai.provenance.consumer.host"
private let relayIdentifier = "ai.provenance.consumer.runtime"
private let browserHostIdentifier = "ai.provenance.consumer.browser-host"
private let chromeIdentifier = "com.google.Chrome"
private let chromeTeamIdentifier = "EQHXZ8M8AV"
private let validationProfile = "pap-native-peer-validation/1"
private let inheritedSocket: Int32 = 3

private enum ValidationFailure: Error { case rejected }

private func validateSignedApplication() throws {
  var code: SecStaticCode?
  guard Bundle.main.bundleIdentifier == applicationIdentifier,
        SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
        let code,
        SecStaticCodeCheckValidity(code,
          SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures), nil) == errSecSuccess else {
    throw ValidationFailure.rejected
  }
}

private func peerPID() throws -> pid_t {
  var peer: pid_t = 0
  var length = socklen_t(MemoryLayout<pid_t>.size)
  guard getsockopt(inheritedSocket, SOL_LOCAL, LOCAL_PEERPID, &peer, &length) == 0,
        length == MemoryLayout<pid_t>.size, peer > 1 else { throw ValidationFailure.rejected }
  return peer
}

private func parentPID(of process: pid_t) throws -> pid_t {
  var information = proc_bsdinfo()
  let size = MemoryLayout<proc_bsdinfo>.size
  let copied = proc_pidinfo(process, PROC_PIDTBSDINFO, 0, &information, Int32(size))
  guard copied == size, information.pbi_ppid > 1 else { throw ValidationFailure.rejected }
  return pid_t(information.pbi_ppid)
}

private func liveCode(for process: pid_t) throws -> (SecCode, SecStaticCode, [String: Any], URL) {
  var dynamicCode: SecCode?
  let attributes = [kSecGuestAttributePid as String: NSNumber(value: process)] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &dynamicCode) == errSecSuccess,
        let dynamicCode,
        SecCodeCheckValidity(dynamicCode, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else {
    throw ValidationFailure.rejected
  }
  var staticCode: SecStaticCode?
  var informationValue: CFDictionary?
  var pathValue: CFURL?
  guard SecCodeCopyStaticCode(dynamicCode, SecCSFlags(), &staticCode) == errSecSuccess,
        let staticCode,
        SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &informationValue) == errSecSuccess,
        let information = informationValue as? [String: Any],
        SecCodeCopyPath(staticCode, SecCSFlags(), &pathValue) == errSecSuccess,
        let path = pathValue as URL? else { throw ValidationFailure.rejected }
  return (dynamicCode, staticCode, information, path)
}

private func validateBundledProcess(_ process: pid_t, identifier: String, executable: URL) throws {
  let (_, _, information, observedPath) = try liveCode(for: process)
  guard information[kSecCodeInfoIdentifier as String] as? String == identifier,
        observedPath.resolvingSymlinksInPath().standardizedFileURL.path ==
          executable.resolvingSymlinksInPath().standardizedFileURL.path else {
    throw ValidationFailure.rejected
  }
}

private func validateChrome(_ process: pid_t) throws -> Bundle {
  let (dynamicCode, _, information, executable) = try liveCode(for: process)
  let requirementText = "anchor apple generic and identifier \"\(chromeIdentifier)\" and certificate leaf[subject.OU] = \"\(chromeTeamIdentifier)\""
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(requirementText as CFString, SecCSFlags(), &requirement) == errSecSuccess,
        let requirement,
        SecCodeCheckValidity(dynamicCode, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess,
        information[kSecCodeInfoIdentifier as String] as? String == chromeIdentifier,
        information[kSecCodeInfoTeamIdentifier as String] as? String == chromeTeamIdentifier else {
    throw ValidationFailure.rejected
  }
  var candidate = executable
  while candidate.pathExtension != "app" && candidate.path != "/" { candidate.deleteLastPathComponent() }
  guard candidate.pathExtension == "app", let bundle = Bundle(url: candidate),
        bundle.bundleIdentifier == chromeIdentifier else {
    throw ValidationFailure.rejected
  }
  return bundle
}

private func machineArchitecture() throws -> String {
  var size = 0
  guard sysctlbyname("hw.machine", nil, &size, nil, 0) == 0, size > 1, size < 128 else {
    throw ValidationFailure.rejected
  }
  var bytes = [CChar](repeating: 0, count: size)
  guard sysctlbyname("hw.machine", &bytes, &size, nil, 0) == 0 else { throw ValidationFailure.rejected }
  return String(cString: bytes)
}

private func validatedIdentity() throws -> [String: Any] {
  try validateSignedApplication()
  let contents = Bundle.main.bundleURL.appendingPathComponent("Contents", isDirectory: true)
  let peer = try peerPID()
  try validateBundledProcess(peer, identifier: relayIdentifier,
    executable: contents.appendingPathComponent("MacOS/node"))
  let browserHost = try parentPID(of: peer)
  try validateBundledProcess(browserHost, identifier: browserHostIdentifier,
    executable: contents.appendingPathComponent("MacOS/provenance-browser-host"))
  let chrome = try validateChrome(parentPID(of: browserHost))
  guard let fullVersion = chrome.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
        let first = fullVersion.split(separator: ".").first,
        let major = Int(first), major > 0 else { throw ValidationFailure.rejected }
  let system = ProcessInfo.processInfo.operatingSystemVersion
  let architecture = try machineArchitecture()
  guard architecture == "arm64" else { throw ValidationFailure.rejected }
  return [
    "profile": validationProfile,
    "browser": ["product": "Google Chrome", "channel": "stable", "major": major],
    "platform": ["product": "macOS", "arch": architecture,
      "version": "\(system.majorVersion).\(system.minorVersion).\(system.patchVersion)"],
  ]
}

do {
  guard CommandLine.arguments.count == 1 else { throw ValidationFailure.rejected }
  let output = try JSONSerialization.data(withJSONObject: validatedIdentity(), options: [.sortedKeys])
  FileHandle.standardOutput.write(output)
  exit(EXIT_SUCCESS)
} catch {
  exit(EXIT_FAILURE)
}
