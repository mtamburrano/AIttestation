# Private development readiness

The isolated Chrome launch is verified. Installed desktop startup is blocked by
a Developer ID certificate/provisioning mismatch. Integrated acceptance remains
incomplete; these checks are content-free engineering evidence, not owner
acceptance or publication approval.

Local inspection on 2026-09-13–14 found Apple-silicon macOS 15.7.9, Node 22.23.1,
the existing native Go tools and Chrome 153.0.8010.37. The dedicated standard
`attestamp-test` user has an active GUI login. The existing helper profile is
readable, its CMS signature verifies, and its team, helper App ID, Keychain group
and all-devices declarations pass validation. It expires on 2044-09-07 and was not
replaced.

The prepared app and standalone verifier pass deep strict Apple/team signature
checks. The helper's signed entitlements name the intended app/team and Keychain
group; Node has only the JIT entitlement. Inventories match the recorded digests.
However, the profile's authorized certificate differs from the available signing
identity. No matching private signing identity was available locally. During the
installed check, macOS rejected the helper with AMFI error `-413`, “No matching
profile found.” This occurs before the helper can access the Keychain. Static
signature validity therefore does not establish installed usability.

Private preparation now compares the exact certificate fingerprint against the
profile's `DeveloperCertificates` before creating output or signing. Checking the
existing mismatched pair returns `PRIVATE_HELPER_SIGNING_CERTIFICATE_MISMATCH`,
creates no build directory and requests no signing access. The existing profile
and signing-key permissions remain unchanged. Resume with a matching authorized
profile/identity pair and refresh the helper and enclosing app signatures.

The shared Chrome app has 62 `com.apple.FinderInfo` attributes that cause strict
signature validation to fail. A fresh isolated copy received only metadata cleanup,
with the original attributes backed up. Every file's bytes and the complete tree
inventory matched the source; source bytes and attributes stayed unchanged.
The test-user-owned copy then passed strict Google signature/team checks and
launched in that user's Aqua session. A live process check verified Google's
identity, UID 503 and the actual executable path inside the selected copy.
Its executable SHA-256 still matched the shared source:
`83dfc7d9e4fde4272ced1c0cc8d3584d3b5d3d3bdac46978ee05031e8c2ae3c2`.

The live Chrome process used the dedicated user-data directory and explicit
updater-scheduler/component-update suppression. Its isolated profile state was
created, and no test-user GoogleUpdater directory appeared. The owned browser
process exited after each check. No personal browser profile, shared Chrome app,
updater preference or operational vault was modified. Both the CLI and signed
development runtime validate the selected copy; production packaging and native
Chrome ancestry requirements are unchanged.

Installed diagnosis also exposed a trailing newline in the bundled canonical
trust configuration. Removing that single byte fixes configuration parsing while
retaining strict canonical validation. A regression first reproduced the failure,
then passed actual default-config startup and reopen using a fresh temporary vault,
an injected memory Keychain and loopback IPC. The corrected private app retains
unchanged nested signatures and verifier bytes. Private startup diagnostics now
emit only fixed failure labels, with tests against private-data disclosure.

All 176 automated regression tests pass with no skips. The suite covers isolated
account/registration lifecycle, rejected
browser copies and identities, local TLS sponsorship, three protection modes,
failures, persistence, recovery and portable verification. These fixtures do not
establish the installed Keychain/native/provider boundaries. The private recovery
fixtures verify fresh keys, unchanged source storage, portable restored receipts
and rejection of incorrect recovery secrets without restored send authority.

Installed startup was attempted and failed as described above. Installed pairing,
authenticated composer checks, three-mode behavior, Keychain reopen and
export/recovery/verifier checks remain pending. Test launch requests and native
registration were removed after failure; test profile data and prior builds/reports
were retained. Sponsorship is unconfigured in the prepared example. Live TestNet
confirmation remains unverified, and a reserved ChatGPT test account is unavailable.
No provider content was sent or live anchoring requested.
