# Private development readiness

Local inspection on 2026-09-13 found Apple-silicon macOS 15.7.9, Node 22.23.1,
the existing native Go tools and an available Developer ID signing identity.
Installed Chrome is 152.0.7977.83; the authenticated adapter pins major 153.
The dedicated `attestamp-test` macOS user is absent. The owner's copy of the existing
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

The account guard, registration lifecycle and local TLS sponsor tooling are
implemented. All 171 Node regression tests pass, including the five
private-development tests. Both the consumer and recipient browser fixtures pass
in fresh Chrome profiles with a mock Keychain and no external requests. Native
tests verify rejection before bundled code runs in
an ordinary account; TLS fixtures exercise real certificate validation and the
existing managed protocol without external services or funded accounts. Real
signature checks accept the matching identity and reject different identities and
tampered code. The signed private app also rejects a different signing-team
requirement during verification.

Installed private startup/pairing remains **NOT RUN**. Live ChatGPT, live
TestNet sponsorship/confirmation, Keychain reopen in the dedicated user, all three
modes through installed Chrome, and installed export/recovery/verifier behavior
remain unverified. The private backup/restore commands have isolated coverage for
fresh keys, unchanged source storage during restore, portable restored receipts and
rejection of wrong recovery secrets without creating keys or restoring authority.

Next prerequisites: a supported Chrome 153 installation and the dedicated macOS
test user. Configure the local sponsor for live anchoring, prepare a fresh bundle
with its public certificate and perform the documented installed walkthrough.
This record is content-free engineering evidence, not owner acceptance or
publication approval.
