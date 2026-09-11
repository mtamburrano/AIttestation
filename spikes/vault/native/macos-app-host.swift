import Darwin
import Foundation
import Security

private let maximumRequestBytes = 256 * 1024
private let maximumResponseBytes = 1024 * 1024
private let hostIdentifier = "ai.provenance.consumer.host"
private let errorResponse = Data(#"{"profile":"pap-keychain-response/1","status":"ERROR"}"#.utf8)

private enum HostFailure: Error { case invalidBundle, pipe, spawn }

private func validateSignedBundle() throws {
  var code: SecStaticCode?
  guard Bundle.main.bundleIdentifier == hostIdentifier,
        SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
        let code,
        SecStaticCodeCheckValidity(code,
          SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures), nil) == errSecSuccess else {
    throw HostFailure.invalidBundle
  }
}

private func readExactly(_ fd: Int32, _ count: Int) -> Data? {
  var data = Data(count: count), offset = 0
  let result = data.withUnsafeMutableBytes { raw -> Bool in
    guard let base = raw.baseAddress else { return false }
    while offset < count {
      let amount = Darwin.read(fd, base.advanced(by: offset), count - offset)
      if amount == 0 { return false }
      if amount < 0 { if errno == EINTR { continue }; return false }
      offset += amount
    }
    return true
  }
  return result ? data : nil
}

private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
  var offset = 0
  return data.withUnsafeBytes { raw -> Bool in
    guard let base = raw.baseAddress else { return false }
    while offset < data.count {
      let amount = Darwin.write(fd, base.advanced(by: offset), data.count - offset)
      if amount < 0 { if errno == EINTR { continue }; return false }
      offset += amount
    }
    return true
  }
}

private func framedWrite(_ fd: Int32, _ body: Data) -> Bool {
  var size = UInt32(body.count).bigEndian
  let prefix = Data(bytes: &size, count: MemoryLayout<UInt32>.size)
  return writeAll(fd, prefix) && writeAll(fd, body)
}

private func helperResponse(_ request: Data, helperURL: URL) -> Data {
  let process = Process(), input = Pipe(), output = Pipe()
  process.executableURL = helperURL; process.arguments = []; process.environment = [:]
  process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
  do {
    try process.run(); input.fileHandleForReading.closeFile()
    try input.fileHandleForWriting.write(contentsOf: request); try input.fileHandleForWriting.close()
    let response = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
    guard process.terminationReason == .exit, process.terminationStatus == 0,
          !response.isEmpty, response.count <= maximumResponseBytes else { return errorResponse }
    return response
  } catch { return errorResponse }
}

private func broker(_ requestFD: Int32, _ responseFD: Int32, helperURL: URL) {
  while let prefix = readExactly(requestFD, 4) {
    let count = prefix.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
    guard count > 0, count <= maximumRequestBytes,
          let request = readExactly(requestFD, Int(count)) else { break }
    if !framedWrite(responseFD, helperResponse(request, helperURL: helperURL)) { break }
  }
}

private func ownedHome() throws -> String {
  guard let record = getpwuid(getuid()), let home = record.pointee.pw_dir else { throw HostFailure.spawn }
  return String(cString: home)
}

#if PRODUCT_RELEASE
private func lockApplicationInstance() throws -> Int32 {
  let directory = URL(fileURLWithPath: try ownedHome())
    .appendingPathComponent("Library/Application Support/Private Provenance", isDirectory: true)
  guard directory.resolvingSymlinksInPath().path == directory.path else { throw HostFailure.spawn }
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o700])
  var directoryInfo = stat()
  guard lstat(directory.path, &directoryInfo) == 0, directoryInfo.st_uid == getuid(),
        (directoryInfo.st_mode & 0o077) == 0 else { throw HostFailure.spawn }
  let descriptor = open(directory.appendingPathComponent("application.lock").path,
    O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard descriptor >= 0 else { throw HostFailure.spawn }
  var info = stat()
  guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_nlink == 1,
        (info.st_mode & S_IFMT) == S_IFREG, (info.st_mode & 0o077) == 0,
        flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
    close(descriptor); throw HostFailure.spawn
  }
  let lifetimeDescriptor = fcntl(descriptor, F_DUPFD_CLOEXEC, 64)
  close(descriptor)
  guard lifetimeDescriptor >= 0 else { throw HostFailure.spawn }
  return lifetimeDescriptor
}
#endif

private func spawnFixedRuntime(nodeURL: URL, scriptURL: URL, instanceLock: Int32? = nil) throws -> (pid_t, Int32, Int32) {
  var requests = [Int32](repeating: -1, count: 2), responses = [Int32](repeating: -1, count: 2)
  guard pipe(&requests) == 0, pipe(&responses) == 0 else { throw HostFailure.pipe }
  for fd in requests + responses { guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw HostFailure.pipe } }
  var actions: posix_spawn_file_actions_t?
  guard posix_spawn_file_actions_init(&actions) == 0 else { throw HostFailure.spawn }
  defer { posix_spawn_file_actions_destroy(&actions) }
  posix_spawn_file_actions_adddup2(&actions, requests[1], 3)
  posix_spawn_file_actions_adddup2(&actions, responses[0], 4)
  if let instanceLock {
    // Retain the kernel lock in the child as well. An orphaned old runtime must
    // finish before another app version can update the rollback floor or vault.
    posix_spawn_file_actions_adddup2(&actions, instanceLock, 5)
    posix_spawn_file_actions_addclose(&actions, instanceLock)
  }
  for fd in [requests[0], requests[1], responses[0], responses[1]] where fd != 3 && fd != 4 && (instanceLock == nil || fd != 5) {
    posix_spawn_file_actions_addclose(&actions, fd)
  }

  var arguments: [UnsafeMutablePointer<CChar>?] = []
  for value in [nodeURL.path, scriptURL.path, "--open"] { arguments.append(strdup(value)) }
  arguments.append(nil)
  var environment: [UnsafeMutablePointer<CChar>?] = []
  for value in ["HOME=\(try ownedHome())", "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"] { environment.append(strdup(value)) }
  environment.append(nil)
  defer { for pointer in arguments where pointer != nil { free(pointer) }; for pointer in environment where pointer != nil { free(pointer) } }
  var child: pid_t = 0
  let status = nodeURL.path.withCString { executable in
    arguments.withUnsafeBufferPointer { argv in
      environment.withUnsafeBufferPointer { envp in
        posix_spawn(&child, executable, &actions, nil,
          UnsafeMutablePointer(mutating: argv.baseAddress!), UnsafeMutablePointer(mutating: envp.baseAddress!))
      }
    }
  }
  guard status == 0 else { throw HostFailure.spawn }
  close(requests[1]); close(responses[0])
  return (child, requests[0], responses[1])
}

do {
  signal(SIGPIPE, SIG_IGN)
  try validateSignedBundle()
#if PRODUCT_RELEASE
  let instanceLock = try lockApplicationInstance()
  defer { close(instanceLock) }
#endif
  let contents = Bundle.main.bundleURL.appendingPathComponent("Contents", isDirectory: true)
  let nodeURL = contents.appendingPathComponent("MacOS/node")
#if PRODUCT_RELEASE
  let helperURL = contents.appendingPathComponent("Helpers/Private Provenance Keychain.app/Contents/MacOS/provenance-keychain-helper")
#else
  let helperURL = contents.appendingPathComponent("MacOS/provenance-keychain-helper")
#endif
#if PRODUCT_CHATGPT
  let scriptURL = contents.appendingPathComponent("Resources/spikes/browser/chatgpt/runtime-main.mjs")
#else
  let scriptURL = contents.appendingPathComponent("Resources/spikes/demonstrator/main.mjs")
#endif
#if PRODUCT_RELEASE
  let (child, requestFD, responseFD) = try spawnFixedRuntime(nodeURL: nodeURL, scriptURL: scriptURL, instanceLock: instanceLock)
#else
  let (child, requestFD, responseFD) = try spawnFixedRuntime(nodeURL: nodeURL, scriptURL: scriptURL)
#endif
  broker(requestFD, responseFD, helperURL: helperURL)
  close(requestFD); close(responseFD)
  var status: Int32 = 0; while waitpid(child, &status, 0) < 0 && errno == EINTR {}
  exit(status == 0 ? EXIT_SUCCESS : EXIT_FAILURE)
} catch {
  exit(EXIT_FAILURE)
}
