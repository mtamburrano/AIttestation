import Darwin
import Foundation
import Security
import CryptoKit

enum HookFailure: Error { case rejected }
let hookApplicationIdentifier = "ai.provenance.consumer.host"
let hookLauncherIdentifier = "ai.provenance.consumer.hook-receiver"
let hookRuntimeIdentifier = "ai.provenance.consumer.runtime"

func hookPeer(_ descriptor: Int32) throws -> pid_t {
  var peer: pid_t = 0
  var size = socklen_t(MemoryLayout<pid_t>.size)
  guard getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &peer, &size) == 0,
        size == MemoryLayout<pid_t>.size, peer > 1 else { throw HookFailure.rejected }
  return peer
}

func hookParent(_ pid: pid_t) throws -> pid_t {
  var information = proc_bsdinfo()
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &information, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
        information.pbi_uid == getuid(), information.pbi_ppid > 1 else { throw HookFailure.rejected }
  return pid_t(information.pbi_ppid)
}

func hookProcessPath(_ pid: pid_t) throws -> String {
  var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { throw HookFailure.rejected }
  return String(cString: buffer)
}

func hookValidateBundle() throws {
  var code: SecStaticCode?
  guard Bundle.main.bundleIdentifier == hookApplicationIdentifier,
        SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
        let code, SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else {
    throw HookFailure.rejected
  }
}

func hookValidateBundledProcess(_ pid: pid_t, identifier: String, filename: String) throws {
  var code: SecCode?
  let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess, let code,
        SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else { throw HookFailure.rejected }
  var staticCode: SecStaticCode?, information: CFDictionary?
  guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode,
        SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
        let values = information as? [String: Any], values[kSecCodeInfoIdentifier as String] as? String == identifier,
        try hookProcessPath(pid) == Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/\(filename)").path else { throw HookFailure.rejected }
}

func hookOwnedFile(_ path: String, limit: Int) throws -> Data {
  let descriptor = open(path, O_RDONLY | O_NOFOLLOW)
  guard descriptor >= 0 else { throw HookFailure.rejected }
  defer { close(descriptor) }
  var info = stat()
  guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_nlink == 1,
        info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0,
        info.st_size >= 0, info.st_size <= limit else { throw HookFailure.rejected }
  var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
  guard read(descriptor, &bytes, bytes.count) == bytes.count else { throw HookFailure.rejected }
  return Data(bytes)
}

func hookArguments(_ pid: pid_t) throws -> [String] {
  var mib = [CTL_KERN, KERN_PROCARGS2, pid], length = 0
  guard sysctl(&mib, 3, nil, &length, nil, 0) == 0, length > 4, length <= 2 * 1024 * 1024 else { throw HookFailure.rejected }
  var bytes = [UInt8](repeating: 0, count: length)
  guard sysctl(&mib, 3, &bytes, &length, nil, 0) == 0 else { throw HookFailure.rejected }
  let count = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
  guard count > 0, count <= 128 else { throw HookFailure.rejected }
  var position = 4
  while position < length && bytes[position] != 0 { position += 1 }
  while position < length && bytes[position] == 0 { position += 1 }
  var arguments: [String] = []
  for _ in 0..<count {
    let start = position
    while position < length && bytes[position] != 0 { position += 1 }
    guard position < length, let value = String(bytes: bytes[start..<position], encoding: .utf8) else { throw HookFailure.rejected }
    arguments.append(value); position += 1
  }
  return arguments // Environment bytes are never decoded or returned.
}

func hookCodeIdentity(_ path: String) throws -> String {
  var code: SecStaticCode?, information: CFDictionary?
  guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, SecCSFlags(), &code) == errSecSuccess, let code,
        SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess,
        SecCodeCopySigningInformation(code, SecCSFlags(), &information) == errSecSuccess,
        let values = information as? [String: Any], let digest = values[kSecCodeInfoUnique as String] as? Data,
        [20, 32].contains(digest.count) else { throw HookFailure.rejected }
  return digest.map { String(format: "%02x", $0) }.joined()
}

func hookValidateEnrolledProcess(_ pid: pid_t, codeHash: String) throws {
  guard codeHash.range(of: "\\A[a-f0-9]{40}([a-f0-9]{24})?\\z", options: .regularExpression) != nil else { throw HookFailure.rejected }
  var code: SecCode?, requirement: SecRequirement?
  let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
  // Dynamic validation binds the running process to the enrolled CodeDirectory.
  // Full file hashing belongs to explicit enrollment, outside prompt admission.
  guard SecRequirementCreateWithString("cdhash H\"\(codeHash)\"" as CFString, SecCSFlags(), &requirement) == errSecSuccess,
        let requirement, SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess, let code,
        SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { throw HookFailure.rejected }
}

func hookDigest(_ path: String) throws -> String {
  let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: path)); defer { try? file.close() }
  var digest = SHA256(), total = 0
  while let data = try file.read(upToCount: 65536), !data.isEmpty {
    total += data.count
    guard total <= 4 * 1024 * 1024 else { throw HookFailure.rejected }
    digest.update(data: data)
  }
  return digest.finalize().map { String(format: "%02x", $0) }.joined()
}
