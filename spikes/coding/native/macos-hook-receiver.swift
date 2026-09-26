import Darwin
import Foundation

private var receiverChild: pid_t = 0
private func deadlineHandler(_ signal: Int32) {
  if receiverChild > 1 { kill(receiverChild, SIGKILL) }
  _exit(0)
}

@main struct HookReceiver {
  static func main() {
    signal(SIGALRM, deadlineHandler); signal(SIGPIPE, SIG_IGN)
    var deadline = itimerval(it_interval: timeval(tv_sec: 0, tv_usec: 0), it_value: timeval(tv_sec: 0, tv_usec: 250000))
    setitimer(ITIMER_REAL, &deadline, nil)
    do { try run() } catch {}
    _exit(0)
  }
  static func run() throws {
    let args = CommandLine.arguments
    guard args.count == 3, ["codex", "claude-code"].contains(args[1]), UUID(uuidString: args[2]) != nil else { throw HookFailure.rejected }
    try hookValidateBundle()
    guard let passwd = getpwuid(getuid()), let home = passwd.pointee.pw_dir else { throw HookFailure.rejected }
    let support = String(cString: home) + "/Library/Application Support/Private Provenance"
    let bytes = try hookOwnedFile(support + "/coding-bridge.json", limit: 4096)
    guard let record = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          record["profile"] as? String == "pap-hook-rendezvous/1", let path = record["socketPath"] as? String,
          path.hasPrefix(support + "/"), !path.contains("/../"), path.utf8.count < 104 else { throw HookFailure.rejected }
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    _ = withUnsafeMutablePointer(to: &address.sun_path) { target in
      path.withCString { source in target.withMemoryRebound(to: CChar.self, capacity: 104) { strcpy($0, source) } }
    }
    let connection = socket(AF_UNIX, SOCK_STREAM, 0)
    guard connection >= 0 else { throw HookFailure.rejected }
    defer { close(connection) }
    let connected = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(connection, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0 else { throw HookFailure.rejected }
    let resident = try hookPeer(connection)
    try hookValidateBundledProcess(resident, identifier: hookRuntimeIdentifier, filename: "node")
    try hookValidateBundledProcess(hookParent(resident), identifier: hookApplicationIdentifier, filename: "provenance-app-host")
    let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
    let node = contents.appendingPathComponent("MacOS/node").path
    let module = contents.appendingPathComponent("Resources/spikes/coding/hook-receiver.mjs").path
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions); defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_adddup2(&actions, connection, 3)
    posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
    posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
    let arguments: [String] = [node, module, args[1], args[2]]
    let values: [UnsafeMutablePointer<CChar>?] = arguments.map { $0.withCString { strdup($0) } } + [nil]
    defer { for value in values { free(value) } }
    var emptyEnvironment: [UnsafeMutablePointer<CChar>?] = [nil]
    let spawned = values.withUnsafeBufferPointer { pointers in
      posix_spawn(&receiverChild, node, &actions, nil, UnsafeMutablePointer(mutating: pointers.baseAddress!), &emptyEnvironment)
    }
    guard spawned == 0 else { throw HookFailure.rejected }
    var status: Int32 = 0
    while waitpid(receiverChild, &status, 0) < 0 && errno == EINTR {}
  }
}
