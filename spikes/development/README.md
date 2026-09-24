# Private Mac development

For routine development, start with `npm run test:product` in your current user.
The [local product testing guide](PRODUCT-TESTING.md) covers labelled isolated
fixtures, correlated diagnostics and targeted failure reports. It creates fresh
temporary resources and leaves the retained private installation untouched.

## Persistent private debug sessions

New private builds expose **Settings → Private debug session** in the dashboard.
Choose **Start debug recording** once before testing. A visible dashboard banner
confirms recording; events then append automatically, including bridge failures
and later runtime restarts. **Pause debug recording** persists that choice.
**Resume debug recording** continues the same retained session. Neither control
clears diagnostics or changes the session ID. **Save debug session** downloads
one immutable JSON snapshot of all retained segments; later recording cannot
change that downloaded snapshot. Share it explicitly after testing if needed.
There is no upload or per-operation export requirement.

To begin a separate test, pause debug recording and save any diagnostics you
need. Acknowledge **I have saved the current debug session or accept removing its
retained diagnostics**, then choose **Start fresh session**. The replacement has
a new session ID, zero retained events/segments and reset retention counters.
It remains paused until you choose **Resume debug recording**. The acknowledgment
is required even after downloading: the app cannot verify that a download was
kept. Fresh sessions change only the debug journal; evidence, vault, keys, prompt
recording preference, integration state, sponsor accounting and saved downloads
remain unchanged.

The owner dashboard exposes authenticated POST controls at
`/debug-session/recording` (`{ enabled: boolean }`), `/debug-session/export` (`{}`)
and `/debug-session/new` (`{ sessionId, revision, acknowledged: true }`). A fresh-session
request requires the current paused session ID and revision from dashboard state.
Revisions change on journal writes and reopen, so stale acknowledgment cannot
clear diagnostics after another view resumes/pauses recording or after a restart.
Retries cannot clear a newer session. The single journal row is replaced in one FULL-synchronous
WAL commit. An interruption leaves either the prior session or the empty new
session, never a mixture. Unsafe journal state is refused, not reset or repaired.

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
against the same product scenarios. It also checks acknowledged fresh sessions,
stale requests, unchanged product state and crashes before/after replacement.
It requires local loopback/Unix-socket access.
The signed, installed workflow below is for explicitly scheduled platform checks.

This route prepares the actual ON/OFF recorder, encrypted durable vault, native
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
  "signingKeychain": "/Users/SIGNING_OWNER/Library/Keychains/login.keychain-db",
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

For optional same-account unattended sessions, see the separate
[isolated agent setup](AGENT-TESTING.md). It uses a fresh namespace and explicit
opt-ins; the retained owner-checkpoint setup below is unchanged.

### One-time signing authorization

Each nested executable and bundle is signed separately. A Keychain **Allow**
decision authorizes one private-key use, so the same build can ask repeatedly.
The key's trusted-application ACL and partition restrictions are separate from
certificate/profile validity. See [Apple's explanation of signing identities and
access control](https://developer.apple.com/forums/thread/712005).

In the signing owner's interactive login session, open Keychain Access, select
the exact Developer ID certificate matching `signingIdentity`, expand it, and
open **its private key → Get Info → Access Control**. Record the existing settings
before changing them. Keep **Confirm before allowing access** selected; add only
`/usr/bin/codesign` to the applications that are always allowed. If selected,
clear **Ask for Keychain password** for this key. Save using the native macOS
prompt. Do not select **Allow all applications** or change certificate trust.
Alternatively, choose **Always Allow** on that exact key's legitimate `codesign`
prompt during an owner-run signing operation. Enter passwords only into macOS,
never into this CLI, a config, chat, an environment variable, or a shell argument.
To revoke this authorization, remove `codesign` from that key's application list
and restore its previous password-confirmation setting in Keychain Access.

Select the canonical, owner-only Keychain file explicitly as `signingKeychain`;
the builder never searches other Keychains for a substitute identity. Old config
files without this field receive `KEYCHAIN_SELECTION_REQUIRED`. In the supported
state, the signing owner is logged in, the selected file Keychain is unlocked,
and the exact key permits `codesign` through both its application and partition
ACLs. Login, reboot, locking, key replacement and toolchain changes require a new
preflight. No command here unlocks a Keychain or changes its access rules.

```sh
npm run dev -- signing-preflight /absolute/private/dev-config.json
```

The result is JSON: `{"status":"READY"}` or
`{"status":"OWNER_ACTION_REQUIRED","reason":"BOUNDED_REASON"}` (exit status 2).
Preparation runs the same preflight before source inventory, output creation or
application compilation. A small temporary native metadata inspector uses
[`SecKeychainSetUserInteractionAllowed(false)`](https://developer.apple.com/documentation/security/seckeychainsetuserinteractionallowed(_:))
and reads only the selected identity's access metadata. Locked/missing Keychains,
missing keys, mandatory password confirmation, missing explicit `codesign` access,
and absent/unrecognized partition authorization fail closed before the signing
probe. `PARTITION_AUTHORIZATION_REQUIRED` needs owner inspection of that exact key;
ordinary builds never invoke `set-key-partition-list`, rewrite ACLs or broaden
permissions across a Keychain. Do not run a blanket partition-list repair.

After those checks, `/usr/bin/codesign --dryrun` signs a disposable copy of
`/usr/bin/true` without retaining a signature. `--dryrun` alone does **not** suppress
Keychain interaction (see `man codesign`); the access inspection must precede it.
The probe has a 15-second hard deadline. The builder rechecks access before each
real signature, which has the same deadline. READY describes the current session,
not a durable authorization token: locking or changing authorization between a
check and a signature can still cause a prompt or a bounded failure. Do not leave
an unattended build running across session/Keychain changes. A timed-out build is
incomplete; after restoring the supported state, use a fresh output directory.

After authorizing, validate with **two consecutive fresh outputs**:

```sh
npm run dev -- prepare /absolute/private/dev-config.json /absolute/new/private-build-one
npm run dev -- prepare /absolute/private/dev-config.json /absolute/new/private-build-two
```

Both must finish without GUI/password prompts, retaining profile matching and
strict signature verification. These are signing-account-only builds: do not
install them, switch to the retained test user, or access its vault, Keychain,
Chrome profile or sponsor ledger. Automated tests use temporary synthetic files
and in-memory ACLs; they do not establish this owner-specific installed result.

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

Chrome starts by executing the exact validated bundle's
`Contents/MacOS/Google Chrome`; LaunchServices may resolve `open -a PATH` to a
different installed copy. The launcher checks this user's running Chrome main
processes before and after launch and confirms the effective executable path.
`CLOSE_OTHER_CHROME_COPY` means another copy is running: quit it normally before
retrying. The launcher never kills another browser or deletes profile locks. A
running instance of the selected copy may receive a Dashboard request normally.
`CHROME_LAUNCH_NOT_CONFIRMED` means no matching process was observed; startup is
not reported as successful. Raw process listings and browser errors are not logged.

The dedicated test user's normal Chrome user-data directory remains supported;
no additional profile is required. Native origin, signatures, parent/ancestry,
rendezvous/token, epoch and socket authentication remain unchanged.

Direct launching can attribute Chrome's signed-app clone maintenance to Attestamp.
Keep Attestamp disabled in **System Settings → Privacy & Security → App Management**;
if that notification returns, stop the installed check and investigate separately.
Do not grant app-management permission or weaken native authentication to make
pairing pass. Earlier LaunchServices results in the historical readiness record
do not validate this launcher. Fresh installed pairing and permission attribution
still require their own checkpoint after independent review.

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

The self-check reports fixed labels, validates the current ledger policy, and
does not repair existing permissions or migrate the policy.
The existing owner/permission validation at server startup remains enforced.

It generates a fresh TestNet-only signing seed, a 30-day loopback TLS certificate,
one seven-day test access code and an isolated durable ledger. Fund **only the
printed new public address** with free TestNet faucet ALGO. Never import an existing
account or use MainNet/paid funds. The seed and TLS private key stay in this directory;
the access code is in its owner-only `access.json`. Total and monthly capacity
are 1000 anchor reservations; the account daily limit remains 100. Transactions
use 1,000 microALGO fees and the existing bounded replay policy.
Restarting cannot reset quotas or sign replacement transactions.

For a stopped private sponsor using the exact historical ten-reservation
policy, migrate its existing ledger explicitly:

```sh
npm run dev:sponsor -- migrate-policy /absolute/private-sponsor
npm run dev:sponsor -- doctor /absolute/private-sponsor
```

The migration makes no network calls. It updates only the policy row in one
SQLite transaction, preserving accounts, token hashes, reservations, signed
transactions and broadcast counters. The signing seed/address, access code,
TLS certificate and port stay unchanged, so no client rebuild is needed.
An already-current policy is a no-op. Any other policy, unexpected schema or
unsafe file fails without repair. Generic managed-service defaults and strict
policy mismatch checks are unchanged. Never reinitialize an existing sponsor
or replace its ledger to obtain more capacity.

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
cannot establish anchor assurance. No public backend or DNS is required.

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
in `desktop.json`; it revalidates that copy and requires fresh source identity and keeps the versioned recording preference.
Do not open the copy's About/Update action or promote its updater.

Visit `chrome://extensions`, enable Developer mode and
load the output's `extension` directory unpacked. Verify its unchanged ID is
`medilhopfckldjgdnchfkpmfmfnkadca`. Open one empty `https://chatgpt.com/` tab and
sign into the designated test account. The retained Attestamp sidebar offers global
ON/OFF and status. Turn ON and use ChatGPT's normal composer and Send; supported
existing/new tabs are followed automatically. The menu opens the optional dashboard
for history, integrations, anchoring account and recovery. Closing a view leaves
the engine running. Quit ends it. Installed sidebar trust/interaction must be
validated separately against the current contracts before acceptance.

The launch helper above is an optional private setup path. Manual opening of the
approved Chrome copy is allowed for an installed checkpoint; it is not a product
requirement to redesign browser launch. Existing code-signature, native ancestry,
resource ownership and dedicated-profile checks still apply.

Without a designated ChatGPT account, restrict checks to authorized local startup,
native pairing without provider tabs, restart and recovery. Leave sponsorship
unconfigured. These checks establish no provider markup, normal-Send capture or
live confirmation. An empty history can still contain encrypted engine metadata.

Keep the test user active at the Mac during startup,
restart, backup and restore, with its Keychain unlocked. The installed check
returned `KEYCHAIN_LOCKED` while that login was in the background and started
successfully after switching to it. A logged-in background session alone did not
suffice. Preserve the helper's `WhenUnlockedThisDeviceOnly` protection; unlock
locally instead of changing Keychain permissions or accessibility.

An older private build without explicit browser selection is rejected with
`PRIVATE_BUILD_REQUIRES_CHROME_PATH_SUPPORT`; prepare an updated signed build.
The production package has no browser-path override.

1. During an approved installed checkpoint, inspect effective connection status and
   connect the dedicated anchoring account in Settings only when authorized.
2. Explicitly turn ON and submit synthetic text using ChatGPT's own Send. Confirm
   durable Prompt saved separately from asynchronous anchor status. Existing/new
   tabs and duplicate conversations require no enrollment.
3. Turn OFF, interrupt connection, introduce unsupported input or an unavailable
   sponsor. No new capture after the cutoff, provider interception, resend or
   history backfill is allowed. Already-durable bounded anchoring may finish OFF.
4. Preview selected disclosure and verify it with the bundled free verifier.
   Fast evidence alone is not consensus verification, event truth or authorship.
5. Quit/reopen the app and approved Chrome. Check retained history and preference,
   fresh source identity and rejection of stale deliveries. Recovery starts OFF.

Use `npm run test:dashboard-browser` and
`npm run test:product -- --scenario dashboard-recording` for ordinary isolated
regression. Do not rebuild or modify the retained kit per task. These instructions
do not authorize provider Sends, new transactions, sponsor reset/refill or account
switching. A retained sponsor's actual remaining reservations must be checked at
the separately authorized checkpoint; no quota is assumed here.

```sh
npm run dev -- stop
```

Stop drains the runtime through its authenticated local endpoint and removes only
the registration matching this workflow's ownership journal. It never kills a PID
read from disk, closes other browser sessions or deletes evidence. Close test Chrome
manually, and use Ctrl-C in the sponsor terminal. If startup was interrupted, use
`stop` before retrying. A changed registration fails cleanup and needs inspection.

The exit request uses a dedicated direct HTTP connection to the validated numeric
loopback address, with the existing Origin and bearer checks, a five-second
deadline, no redirects, and a bounded `{ "exiting": true }` acknowledgment. It does
not inherit the CLI's global `fetch` dispatcher or environment proxy. Modern Node
can [apply environment proxies to fetch](https://nodejs.org/api/http.html#built-in-proxy-support);
an isolated proxy-reset fixture reproduces the old generic failure with an otherwise
valid runtime locator. This establishes a request-path failure mode, not the exact
environmental cause of an earlier installed failure.

After acknowledgment or a request timeout, stop polls for up to 30 seconds for the
engine to remove its locator after drain. It checks only the original runtime's
exact URL and bearer and never retries the exit request. Locator disappearance
allows owned cleanup, including when shutdown finishes after the request deadline.
A changed endpoint or bearer fails with `PRIVATE_STOP_RUNTIME_CHANGED` and leaves
the replacement untouched. An unchanged locator at the end of the window retains
control state and reports `PRIVATE_STOP_EXIT_TIMED_OUT` after a request timeout,
or `PRIVATE_STOP_STILL_DRAINING` after acknowledgment. Only a direct connection
refusal permits removal of a still-present, unchanged locator. Resets, denied
networking and rejected replies leave control state in place. File ownership,
permissions, hard-link/symlink, canonical-path and runtime-schema guards stay active.

| Fixed stop label | Next action |
| --- | --- |
| `PRIVATE_STOP_ACCOUNT_INVALID` | Inspect the dedicated account's directory and account-marker guards. |
| `PRIVATE_STOP_RUNTIME_UNREADABLE` / `PRIVATE_STOP_RUNTIME_INVALID` | Inspect locator file safety or its versioned shape; do not rewrite it to bypass checks. |
| `PRIVATE_STOP_EXIT_NETWORK_DENIED` | Check the CLI's local-network execution permissions. |
| `PRIVATE_STOP_EXIT_CONNECTION_FAILED` | Inspect runtime availability; cleanup has not been authorized. |
| `PRIVATE_STOP_EXIT_TIMED_OUT` | The original locator remained after the request deadline and drain window; inspect runtime availability before retrying. |
| `PRIVATE_STOP_EXIT_REJECTED` / `PRIVATE_STOP_EXIT_INVALID_RESPONSE` | Inspect endpoint/authentication mismatch; do not remove state manually. |
| `PRIVATE_STOP_STILL_DRAINING` / `PRIVATE_STOP_RUNTIME_CHANGED` | Let pending work finish, or inspect the replacement runtime before retrying. |
| `PRIVATE_STOP_REGISTRATION_CLEANUP_FAILED` | Inspect the ownership journal and installed registration for conflict or unsafe files. |
| `PRIVATE_STOP_LAUNCH_UNREADABLE` / `PRIVATE_STOP_LAUNCH_INVALID` / `PRIVATE_STOP_LAUNCH_CLEANUP_FAILED` / `PRIVATE_STOP_RUNTIME_CLEANUP_FAILED` | Inspect the named control-state category's safety and permissions. |

Labels contain no paths, tokens, response bodies or raw errors. Focused regression
coverage is `node --test test/private-stop.test.mjs`; it uses fresh temporary files,
loopback fixtures and a separate real engine with memory-only test keys.

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
stays in place; restored history starts with recording OFF and is never connected to
the bridge. These developer commands make no provider/sponsor calls. They accept
only paths inside the test user's home, require new output directories outside
repositories and the active control/vault/browser directories, and bound recovery
legacy JSON input to 16 MiB. Large backups use the printed `.pap-recovery` file,
which validates and restores bounded authenticated frames without loading the
archive into memory. Receipt export alone is not a recovery backup.

If an interrupted maintenance command leaves `operation.json` in the test control
directory, inspect and save that report before removing that one file and retrying.
An existing backup/restore destination is never reused or cleared automatically.

## Offline fixtures and cleanup

```sh
npm run test:private-dev
npm run test:chatgpt
npm run test:dashboard-browser
npm run test:recipient-browser
npm test
```

The new tests use fresh temporary resources, an actual loopback TLS server,
generated test certificates/keys and synthetic sponsorship. They prove ordinary
accounts cannot launch the private native host, conflicting registrations are
preserved, and fixture replies cannot pass the real confirmation verifier. The
ChatGPT regressions exercise native framing with injected peer/provider fixtures;
they do not establish installed Chrome ancestry or current provider markup.
The dashboard/recipient browser fixtures exercise ON/OFF, disclosure races,
recovery and free verification in new headless profiles with mock Keychain and
external DNS blocked. Synthetic proofs remain FIXTURE_VERIFIED, never public
consensus assurance. No ordinary test uses a real provider or live sponsor.
The actual private app retains its provisioned Keychain helper for a separately
authorized installed checkpoint. Executable historical demos are removed; fixed
legacy archives remain independently verifiable with `npm run test:legacy-archive`.

Automatic test cleanup removes only directories created by that invocation.
Private app stop preserves its account, vault, keys, browser copy and browser state. After the
installed recovery check, exports and logs have been saved, remove the **dedicated
test user** using System Settings if desired. Delete only the exact build/sponsor
directories created for this rehearsal, after stopping them. Never reset an
existing operational vault, browser profile, Keychain or sponsorship ledger.
