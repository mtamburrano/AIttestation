import Darwin
import Foundation

private func deadlineHandler(_ signal: Int32) {
  _exit(0)
}

@main struct HookReceiver {
  static func main() {
    signal(SIGALRM, deadlineHandler); signal(SIGPIPE, SIG_IGN)
    // Reserve part of the 250 ms fail-open ceiling for native startup and timer
    // scheduling. Ordinary admission finishes well before this watchdog.
    var deadline = itimerval(it_interval: timeval(tv_sec: 0, tv_usec: 0), it_value: timeval(tv_sec: 0, tv_usec: 200000))
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
    // Forward opaque bounded stdin to the authenticated resident. Vendor JSON
    // decoding stays in the shared modules; no runtime is spawned per prompt.
    var input = Data(), buffer = [UInt8](repeating: 0, count: 16384)
    while true {
      let count = read(STDIN_FILENO, &buffer, buffer.count)
      if count < 0 && errno == EINTR { continue }
      guard count >= 0, input.count + count <= 1024 * 1024 else { throw HookFailure.rejected }
      if count == 0 { break }
      input.append(contentsOf: buffer.prefix(count))
    }
    var chunks: [String] = []
    for offset in stride(from: 0, to: input.count, by: 128 * 1024) {
      chunks.append(input.subdata(in: offset..<min(offset + 128 * 1024, input.count)).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""))
    }
    let profile = "pap-hook-admission/2"
    try send(connection, ["profile": profile, "kind": "ADMIT", "client": args[1],
      "installationId": args[2], "invocationId": UUID().uuidString.lowercased(), "input": chunks])
    let admitted = try response(connection, profile: profile, state: "ADMITTED")
    try send(connection, ["profile": profile, "kind": "RELEASE", "eventId": admitted])
    guard try response(connection, profile: profile, state: "RELEASED") == admitted else { throw HookFailure.rejected }
  }
  static func send(_ descriptor: Int32, _ message: [String: Any]) throws {
    var bytes = try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys, .withoutEscapingSlashes])
    bytes.append(10)
    try bytes.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let count = write(descriptor, raw.baseAddress!.advanced(by: offset), raw.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw HookFailure.rejected }
        offset += count
      }
    }
  }
  static func response(_ descriptor: Int32, profile: String, state: String) throws -> String {
    var bytes = Data(), buffer = [UInt8](repeating: 0, count: 1024)
    while true {
      let count = read(descriptor, &buffer, buffer.count)
      if count < 0 && errno == EINTR { continue }
      guard count > 0, bytes.count + count <= 1024 else { throw HookFailure.rejected }
      bytes.append(contentsOf: buffer.prefix(count))
      if bytes.contains(10) { break }
    }
    guard bytes.last == 10, bytes.dropLast().contains(10) == false,
          let message = try JSONSerialization.jsonObject(with: bytes.dropLast()) as? [String: String],
          Set(message.keys) == Set(["profile", "state", "eventId"]), message["profile"] == profile,
          message["state"] == state, let eventId = message["eventId"], UUID(uuidString: eventId) != nil,
          try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys, .withoutEscapingSlashes]) == bytes.dropLast()
      else { throw HookFailure.rejected }
    return eventId
  }
}
