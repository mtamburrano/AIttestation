# Private development readiness

Local inspection on 2026-09-13 found Apple-silicon macOS 15.7.9, Node 22.23.1,
the existing native Go tools and an available Developer ID signing identity.
Installed Chrome is 152.0.7977.83; the authenticated adapter pins major 153.
The dedicated `attestamp-test` macOS user is absent. The owner supplied the existing
helper provisioning profile path; the file exists, but reading its contents returns
`EPERM` even outside the tool sandbox. Current profile validity is therefore
unverified; retain the original and copy it to a readable private input directory.
No operational vault or browser was launched.

The private build, account guard, registration lifecycle and local TLS sponsor
tooling are implemented. All 170 Node regression tests pass, including the five
private-development tests. Both the consumer and recipient browser fixtures pass
in fresh Chrome profiles with a mock Keychain and no external requests. Native
tests verify rejection before bundled code runs in
an ordinary account; TLS fixtures exercise real certificate validation and the
existing managed protocol without external services or funded accounts.

Installed private build/start/pairing remains **NOT RUN**. Live ChatGPT, live
TestNet sponsorship/confirmation, Keychain reopen in the dedicated user, all three
modes through installed Chrome, and installed export/recovery/verifier behavior
remain unverified. The private backup/restore commands have isolated coverage for
fresh keys, unchanged source storage during restore, portable restored receipts and
rejection of wrong recovery secrets without creating keys or restoring authority.

Next prerequisites: a supported Chrome 153 installation, readable access to the
existing helper provisioning profile, and the dedicated macOS test user. Then prepare/sign the
private bundle and perform the documented installed walkthrough. This record is
content-free engineering evidence, not owner acceptance or publication approval.
