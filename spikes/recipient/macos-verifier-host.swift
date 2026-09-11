import Foundation
import Security

// This host has no vault, Keychain broker or caller-selected script entrypoint.
do {
  var code: SecStaticCode?
  guard Bundle.main.bundleIdentifier == "ai.provenance.verifier.host",
        SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, SecCSFlags(), &code) == errSecSuccess,
        let code,
        SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures), nil) == errSecSuccess else {
    exit(EXIT_FAILURE)
  }
  let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
  let child = Process()
  child.executableURL = contents.appendingPathComponent("MacOS/node")
  child.arguments = [contents.appendingPathComponent("Resources/spikes/recipient/main.mjs").path, "--open"]
  child.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
  try child.run(); child.waitUntilExit(); exit(child.terminationStatus)
} catch { exit(EXIT_FAILURE) }
