# Private development readiness

Local inspection on 2026-09-13 found Apple-silicon macOS 15.7.9, Node 22.23.1,
the existing native Go tools and an available Developer ID signing identity.
Installed Chrome is now 153.0.8010.37, matching the authenticated adapter's pinned
major. The dedicated standard `attestamp-test` macOS user exists and has an active
GUI login after Fast User Switching. The owner's copy of the existing
helper provisioning profile is readable. Its embedded CMS signature verifies;
macOS decoding and the team, helper App ID, Keychain group and all-devices checks
pass. The profile expires on 2044-09-07. The original profile was not replaced.
No operational vault or browser was launched.

Private preparation completed with the existing Developer ID identity and profile.
Both the application and standalone verifier pass deep, strict signature checks
against the expected Apple/team requirement. The helper has exactly the intended
application/team entitlements and evidence-vault Keychain group; both Node runtimes
have only the JIT entitlement. Bundle inventories match the recorded digests. This
prepared example has sponsorship unconfigured and no notarization or update channel.
The updated private app supports an explicit test-user Chrome copy. Its existing
nested helper/runtime signatures and standalone verifier were retained; only the
outer app needed a new Developer ID signature. Both bundles pass deep strict
Apple/team validation after the change.

The shared Chrome executable fails strict Google signature validation because of
62 `com.apple.FinderInfo` attributes on bundle directories. The private route now
uses an explicit canonical copy inside the test user's home. On a fresh staging
copy, backing up and removing only those attributes made the unchanged Google
signature/team requirement pass. Every file's bytes and the complete tree inventory
match the shared source; the source bytes and FinderInfo attributes stayed unchanged.
The main Chrome executable's SHA-256 in both is
`83dfc7d9e4fde4272ced1c0cc8d3584d3b5d3d3bdac46978ee05031e8c2ae3c2`.
No shared app cleanup or updater preference change is needed.

Both the CLI and the signed development runtime validate the selected copy's
ownership, canonical paths, strict Google identity and supported major. Production
packaging and the native Chrome ancestry requirement are unchanged. The private
launch supplies the real test HOME and isolated user-data directory, and disables
the updater scheduler and component updates for that process. Live launch in the
test user's GUI session is still pending the local administrator transfer prompt.

The account guard, registration lifecycle and local TLS sponsor tooling are
implemented. All 173 Node regression tests pass, including seven private-development
tests. The added checks reject shared locations, symlinks, hard-linked executables,
writable copies and an ad hoc-signed Chrome lookalike. Both the consumer and recipient browser fixtures previously passed
in fresh Chrome profiles with a mock Keychain and no external requests. Native
tests verify rejection before bundled code runs in
an ordinary account; TLS fixtures exercise real certificate validation and the
existing managed protocol without external services or funded accounts. Real
signature checks accept the matching identity and reject different identities and
tampered code. The signed private app also rejects a different signing-team
requirement during verification. The new development validator also accepts the
actual isolated Google-signed staging copy without launching it.

Installed private startup/pairing remains **NOT RUN**. Live ChatGPT, live
TestNet sponsorship/confirmation, Keychain reopen in the dedicated user, all three
modes through installed Chrome, and installed export/recovery/verifier behavior
remain unverified. The private backup/restore commands have isolated coverage for
fresh keys, unchanged source storage during restore, portable restored receipts and
rejection of wrong recovery secrets without creating keys or restoring authority.

The browser-copy signature prerequisite is satisfied. A designated ChatGPT test
account is currently unavailable, so live provider checks remain blocked separately.
The updated build supports local startup, unpaired rejection, restart and empty-vault recovery.
For live anchoring, configure the local sponsor, prepare a fresh bundle with its
public certificate and perform the documented installed walkthrough.
This record is content-free engineering evidence, not owner acceptance or
publication approval.
