# Private Mac development

For routine development, start with `npm run test:product` in your current user.
The [local product testing guide](PRODUCT-TESTING.md) covers labelled isolated
fixtures, correlated diagnostics and targeted failure reports. It creates fresh
temporary resources and leaves the retained private installation untouched.

## Persistent private debug sessions

New private builds expose **Settings → Private debug session** in the dashboard.
Choose **Start debug recording** once before testing. A visible dashboard banner
confirms recording; events then append automatically, including bridge failures
and later runtime restarts. **Stop debug recording** persists that choice.
Starting again resumes the same retained session. **Save debug session** downloads
one immutable JSON snapshot of all retained segments; later recording cannot
change that downloaded snapshot. Share it explicitly after testing if needed.
There is no upload or per-operation export requirement.

This uses the existing content-free diagnostic vocabulary and per-runtime HMAC
correlation IDs. Each restart gets a fresh engine epoch and correlation key; no
key or send authority is restored from diagnostics. Prompt bytes, URLs, raw
digests, DOM/error dumps, provider replies, access codes, tokens and recovery keys
are not diagnostic fields. Exports are unencrypted content-free support data;
the downloaded copy remains until the owner deletes it.

The private launcher alone supplies the journal under the validated test control
area, in `debug-session/journal.sqlite`. Recording is off until explicitly enabled.
The journal directory is mode 0700, and its database/WAL files are mode 0600.
An empty owner-only SQLite index marker is temporarily mode 0400 to keep read-only
inspection in memory; malformed session data is rejected before SQLite can
checkpoint it on close. Either owner-only mode (0400 or 0600) can survive an
interrupted inspection. A nonempty or unsafe index file is refused.
SQLite FULL-synchronous WAL commits preserve earlier events after process exit;
each append checkpoints and truncates the WAL. No production launcher loads this
module or reads a debug environment switch. Building these sources does not
update an existing private installation.

After a crash, reopen the already consented private app in Finder. Once the new
engine holds its normal instance lock, it replaces only a validated stale private
runtime locator with its fresh local endpoint. It does not contact the old
endpoint, recover old grants or change integration configuration. The CLI's
explicit stop/start and recovery guards remain in force.

Retention is bounded to 2,048 events, 512 KiB of session JSON, 16 segments and
24 hours; segments hold at most 128 events / 64 KiB. Oldest whole segments rotate
first. Expiry is checked on append, status/export, startup and at least once per
minute while running. Closed apps prune on their next launch. Database and WAL
ceilings are 2 MiB and 4 MiB, including transaction overhead; exports are at most
513 KiB. Invalid paths, permissions, schema, events or clock rollback make debug
recording unavailable. Existing resources are not adopted or repaired. Inspect
the saved files separately before deciding any manual recovery; recording
failure does not change protection behavior.

Run the deterministic private tests without installing or launching the retained
test kit:

```sh
npm run test:debug-session
```

The suite allocates fresh `/private/tmp/pap-debug-test-*` resources, uses synthetic
provider/anchor dependencies, checks process crashes and authority revocation,
rotation/expiry, unsafe files and privacy canaries, and compares recording on/off
against the same product scenarios. It requires local loopback/Unix-socket access.
The signed, installed workflow below is for explicitly scheduled platform checks.

This route prepares the actual trusted composer, encrypted durable vault, native
bridge and unpacked ChatGPT extension for a **dedicated macOS test user**. Builds
retain the frozen app, helper, Keychain group, native host and extension IDs.
Developer ID signing and the existing helper provisioning profile remain required.
Notarization, Store publication, public DNS/CDN and billing are separate release
steps. A private build has no update channel or installed production metadata.

The [readiness record](READINESS.md) distinguishes implemented tooling, automated
fixtures and the installed checks still needed. Do not treat these instructions
as owner acceptance.

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
Its `DeveloperCertificates` must also contain the exact certificate identified by
`signingIdentity`; matching the team alone is insufficient. Preparation checks
this before creating output or requesting signing access and reports
`PRIVATE_HELPER_SIGNING_CERTIFICATE_MISMATCH` if the pair differs. Keep the original
profile and use a matching existing profile/identity pair. If neither is available,
the signing account owner must resolve that prerequisite before rebuilding.
Apple documents this [certificate mismatch](https://developer.apple.com/forums/thread/791996)
even when ordinary signature verification succeeds.
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

The private launcher reports fixed startup labels such as
`PRIVATE_DEVELOPMENT_START_FAILED:KEYCHAIN_LOCKED` or
`PRIVATE_DEVELOPMENT_START_FAILED:KEYCHAIN_OPERATION_FAILED`. These labels exclude
raw errors, paths, tokens and Keychain values. An operation failure can also mean
macOS rejected the helper before it ran; check the profile/certificate pair before
changing Keychain permissions.

Each output must be new, canonical and outside repositories. The builder records
the current source digest, so ordinary local changes need no release approval or
clean-checkout gate. It never registers a host, starts Chrome or opens an evidence
vault. Keep signing credentials in the signing account. Copy the **whole output**
into the test user's home and give that user ownership; do not share a signing
private key. The output contains only the public sponsor certificate, if configured.
Its app can be relocated before registration.

Use a separate copy of Chrome inside the test user's home, owned by that user.
For example, while signed into `attestamp-test`, create a new private directory
and copy the application bytes from the supported installation:

```sh
/bin/mkdir -m 700 /Users/attestamp-test/AttestampPrivateBrowser
/usr/bin/ditto '/Applications/Google Chrome.app' '/Users/attestamp-test/AttestampPrivateBrowser/Google Chrome.app'
```

Keep this copy separate from the vault, control and browser user-data directories.
The development commands require an explicit canonical `--chrome-app` path;
symlinks, shared installations, hard-linked executables and other users' copies
are rejected. No environment variable or production setting selects the browser.
The copied app must still have Google's `com.google.Chrome` identity, team
`EQHXZ8M8AV`, valid strict signature and supported major. Native messaging continues
to authenticate the actual running Chrome parent and ancestry with the same
requirements; moving the signed app needs no native trust exception.

In the test user's fresh checkout, before opening Chrome or Attestamp:

```sh
npm run dev -- init
npm run dev -- doctor --chrome-app '/Users/attestamp-test/AttestampPrivateBrowser/Google Chrome.app'
```

`CHROME_SIGNATURE_REJECTED` means the selected copy did not pass the unchanged
Google signature requirement, even if its major version is correct. Inspect the
copy without modifying the shared installation:

```sh
/usr/bin/codesign --verify --strict -R '=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"' '/Users/attestamp-test/AttestampPrivateBrowser/Google Chrome.app/Contents/MacOS/Google Chrome'
/usr/bin/xattr -lr '/Users/attestamp-test/AttestampPrivateBrowser/Google Chrome.app'
```

The `resource fork, Finder information, or similar detritus not allowed` error can
come from Finder metadata, as [Apple explains](https://developer.apple.com/library/archive/qa/qa1940/_index.html).
If present, back up the exact affected attributes and remove only
`com.apple.FinderInfo` from this test-only copy. Check that the executable hashes
match the source and that strict signature validation now passes. Never clear all
extended attributes, edit signed bundle files or re-sign Chrome. The shared app,
personal profiles and shared updater settings are not part of this workflow.

Initialization refuses any existing test control, vault-support or Chrome directory.
This is intentional: do not remove existing data to make it pass. Use a freshly
created dedicated account. Native registration lives in that user's explicit
`Library/Application Support/Google/Chrome/NativeMessagingHosts`, following
[Chrome's native messaging contract](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
The vault and Keychain namespace belong to the separate OS account; no production
account is read or modified. The browser is launched with that explicit user-data
directory, without inherited Node/TLS/proxy options or a debug port.

Chrome opens through LaunchServices using the validated application path, so
macOS can attribute Chrome's own activity to Chrome. The earlier direct executable
launch attributed Chrome's signed-app clone maintenance to Attestamp and caused an
[App Management](https://support.apple.com/en-mide/guide/mac-help/mchl211c911f/mac)
notification. Updating or deleting other apps is not an
Attestamp test prerequisite. Keep Attestamp disabled in **System Settings → Privacy
& Security → App Management**; stop and investigate if this notification returns.
This permission is separate from signing-key access and the test user's login
Keychain. Installed startup, native pairing, restart and cleanup checks pass with
App Management disabled; see the readiness record for their scope.

## Local sponsorship, with real TestNet confirmation

The developer sponsor can run in either local account. Create its new resource
outside every checkout; initialization makes no external calls:

```sh
npm run dev:sponsor -- init /absolute/new/private-sponsor 37461
```

Initialization creates private files with mode 0600 even under umask 000 and
checks the generated TLS key/certificate and account seed/address pair before
reporting success. To repeat the read-only setup checks for an explicitly
selected sponsor directory, without starting a server or making network calls:

```sh
npm run dev:sponsor -- doctor /absolute/private-sponsor
```

The self-check reports fixed labels and does not repair existing permissions.
The existing owner/permission validation at server startup remains enforced.

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

Quit the isolated Chrome application completely in the test account before each
start or restart; closing its windows alone may leave it running. During the
installed check, the running browser temporarily held a second hard link to its
executable, which the development copy guard rejects. Quitting restored the single
link. Keep that guard enabled and let the private launcher start Chrome.

In the test user, using only a designated test ChatGPT account and synthetic text:

```sh
npm run dev -- start /absolute/copied/private-build --chrome-app '/Users/attestamp-test/AttestampPrivateBrowser/Google Chrome.app' --live-chatgpt-testnet
```

This is the explicit live-boundary opt-in. It starts the resident Attestamp menu
and opens a blank tab in the explicit Chrome copy with the isolated user-data directory. The private runtime
rechecks the selected copy before opening the vault, and supplies the actual test
user's HOME. It disables background networking, component updates and Chrome's
updater scheduler for this process; it does not change updater preferences or
services. The supported browser's
[scheduler switch](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.37/chrome/browser/chrome_browser_main.cc#1075)
skips periodic updater setup, while
[copy ownership](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.37/chrome/browser/updater/browser_updater_client_util_mac.mm#250)
keeps its updater scope in the test account. After this setup, opening the same
Attestamp Private Test app in Finder reuses the saved consented browser location
in `desktop.json`; it revalidates that copy and restores no scope or send grant.
Do not open the copy's About/Update action or promote its updater.

Visit `chrome://extensions`, enable Developer mode and
load the output's `extension` directory unpacked. Verify its unchanged ID is
`medilhopfckldjgdnchfkpmfmfnkadca`. Open one empty `https://chatgpt.com/` tab and
sign into the designated test account. Use the trusted Attestamp side panel for
Sealed text, or Continuous with normal ChatGPT Send. The menu opens an optional
dashboard for history, integrations, anchoring account and recovery. Its integration
card identifies private development; no Store connection is needed. Closing the
dashboard leaves capture running. Quit from the menu ends the engine. The old
technical composer is available under Developer tools for bounded checks.

While a designated ChatGPT account is unavailable, check local startup, load the
unpacked extension to test native pairing, and verify rejection without an enrolled
provider scope, stop/restart and backup/restore in the test user. Keep browser tabs
at `chatgpt.com` closed and sponsorship unconfigured. Native pairing needs no
provider tab or login. These checks do not establish successful sends, provider
markup compatibility, receipt export or live TestNet confirmation. A vault with no
content receipts still contains its empty release journal.

Keep the test user active at the Mac during startup,
restart, backup and restore, with its Keychain unlocked. The installed check
returned `KEYCHAIN_LOCKED` while that login was in the background and started
successfully after switching to it. A logged-in background session alone did not
suffice. Preserve the helper's `WhenUnlockedThisDeviceOnly` protection; unlock
locally instead of changing Keychain permissions or accessibility.

An older private build without explicit browser selection is rejected with
`PRIVATE_BUILD_REQUIRES_CHROME_PATH_SUPPORT`; prepare an updated signed build.
The production package has no browser-path override.

1. During an approved installed checkpoint, connect anchoring in dashboard Settings
   using the local sponsor's access code. Select a current conversation in the panel.
2. Try Continuous with synthetic text using ChatGPT's normal Send. Try Sealed with
   the panel's **Protect and send** action: bytes stay local until confirmation.
   A persistent Sealed preference never restores old send authority.
3. Stop the sponsor, edit while pending, add another ChatGPT tab, or disable the
   extension. Strict modes must remain pending or revoke eligibility; no downgrade
   or automatic resend is allowed. Refresh/re-enroll only as the app requires.
4. Export a selected receipt using its disclosure preview. Open the bundled
   `Recipient/Attestamp Verifier.app` to check it without the sponsor. An export
   with only fast evidence does not become consensus-verified or prove authorship.
5. Quit Attestamp, close test Chrome, then reopen the app in Finder. Reload the
   extension if Chrome requires it. Check persisted receipts and fresh enrollment;
   old interrupted versions must never gain send authority after restart.

Use `npm run test:dashboard-browser` and
`npm run test:product -- --scenario resident-dashboard` for ordinary isolated
regressions. Do not rebuild or modify the retained installed kit per task. These
setup instructions do not authorize a new live provider send or transaction.

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
Private app stop preserves its account, vault, keys, browser copy and browser state. After the
installed recovery check, exports and logs have been saved, remove the **dedicated
test user** using System Settings if desired. Delete only the exact build/sponsor
directories created for this rehearsal, after stopping them. Never reset an
existing operational vault, browser profile, Keychain or sponsorship ledger.
