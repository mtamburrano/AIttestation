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
The existing app and verifier were rechecked after copying into a fresh staging
directory; both signatures remain valid, so these local checks need no new signing.

The installed Chrome executable currently fails strict Google signature validation
with `resource fork, Finder information, or similar detritus not allowed`. Inspection
found 62 `com.apple.FinderInfo` attributes on bundle directories. On a fresh copy,
backing up and removing only those attributes made the unchanged Google signature
requirement pass, with all file bytes unchanged. The installed Chrome app has not
been modified; the exact metadata cleanup is awaiting its owner's permission.
The launcher now reports `CHROME_SIGNATURE_REJECTED` for this failure.

The account guard, registration lifecycle and local TLS sponsor tooling are
implemented. The preceding full Node regression run passed all 171 tests, including
the five private-development tests. Both the consumer and recipient browser fixtures passed
in fresh Chrome profiles with a mock Keychain and no external requests. Native
tests verify rejection before bundled code runs in
an ordinary account; TLS fixtures exercise real certificate validation and the
existing managed protocol without external services or funded accounts. Real
signature checks accept the matching identity and reject different identities and
tampered code. The signed private app also rejects a different signing-team
requirement during verification. The 24 focused private-development and distribution
checks also pass after the browser diagnostic change. An initial sandbox run denied
two fixture loopback listeners; the isolated rerun with loopback access passed.

Installed private startup/pairing remains **NOT RUN**. Live ChatGPT, live
TestNet sponsorship/confirmation, Keychain reopen in the dedicated user, all three
modes through installed Chrome, and installed export/recovery/verifier behavior
remain unverified. The private backup/restore commands have isolated coverage for
fresh keys, unchanged source storage during restore, portable restored receipts and
rejection of wrong recovery secrets without creating keys or restoring authority.

Next prerequisite for installed startup is resolving the browser signature failure.
A designated ChatGPT test account is currently unavailable, so live provider checks
remain blocked separately. The existing build suffices for local startup, unpaired
rejection, restart and empty-vault recovery once the browser passes validation.
For live anchoring, configure the local sponsor, prepare a fresh bundle with its
public certificate and perform the documented installed walkthrough.
This record is content-free engineering evidence, not owner acceptance or
publication approval.
