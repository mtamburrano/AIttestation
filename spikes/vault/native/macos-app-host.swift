import Darwin
import Foundation
import Security
#if PRODUCT_CHATGPT || PRIVATE_DEVELOPMENT
import AppKit
#endif

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

private func privatePipe() throws -> [Int32] {
  var descriptors = [Int32](repeating: -1, count: 2)
  guard pipe(&descriptors) == 0 else { throw HostFailure.pipe }
  // Keep sources above every fixed child descriptor before applying dup2.
  return try descriptors.map { descriptor in
    let duplicate = fcntl(descriptor, F_DUPFD_CLOEXEC, 64); close(descriptor)
    guard duplicate >= 0 else { throw HostFailure.pipe }; return duplicate
  }
}

private func spawnFixedRuntime(nodeURL: URL, scriptURL: URL, instanceLock: Int32? = nil) throws -> (pid_t, Int32, Int32, Int32?, Int32?) {
  let requests = try privatePipe(), responses = try privatePipe()
#if PRODUCT_CHATGPT || PRIVATE_DEVELOPMENT
  let controls = try privatePipe(), events = try privatePipe()
#else
  let controls: [Int32] = [], events: [Int32] = []
#endif
  var actions: posix_spawn_file_actions_t?
  guard posix_spawn_file_actions_init(&actions) == 0 else { throw HostFailure.spawn }
  defer { posix_spawn_file_actions_destroy(&actions) }
  posix_spawn_file_actions_adddup2(&actions, requests[1], 3)
  posix_spawn_file_actions_adddup2(&actions, responses[0], 4)
  if !controls.isEmpty {
    posix_spawn_file_actions_adddup2(&actions, controls[0], 6)
    posix_spawn_file_actions_adddup2(&actions, events[1], 7)
  }
  if let instanceLock {
    // Retain the kernel lock in the child as well. An orphaned old runtime must
    // finish before another app version can update the rollback floor or vault.
    posix_spawn_file_actions_adddup2(&actions, instanceLock, 5)
    posix_spawn_file_actions_addclose(&actions, instanceLock)
  }
  for fd in requests + responses + controls + events {
    posix_spawn_file_actions_addclose(&actions, fd)
  }

  var arguments: [UnsafeMutablePointer<CChar>?] = []
#if PRODUCT_CHATGPT || PRIVATE_DEVELOPMENT
  let launchArgument = "--resident"
#else
  let launchArgument = "--open"
#endif
  for value in [nodeURL.path, scriptURL.path, launchArgument] { arguments.append(strdup(value)) }
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
  if !controls.isEmpty { close(controls[0]); close(events[1]) }
  return (child, requests[0], responses[1], controls.last, events.first)
}

#if PRODUCT_CHATGPT || PRIVATE_DEVELOPMENT
private final class ResidentMenu: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private let control: Int32
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var state: [String: Any]?
  private var lastUpdate = Date.distantPast
  private var timer: Timer?
  private var runtimeExited = false
  private var terminationRequested = false
  private let labels = [
    "ENGINE_UNAVAILABLE": "Recording unavailable — restart Attestamp",
    "VAULT_CAPACITY_EXHAUSTED": "Local evidence capacity exhausted — History and recovery available",
    "CONFIGURATION_CONFLICT": "Chrome configuration needs attention",
    "DISABLED": "Chrome connection disabled — open Integrations",
    "DISCONNECTED": "Chrome disconnected — open Integrations",
    "COVERAGE_UNAVAILABLE": "Coverage unavailable — check your conversation",
    "SOURCES_READY": "ON · Supported tabs ready",
    "OFF": "Attestamp is OFF",
    "WAITING_FOR_TABS": "ON · Waiting for supported ChatGPT tabs",
    "ACTION_FAILED": "Action failed — refresh and try again"
  ]
  init(control: Int32) { self.control = control; super.init() }
  func applicationDidFinishLaunching(_ notification: Notification) {
    render()
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      guard let self else { return }
      if Date().timeIntervalSince(self.lastUpdate) > 6 { self.state = nil; self.render() }
    }
  }
  func receive(_ value: [String: Any]) -> Bool {
    let expected = Set(["profile", "runtimeEpoch", "revision", "recording", "available", "code",
      "readySources", "unavailableSources"])
    guard Set(value.keys) == expected, value["profile"] as? String == "pap-desktop-event/2",
      let epoch = value["runtimeEpoch"] as? String, UUID(uuidString: epoch) != nil,
      let revision = value["revision"] as? Int, revision >= 0,
      value["recording"] is Bool, value["available"] is Bool,
      let code = value["code"] as? String, labels[code] != nil,
      ["readySources", "unavailableSources"].allSatisfy({ key in
        guard let count = value[key] as? Int else { return false }; return count >= 0 && count <= 32
      }) else { return false }
    state = value; lastUpdate = Date(); render(); return true
  }
  private func item(_ title: String, _ selector: Selector?, value: String? = nil) -> NSMenuItem {
    let result = NSMenuItem(title: title, action: selector, keyEquivalent: "")
    result.target = self; result.representedObject = value; return result
  }
  private func render() {
    statusItem.button?.title = state == nil ? "Attestamp !" : state?["recording"] as? Bool == true
      ? state?["code"] as? String == "VAULT_CAPACITY_EXHAUSTED" ? "Attestamp · Capture unavailable" : "Attestamp ON" : "Attestamp OFF"
    let menu = NSMenu(); menu.delegate = self
    let code = state?["code"] as? String ?? "ENGINE_UNAVAILABLE"
    menu.addItem(item(labels[code]!, nil))
    if let state {
      menu.addItem(item("\(state["readySources"]!) supported tabs ready", nil))
    }
    menu.addItem(NSMenuItem.separator())
    let recording = item(state?["recording"] as? Bool == true ? "Turn OFF" : "Turn ON", #selector(toggleRecording))
    recording.isEnabled = state?["available"] as? Bool == true
      && (code != "VAULT_CAPACITY_EXHAUSTED" || state?["recording"] as? Bool == true); menu.addItem(recording)
    menu.addItem(NSMenuItem.separator())
    for (title, section) in [("Prompt history…", "history"), ("Integrations…", "integrations"),
      ("Settings and recovery…", "settings"), ("Open free verifier…", "verifier")] {
      menu.addItem(item(title, #selector(openSection(_:)), value: section))
    }
    menu.addItem(item("Refresh status", #selector(refresh)))
    menu.addItem(NSMenuItem.separator()); menu.addItem(item("Quit Attestamp", #selector(quit)))
    menu.autoenablesItems = false; statusItem.menu = menu
    statusItem.button?.toolTip = labels[code]
  }
  private func send(_ kind: String, _ data: [String: Any] = [:]) {
    var request = data; request["profile"] = "pap-desktop-command/2"; request["kind"] = kind
    guard let bytes = try? JSONSerialization.data(withJSONObject: request), framedWrite(control, bytes) else {
      state = nil; render(); return
    }
  }
  @objc private func refresh() { send("REFRESH") }
  @objc private func toggleRecording() {
    guard let state else { return }
    send("RECORDING", ["runtimeEpoch": state["runtimeEpoch"]!, "revision": state["revision"]!, "enabled": !(state["recording"] as! Bool)])
  }
  @objc private func openSection(_ sender: NSMenuItem) { send("OPEN", ["section": sender.representedObject as! String]) }
  @objc private func quit() { send("QUIT") }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    send("OPEN", ["section": "history"]); return false
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if runtimeExited { return .terminateNow }
    terminationRequested = true; send("QUIT"); return .terminateLater
  }
  func didExit() {
    runtimeExited = true
    if terminationRequested { NSApplication.shared.reply(toApplicationShouldTerminate: true) }
  }
}
#endif

do {
  signal(SIGPIPE, SIG_IGN)
  try validateSignedBundle()
#if PRIVATE_DEVELOPMENT
  // Development keeps the production Keychain group and bridge identities, so
  // its authority must be confined to a separate OS account before any storage.
  guard let record = getpwuid(getuid()), let name = record.pointee.pw_name,
        String(cString: name) == "attestamp-test", getuid() >= 501 else { throw HostFailure.spawn }
#endif
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
#if PRIVATE_DEVELOPMENT
  let scriptURL = contents.appendingPathComponent("Resources/spikes/development/runtime.mjs")
#else
  let scriptURL = contents.appendingPathComponent("Resources/spikes/browser/chatgpt/runtime-main.mjs")
#endif
#if PRODUCT_RELEASE
  let (child, requestFD, responseFD, controlFD, eventFD) = try spawnFixedRuntime(nodeURL: nodeURL, scriptURL: scriptURL, instanceLock: instanceLock)
#else
  let (child, requestFD, responseFD, controlFD, eventFD) = try spawnFixedRuntime(nodeURL: nodeURL, scriptURL: scriptURL)
#endif
#if PRODUCT_CHATGPT || PRIVATE_DEVELOPMENT
  guard let controlFD, let eventFD else { throw HostFailure.pipe }
  let application = NSApplication.shared, menu = ResidentMenu(control: controlFD)
  application.setActivationPolicy(.accessory); application.delegate = menu
  DispatchQueue.global().async {
    broker(requestFD, responseFD, helperURL: helperURL); close(requestFD); close(responseFD)
  }
  DispatchQueue.global().async {
    while let prefix = readExactly(eventFD, 4) {
      let size = prefix.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
      guard size > 0, size <= 16 * 1024, let bytes = readExactly(eventFD, Int(size)),
        let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { break }
      DispatchQueue.main.sync { if !menu.receive(value) { kill(child, SIGTERM) } }
    }
    close(eventFD)
  }
  DispatchQueue.global().async {
    var status: Int32 = 0; while waitpid(child, &status, 0) < 0 && errno == EINTR {}
    DispatchQueue.main.async {
      menu.didExit()
      if status != 0 {
        let alert = NSAlert(); alert.messageText = "Attestamp could not start or stopped unexpectedly."
        alert.informativeText = "Recording is unavailable. Reopen Attestamp after checking the private setup. Your retained evidence has not been deleted."
        alert.runModal()
      }
      application.terminate(nil)
    }
  }
  application.run(); close(controlFD)
#else
  broker(requestFD, responseFD, helperURL: helperURL)
  close(requestFD); close(responseFD)
  var status: Int32 = 0; while waitpid(child, &status, 0) < 0 && errno == EINTR {}
  exit(status == 0 ? EXIT_SUCCESS : EXIT_FAILURE)
#endif
} catch {
  exit(EXIT_FAILURE)
}
