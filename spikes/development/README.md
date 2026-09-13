# Private Mac development

This route prepares the actual trusted composer, encrypted durable vault, native
bridge and unpacked ChatGPT extension for a **dedicated macOS test user**. Builds
retain the frozen app, helper, Keychain group, native host and extension IDs.
Developer ID signing and the existing helper provisioning profile remain required.
Notarization, Store publication, public DNS/CDN and billing are separate release
steps. A private build has no update channel or installed production metadata.

The [readiness record](READINESS.md) distinguishes implemented tooling, automated
fixtures and the installed checks still needed. The private installed flow has
not yet been validated. Do not treat these instructions as owner acceptance.

## Prepare once

Use Apple-silicon macOS 15.7+, self-contained Node 22.13+, Xcode command-line tools,
and **Google Chrome Stable major 153**. The adapter accepts that exact major;
Chrome 152, newer unvalidated majors and Chrome for Testing fail closed. Do not
change the manifest or spoof browser identity to get past this check.

In System Settings, create a fresh standard local user with short name
`attestamp-test`. Keep it free of personal browser/provider accounts and production
Attestamp data. Sign in interactively to unlock its own login Keychain. The native
private app rejects every other account **before opening storage or Keychain**.
The JavaScript launcher also checks the real OS username/home, independently of
environment variables. Do not run this workflow with `sudo` or a substituted HOME.

Build the existing pinned Go tools using the [Algorand instructions](../anchor/algorand/README.md).
On a fresh checkout, select an installed Go toolchain compatible with `go.mod`
(at least 1.25.1) and allocate dedicated caches. This step may download the pinned
public modules; it uses no provider or sponsor account:

```sh
dev_go_bin=/absolute/approved-go/bin
dev_go_cache=$(mktemp -d /private/tmp/attestamp-go-test.XXXXXX)
/usr/bin/env -i PATH="$dev_go_bin:/usr/bin:/bin" GOENV=off GOTOOLCHAIN=local GOWORK=off GOTELEMETRY=off \
  GOMODCACHE="$dev_go_cache/modules" GOCACHE="$dev_go_cache/build" GOPATH="$dev_go_cache/path" \
  GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
  /usr/bin/make -C spikes/anchor/algorand build
```

Retain these explicit cache paths for subsequent local rebuilds; use `GOPROXY=off`
once populated. The app needs `verify`, `fast-verify` and `fast-observe`; sponsorship
also needs `sponsor`. Tools are reused by the private packager and hashed with the
prepared bundle; this is not a release rebuild.

In the signing account, place a 0600 JSON config outside the checkout:

```json
{
  "profile": "pap-private-development/1",
  "teamId": "YOURTEAMID",
  "signingIdentity": "FORTY_HEX_CHARACTERS_FROM_SECURITY_FIND_IDENTITY",
  "helperProvisioningProfile": "/absolute/private/helper.provisionprofile",
  "sponsor": null
}
```

Use the existing Developer ID identity's 40-character hash and the matching
all-devices helper profile. The profile must authorize
`TEAM.ai.provenance.keychain-helper` and `TEAM.ai.provenance.evidence-vault`.
`security find-identity -v -p codesigning` reads available identity metadata.
The builder validates the profile and signs the nested helper with its Keychain
entitlements; Node receives only the existing JIT entitlement. Signing uses no
timestamp service or notarization request. No test authority is added to a
production configuration.

```sh
npm run dev -- prepare /absolute/private/dev-config.json /absolute/new/private-build
```

macOS may display Keychain prompts for `codesign` to use the existing Developer ID
key. Complete those prompts in the signing account. **Allow** grants one use, so
the separately signed executables can each prompt again. **Always Allow** grants
`codesign` continuing access to that particular signing key, including future
builds; choosing that persistent permission is the signing account owner's
decision. See [Apple's explanation](https://developer.apple.com/forums/thread/712005).
The builder does not change Keychain permissions. A signing step has a ten-minute
deadline; `PRIVATE_PREPARE_SIGNING_TIMED_OUT` leaves an incomplete output. After
resolving the prompt, rerun preparation with a new output directory.

Each output must be new, canonical and outside repositories. The builder records
the current source digest, so ordinary local changes need no release approval or
clean-checkout gate. It never registers a host, starts Chrome or opens an evidence
vault. Keep signing credentials in the signing account. Copy the **whole output**
into the test user's home and give that user ownership; do not share a signing
private key. The output contains only the public sponsor certificate, if configured.
Its app can be relocated before registration.

In the test user's fresh checkout, before opening Chrome or the app:

```sh
npm run dev -- init
npm run dev -- doctor
```

`CHROME_SIGNATURE_REJECTED` means the installed browser did not pass the unchanged
Google signature requirement, even if its major version is correct. Inspect it
without modifying the app:

```sh
/usr/bin/codesign --verify --strict -R '=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"' '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/usr/bin/xattr -lr '/Applications/Google Chrome.app'
```

The `resource fork, Finder information, or similar detritus not allowed` error can
come from Finder metadata, as [Apple explains](https://developer.apple.com/library/archive/qa/qa1940/_index.html).
Diagnose any cleanup on a copy first, preserve a backup of the exact affected
attributes, and obtain the installed app owner's permission before changing it.
Do not skip signature validation or clear all extended attributes automatically.

Initialization refuses any existing test control, vault-support or Chrome directory.
This is intentional: do not remove existing data to make it pass. Use a freshly
created dedicated account. Native registration lives in that user's explicit
`Library/Application Support/Google/Chrome/NativeMessagingHosts`, following
[Chrome's native messaging contract](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
The vault and Keychain namespace belong to the separate OS account; no production
account is read or modified. The browser is launched with that explicit user-data
directory, without inherited Node/TLS/proxy options or a debug port.

## Local sponsorship, with real TestNet confirmation

The developer sponsor can run in either local account. Create its new resource
outside every checkout; initialization makes no external calls:

```sh
npm run dev:sponsor -- init /absolute/new/private-sponsor 37461
```

It generates a fresh TestNet-only signing seed, a 30-day loopback TLS certificate,
one seven-day test access code and an isolated durable ledger. Fund **only the
printed new public address** with free TestNet faucet ALGO. Never import an existing
account or use MainNet/paid funds. The seed and TLS private key stay in this directory;
the access code is in its owner-only `access.json`. Total ledger capacity is ten
anchor reservations, with 1,000 microALGO fees and the existing bounded replay policy.
Restarting cannot reset quotas or sign replacement transactions.

Set `sponsor` in the private build config and prepare a fresh app:

```json
"sponsor": {
  "origin": "https://127.0.0.1:37461",
  "certificateFile": "/absolute/private-sponsor/tls-cert.pem"
}
```

Start the local server only for an explicitly chosen live TestNet run:

```sh
npm run dev:sponsor -- serve /absolute/private-sponsor --live-testnet
```

The client trusts only the certificate copied into its signed private bundle. Do
not install this CA globally or disable TLS verification. The server binds loopback,
uses the existing bounded managed protocol, and supplies submission information
only. The app still asks the pinned AlgoNode and Nodely observers and runs the real
Go fast-confirmation verifier. A local response, fake transaction ID or fixture
cannot authorize protected release. No public backend or DNS is required.

## Start, test, restart, stop

In the test user, using only a designated test ChatGPT account and synthetic text:

```sh
npm run dev -- start /absolute/copied/private-build --live-chatgpt-testnet
```

This is the explicit live-boundary opt-in. It opens the local composer in the
isolated Chrome directory. Visit `chrome://extensions`, enable Developer mode and
load the output's `extension` directory unpacked. Verify its unchanged ID is
`medilhopfckldjgdnchfkpmfmfnkadca`. Open one empty `https://chatgpt.com/` tab and
sign into the designated test account. Enter protected text only in the local
composer. Its banner identifies private development; no Store connection is needed.

While a designated ChatGPT account is unavailable, local startup, rejection while
unpaired, stop/restart and an empty-vault backup/restore can be checked in the test
user. Leave provider tabs closed and sponsorship unconfigured. These checks do
not establish installed pairing, successful sends in any mode, receipt export or
live TestNet confirmation. A GUI login must remain active; Fast User Switching
back to the signing account is fine, but logging out ends that test session.

1. Connect anchoring using the local sponsor's access code. Enroll the one supported
   empty ChatGPT tab. Record only whether authenticated pairing succeeds.
2. Try Continuous with synthetic text: local capture and release precede anchoring.
   Try Sealed: bytes stay local while pending; after independent confirmation,
   choose Send. Try Always Protect: the same confirmation gate releases automatically.
3. Stop the sponsor, edit while pending, add another ChatGPT tab, or disable the
   extension. Strict modes must remain pending or revoke eligibility; no downgrade
   or automatic resend is allowed. Refresh/re-enroll only as the app requires.
4. Export a selected receipt using its disclosure preview. Open the bundled
   `Recipient/Attestamp Verifier.app` to check it without the sponsor. An export
   with only fast evidence does not become consensus-verified or prove authorship.
5. Stop, close test Chrome, then start again using the same command. Reload the
   extension if Chrome requires it. Check persisted receipts and fresh enrollment;
   old interrupted versions must never gain send authority after restart.

```sh
npm run dev -- stop
```

Stop drains the runtime through its authenticated local endpoint and removes only
the registration matching this workflow's ownership journal. It never kills a PID
read from disk, closes other browser sessions or deletes evidence. Close test Chrome
manually, and use Ctrl-C in the sponsor terminal. If startup was interrupted, use
`stop` before retrying. A changed registration fails cleanup and needs inspection.

After stopping, use the private app's fixed native host to back up its actual vault:

```sh
npm run dev -- backup /absolute/copied/private-build /Users/attestamp-test/new-backup
npm run dev -- restore /absolute/copied/private-build /Users/attestamp-test/new-restore /Users/attestamp-test/new-backup/encrypted-recovery.json /Users/attestamp-test/.attestamp-private-test/recovery-secrets/PRINTED_FILE.key
```

Backup prints the path of a separate owner-only recovery key, never the key itself.
Keep it separately from the encrypted package. Restore authenticates the complete
snapshot, creates a fresh vault and Keychain identities, reopens it to verify key
persistence, and writes `recovery-report.json` plus one portable plaintext file per
receipt. Open these receipts in the bundled verifier. The original active vault
stays in place; restored history has no send authority and is never connected to
the bridge. These developer commands make no provider/sponsor calls. They accept
only paths inside the test user's home, require new output directories outside
repositories and the active control/vault/browser directories, and bound recovery
input to 16 MiB. Receipt export alone is not a recovery backup.

If an interrupted maintenance command leaves `operation.json` in the test control
directory, inspect and save that report before removing that one file and retrying.
An existing backup/restore destination is never reused or cleared automatically.

## Offline fixtures and cleanup

```sh
npm run test:private-dev
npm run test:chatgpt
npm run test:consumer-browser
npm run test:recipient-browser
npm test
```

The new tests use fresh temporary resources, an actual loopback TLS server,
generated test certificates/keys and synthetic sponsorship. They prove ordinary
accounts cannot launch the private native host, conflicting registrations are
preserved, and fixture replies cannot pass the real confirmation verifier. The
ChatGPT regressions exercise native framing with injected peer/provider fixtures;
they do not establish installed Chrome ancestry or current provider markup.
The consumer-browser fixture exercises all modes, export, fresh recovery and free
verification with a synthetic loopback provider. Its reports say `FIXTURE_VERIFIED`,
never public-network assurance. No default test uses a real provider or live sponsor.
The headless browser fixtures use Chrome's mock Keychain so they do not access the
ordinary user's browser credential store. The actual private app uses its normal
provisioned Keychain helper in the separate macOS account.

For a visible synthetic rehearsal, `npm run demo:consumer -- --open` creates a
fresh temporary store/profile and blocks external DNS. Its ephemeral keys require
saving both the encrypted recovery package and separate recovery secret before
stopping. This laboratory is not the persistent, Keychain-backed private app.

Automatic test cleanup removes only directories created by that invocation.
Private app stop preserves its account, vault, keys and browser state. After the
installed recovery check, exports and logs have been saved, remove the **dedicated
test user** using System Settings if desired. Delete only the exact build/sponsor
directories created for this rehearsal, after stopping them. Never reset an
existing operational vault, browser profile, Keychain or sponsorship ledger.
