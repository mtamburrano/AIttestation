# Historical validation — pre-ON/OFF implementation

This report is preserved from baseline `0ca707e7f7aedb311d8f278c09c49ed39eb6eee8`.
Its installed checks, counts and legacy behavior do not validate the current
ON/OFF contracts. See [current readiness](READINESS.md).

---

# Private development readiness

The isolated Chrome launch, signed desktop startup, native pairing, restart and
recovery are verified. Installed authenticated IPC and rejection without an
enrolled provider scope also pass.
Integrated acceptance remains incomplete; these checks are content-free engineering
evidence, not owner acceptance or publication approval.

The owner subsequently reported enabling App Management for Attestamp during these
checks. macOS logs identify the isolated Chrome process attempting a hard link to
its own executable, with Attestamp recorded as the responsible application. That
operation matches [Chromium's signed-app clone maintenance](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.37/chrome/browser/mac/code_sign_clone_manager.mm).
The development runtime now opens the validated Chrome copy through LaunchServices
instead of spawning its executable directly. The owner disabled the grant, and
macOS recorded the Attestamp permission as denied. Subsequent logs attribute the
browser to Chrome itself. No additional entitlement or permission was added.

With the grant disabled, signed startup, native pairing, all three modes' rejection
without a provider scope, restart, re-pairing and cleanup pass. Both live browsers
passed strict Google identity/team validation and used the isolated profile and
update-suppression flags. Their executable hashes matched the original Chrome.
The extra diagnostic initially rejected an alternate kernel-reported executable
path. A follow-up established that it was another hard link to the same file. The
test inspector now checks owner, regular-file type, device/inode identity and the
known executable digest, alongside the unchanged live Google signature check.
Production ancestry checks and the development guard against preexisting hard
links remain unchanged. Prior failure reports were retained; the final check
closed only the verified test Chrome and removed owned native registration.

Local inspection on 2026-09-13–14 found Apple-silicon macOS 15.7.9, Node 22.23.1,
the existing native Go tools and Chrome 153.0.8010.37. The dedicated standard
`attestamp-test` user has an initialized login Keychain. The owner supplied an
updated helper provisioning profile authorizing the existing Developer ID signing
certificate. Its CMS signature, exact certificate fingerprint, team, helper App ID,
Keychain group and all-devices declarations pass validation. It expires on
2044-09-08. Both original profile files remain unchanged.

The prepared app and standalone verifier pass deep strict Apple/team signature
checks. The helper's signed entitlements name the intended app/team and Keychain
group; Node has only the JIT entitlement. Inventories match the recorded digests.
The earlier profile authorized a different certificate: macOS rejected that helper
with AMFI error `-413`, “No matching profile found,” despite static signature
validity. Refreshing only the helper profile, helper signature and enclosing app
signature resolved this blocker. Other nested signatures and the standalone
verifier remained unchanged; previous profiles and builds were retained.

Private preparation now compares the exact certificate fingerprint against the
profile's `DeveloperCertificates` before creating output or signing. Checking the
existing mismatched pair returns `PRIVATE_HELPER_SIGNING_CERTIFICATE_MISMATCH`,
creates no build directory and requests no signing access. The existing profile
and signing-key permissions remain unchanged. The updated pair passes this same
preflight; certificate/profile validation was not weakened.

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
created, and no test-user GoogleUpdater directory appeared. The direct browser
probe exited normally. No personal browser profile, shared Chrome app,
updater preference or operational vault was modified. Both the CLI and signed
development runtime validate the selected copy; production packaging and native
Chrome ancestry requirements are unchanged.

Installed diagnosis also exposed a trailing newline in the bundled canonical
trust configuration. Removing that single byte fixes configuration parsing while
retaining strict canonical validation. A regression first reproduced the failure,
then passed default-config startup and reopen using a fresh temporary vault,
an injected memory Keychain and loopback IPC. The corrected private app retains
unchanged nested signatures and verifier bytes. Private startup diagnostics now
emit only fixed failure labels. The terminal CLI now preserves those labels
instead of replacing colon-separated startup codes with a generic error; unknown
labels, private data and extra lines remain filtered.

All 178 automated regression tests pass with no skips. The suite covers isolated
account/registration lifecycle, rejected
browser copies and identities, local TLS sponsorship, three protection modes,
failures, persistence, recovery and portable verification. These fixtures do not
establish the installed Keychain/native/provider boundaries. The private recovery
fixtures verify fresh keys, unchanged source storage, portable restored receipts
and rejection of incorrect recovery secrets without restored send authority.

With the updated profile, startup returned `KEYCHAIN_LOCKED` in the test user's
background GUI session. Keeping that user active at the console allowed the signed
app to open its actual Keychain-backed vault and composer. Invalid bearer tokens
and origins were rejected. Continuous, Sealed and Always Protect each rejected an
unpaired synthetic submission and retained no content receipts. The app reported
development status and unconfigured sponsorship. Stop drained the runtime and
removed its launch request and owned native registration.

The running isolated Chrome temporarily held a second executable hard link.
Quitting restored the single link; the development copy guard remains unchanged.
The app-launched browser initially stayed open after stop, as the launcher contract
permits. The diagnostic cleanup helper rejected a process-path mismatch. After
the owner quit the isolated browser, restart reopened the actual Keychain-backed
vault with no enrollment, versions or receipts. The second stop removed owned
registration and the restarted test browser exited. The walkthrough requires
quitting test Chrome between starts and keeping the test user active during
Keychain operations.

The signed maintenance host completed an encrypted backup with a separate
owner-only recovery key and restored it into a fresh vault with new Keychain
identities. The restore reopened successfully, retained no send authority and did
not replace the active vault. Inspection authenticated the retained snapshot and
verified that its sole record is an empty release journal, with no seals, attempts
or content receipts. A harness assertion initially confused zero receipts with
zero vault records; that failure report and both recovery directories were retained.

Installed native pairing passed with the pinned unpacked extension, zero provider
tabs and no provider login. The first handshake exposed a serialization mismatch:
Swift's default JSON writer escaped the slash in the profile identifier, which the
JavaScript canonical parser correctly rejected. The native writer now emits
unescaped slashes. A regression compiles its actual output boundary with fixture
identity input: it reproduced `Non-canonical JSON` before the change and passes
afterward. Identity, signature, ancestry, version and canonical-parser checks remain
unchanged. Only the peer validator and enclosing app needed refreshed signatures;
the helper profile, other nested signatures and verifier were retained.

The corrected app accepted the authenticated native connection and rejected
Continuous, Sealed and Always Protect without an enrolled provider scope. After
Chrome and app restart, the installed extension paired again through the same
native checks. Both stops removed owned registration, and the test Chrome exited.
The final pairing checks recorded zero provider tabs and made no content send or
anchoring requests.

Successful sends in all three modes, receipt export and standalone verification
of a real receipt remain pending. Sponsorship is unconfigured in the prepared
example. Live TestNet confirmation remains unverified, and a reserved ChatGPT test
account is unavailable. These installed checks establish local startup, connection
and recovery behavior; they do not establish the current provider DOM boundary.
