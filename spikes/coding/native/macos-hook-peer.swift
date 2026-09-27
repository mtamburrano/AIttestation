import Darwin
import Foundation

@main struct HookPeerValidator {
  static func main() {
    do {
      let args = CommandLine.arguments
      try hookValidateBundle()
      if args.count == 3, args[1] == "--identity", args[2].hasPrefix("/") {
        let result = ["profile": "pap-coding-code-identity/1", "codeHash": try hookCodeIdentity(args[2])]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .withoutEscapingSlashes]))
        exit(0)
      }
      guard args.count >= 6, (args.count - 2) % 4 == 0, ["codex", "claude-code"].contains(args[1]),
            (args.count - 2) / 4 <= (args[1] == "codex" ? 4 : 1) else { throw HookFailure.rejected }
      var enrolled = Set<String>()
      for offset in stride(from: 2, to: args.count, by: 4) {
        guard args[offset].hasPrefix("/"), enrolled.insert(args[offset]).inserted,
              args[offset + 1].range(of: "\\A[a-f0-9]{40}([a-f0-9]{24})?\\z", options: .regularExpression) != nil,
              (args[offset + 2] == "-" && args[offset + 3] == "-") || (args[offset + 2].hasPrefix("/")
                && args[offset + 1].count == 64
                && args[offset + 3].range(of: "\\A[a-f0-9]{40}([a-f0-9]{24})?\\z", options: .regularExpression) != nil)
        else { throw HookFailure.rejected }
      }
      // The fixed native deadline guard owns the socket directly. Never accept
      // a caller-supplied PID or an arbitrary bundled interpreter as the hook.
      let launcher = try hookPeer(3)
      try hookValidateBundledProcess(launcher, identifier: hookLauncherIdentifier, filename: "provenance-hook-receiver")
      var candidate = try hookParent(launcher)
      // Codex's documented shell form may add one system shell. Exec-form
      // Claude hooks normally have the enrolled client as the immediate parent.
      for _ in 0..<2 {
        if ["/bin/sh", "/bin/bash", "/bin/zsh"].contains(try hookProcessPath(candidate)) { candidate = try hookParent(candidate) }
      }
      let path = try hookProcessPath(candidate), arguments = try hookArguments(candidate)
      // Select from the bounded enrollment using the actual kernel-derived
      // ancestor. A shared vendor signature or caller-supplied path is insufficient.
      var selected: (hash: String, script: Bool)?
      for offset in stride(from: 2, to: args.count, by: 4) {
        if args[offset + 2] == "-" && path == args[offset] {
          selected = (args[offset + 1], false); break
        }
        if args[offset + 2] != "-" && arguments.dropFirst().first == args[offset] && path == args[offset + 2] {
          guard try hookDigest(args[offset]) == args[offset + 1] else { throw HookFailure.rejected }
          selected = (args[offset + 3], true); break
        }
      }
      guard let selected else { throw HookFailure.rejected }
      try hookValidateEnrolledProcess(candidate, codeHash: selected.hash)
      let options = Array(arguments.dropFirst(selected.script ? 2 : 1))
      // Noninteractive entrypoints are not promised as ordinary human input.
      guard !options.contains(where: { ["exec", "review", "-p", "--print", "--output-format", "--input-format"].contains($0)
        || $0.hasPrefix("--print=") || $0.hasPrefix("--input-format=") || $0.hasPrefix("--output-format=") }) else { throw HookFailure.rejected }
      let result: [String: Any] = ["profile": "pap-coding-peer/1", "client": args[1], "origin": "enrolled-local-executable"]
      FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .withoutEscapingSlashes]))
      exit(0)
    } catch { exit(1) }
  }
}
