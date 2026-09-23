# Isolated private agent sessions

This optional harness runs in the configured Codex/signing macOS account. It
does not use the retained owner-checkpoint account. It is available only through
`npm run dev -- agent … --agent-mode` and specially prepared
`PRIVATE_DEVELOPMENT` artifacts. Normal private preparation and distribution
builds retain their existing behavior.

For one-time initialization, create a new, owner-only input config outside the
checkout. Copy the signing selection from the existing private config, keep
`sponsor` null, and add:

```json
"agent": {
  "profile": "pap-private-agent/1",
  "namespace": "codex01",
  "automation": "computer-use",
  "account": {
    "username": "YOUR_SIGNING_ACCOUNT",
    "uid": 501,
    "home": "/Users/YOUR_SIGNING_ACCOUNT"
  }
}
```

The username, numeric UID and canonical home must match the current OS account;
the retained test account is rejected. The namespace is a lowercase letter
followed by 2–19 lowercase letters, digits or hyphens. No environment variables
select accounts, paths, permissions or live scope. Never copy retained evidence,
Chrome state, Keychain items, sponsor configuration or ledgers into this setup.
Keep the original private config and provisioning profile unchanged. If the
profile is inaccessible to the runner, select an explicitly supplied accessible
copy in this new input config; do not widen the original file's permissions.

All mutable resources are under the **new** directory
`~/.attestamp-agent-codex01`: `control`, `support` (vault and native bridge),
`chrome` (user data and native registration), `extension/current`, `browser` and
`builds/BUILD`. Initialization also writes
`bootstrap/agent-config.json` and a byte-for-byte copy at
`bootstrap/helper.provisionprofile`, both mode 0600 in an owner-only directory.
The persisted config points to that profile copy. After initialization, every
command uses the namespace (for example, `codex01`); the original input config
and profile paths are no longer needed. The Keychain selection remains the
explicit selection from the input config; its contents and ACLs are unchanged.
The Keychain service is `ai.provenance.agent.UID.NAMESPACE`.
The provisioned access group and signed helper identity stay unchanged; the
specialized helper accepts only this agent service and rejects managed-account
credentials. The native app lock and browser relay use the pinned agent support
directory. Sources are specialized before signing, with exact input matches;
there is no agent switch or namespace authority in distribution artifacts.

Initialization refuses an existing root. Each signed build must be new. The
explicit `stage` command replaces `extension/current` only while the runtime
and Chrome are stopped, retaining the previous stage for inspection. Validation
rejects aliases, path traversal, redirected state, hard-linked
files and unsafe permissions before starting storage or a browser. It never
repairs or cleans an existing namespace automatically. Chrome's own singleton
links are inspected as browser state and never followed by the harness.
Namespaces created before persisted configuration was supported must be replaced
by a fresh namespace through initialization. There is no automatic import from
old configs, current-directory files, or environment variables.
An interrupted initialization requires a fresh namespace as well.

## One-time owner bootstrap

1. Stay logged in to the configured signing account on the supported
   Apple-silicon macOS version. Unlock that account's Keychain. Follow the
   [existing signing authorization procedure](README.md#one-time-signing-authorization)
   for the exact Developer ID identity and helper profile. The tooling never
   changes key ACLs, partition lists, passwords, or account membership.
   Give the runner filesystem access to the new agent subtree and permission
   for its local Unix sockets and loopback listeners before scheduling work.
2. Initialize and build, using a new build name:

   ```sh
   npm run dev -- agent init /absolute/private/agent-config.json --agent-mode
   npm run dev -- agent prepare codex01 build01 --agent-mode
   npm run dev -- agent stage codex01 build01 --agent-mode
   npm run dev -- agent bootstrap codex01 build01 --agent-mode --owner-bootstrap
   ```

   `init` reports the configured namespace after persisting the config and
   profile. It does not sign, access the Keychain, or grant session readiness.
   `prepare` validates the copied helper profile against the selected signing
   certificate before building. Save the namespace in the unattended command;
   no original config path needs to be supplied or rediscovered on later runs.

   Bootstrap creates a nonsecret readiness item **only** in the agent Keychain
   service. The signed native host and helper must successfully access it.
   The helper disables interactive authentication, including during bootstrap;
   resolve a reported Keychain problem interactively before retrying. No command
   requests, stores, or accepts an account password.
3. For **optional, separately authorized live browser work**, create an owned
   copy of the supported, Google-signed Chrome under
   `~/.attestamp-agent-codex01/browser/Google Chrome.app`. Use the existing
   [private Chrome setup guidance](README.md) to resolve Gatekeeper/first-open
   setup. Never ad hoc sign Chrome or reuse its normal profile. Open that exact
   executable with `--user-data-dir=/Users/YOUR_SIGNING_ACCOUNT/.attestamp-agent-codex01/chrome`.
   Load the unpacked extension from `extension/current`, enable it, and sign in
   to the dedicated synthetic-content provider account. Resolve Chrome's own
   initial Keychain/login prompts, then quit Chrome normally.
4. Complete the live-browser bootstrap only after separate authorization for
   provider access:

   ```sh
   npm run dev -- agent bootstrap codex01 build01 --agent-mode --owner-bootstrap --live-provider-send
   ```

   This records readiness for the Chrome version after a
   bounded, read-only provider-login probe. It performs no provider Send. A
   replaced browser requires bootstrap again. Every preflight checks the
   selected signed build's exact inventory against the current extension stage;
   a normal stopped-stage update needs no manual extension reload or new login.
   For `automation: "computer-use"`, grant the launching automation app
   Accessibility and Screen Recording in macOS System Settings and restart it
   if macOS requires that. Run preflight from that same automation app/session;
   a check run from Terminal does not certify a different responsible app.
   Permission probes only inspect readiness and never request consent or capture
   the screen. Choose `automation: "local-api"` explicitly for sessions that use
   only local APIs and need neither permission. Login preflight itself uses a
   private CDP pipe. Full Disk Access, Apple Events, Fast User Switching and
   administrator permission are not required.

## Normal unattended sessions

```sh
npm run dev -- agent preflight codex01 build01 --agent-mode
npm run dev -- agent start codex01 build01 --agent-mode
npm run dev -- agent stop codex01 --agent-mode
```

For machine consumption, call `node spikes/development/agent-cli.mjs` directly
(or `npm run --silent agent -- …` to suppress npm's command banner). It emits
one JSON result on stdout. Exit codes are 0 for success, 1 for a failed control
or assertion, and 2 for `OWNER_ACTION_REQUIRED`. Raw subprocess errors and
dashboard bearer tokens are not included in failures.

```sh
node spikes/development/agent-cli.mjs doctor codex01 build01 --agent-mode
node spikes/development/agent-cli.mjs start codex01 build01 --agent-mode
node spikes/development/agent-cli.mjs state codex01 --agent-mode
node spikes/development/agent-cli.mjs recording codex01 on --agent-mode
node spikes/development/agent-cli.mjs dashboard codex01 --agent-mode
node spikes/development/agent-cli.mjs history codex01 0 --agent-mode
node spikes/development/agent-cli.mjs debug codex01 on --agent-mode
node spikes/development/agent-cli.mjs debug codex01 off --agent-mode
node spikes/development/agent-cli.mjs debug codex01 export --agent-mode
node spikes/development/agent-cli.mjs assert codex01 recording=ON --agent-mode
node spikes/development/agent-cli.mjs wait codex01 prompt-count=0 10000 --agent-mode
node spikes/development/agent-cli.mjs failure-bundle codex01 --agent-mode
node spikes/development/agent-cli.mjs stop codex01 --agent-mode
```

State, dashboard/history queries and recording controls reuse the existing
authenticated APIs. Recording commands bind to the current engine epoch and
revision. A conflict fails without replay. Waits use exact conditions:
`engine-ready`, `paired`, `sources-ready`, `recording=ON`, `recording=OFF`,
`prompt-count=N`, and `anchors-settled`. The maximum wait is 120000 ms; a
runtime replacement invalidates the wait. `anchors-settled` only means no
pending anchors, and can be true for empty history. It makes no proof claim.

`debug status` returns the current debug session ID and revision. Starting
fresh requires a paused session and `debug NAMESPACE new SESSION_ID REVISION
acknowledge --agent-mode`, preserving the dashboard's explicit acknowledgement
contract. Export never clears the journal. Debug exports and failure bundles
are created exclusively under `control/artifacts` with mode 0600. Failure
bundles contain bounded state counts, without source URLs, prompts, credentials,
console output, or arbitrary error text. Failures leave evidence and diagnostic
journals in place; inspect before explicitly stopping or replacing anything.

`doctor NAMESPACE BUILD` runs preflight, starts and drains the runtime, starts
a fresh epoch, checks it, then stops it. With the separate live flag it also
checks loopback CDP and native pairing through a ChatGPT tab. It never sends a
prompt. It returns one readiness report, including zero authorized provider
sends and anchor transactions: this harness has no sponsor or live-send budget.
A failure after launch leaves that runtime inspectable. `preflight` remains
available for prerequisite checks without the runtime lifecycle exercise.

For a bounded unattended check, use `run NAMESPACE BUILD CONDITION TIMEOUT_MS
--agent-mode`. It starts, waits, then stops on success. The run holds idle system
sleep using `/usr/bin/caffeinate -i -t 300 -w PID`, without changing persistent
power settings. Failure or interruption releases the hold and retains runtime
state for inspection. All operations remain bounded; the hold also expires if
the caller crashes. A bare `start` intentionally leaves the runtime running
and does not hold system sleep.

## CDP inspection and extension updates

Live agent Chrome uses the exact validated executable, the namespace's
non-default profile, `--remote-debugging-address=127.0.0.1` and an ephemeral
debugging port. `cdp NAMESPACE --agent-mode` returns only the path of the mode
0600 connection record at `control/cdp.json`, inside the owner-only namespace.
It never enables debugging on ordinary Chrome or production artifacts. Do not
publish the connection record: CDP grants inspection of this private browser.
The original dashboard and native peer/signature/source/epoch checks remain
in force; CDP is not an evidence admission API.

The development-only `connectAgentCDP` helper accepts that validated connection
record and exposes bounded CDP calls and event subscriptions. Attach to a page
with `Target.attachToTarget` (`flatten: true`), then use `DOM.getDocument`,
`Runtime.enable`/`Runtime.consoleAPICalled`, and
`Network.enable`/`Network.requestWillBeSent` to inspect DOM, console and actual
requests without screenshots. Subscribe before the action being observed.
Raw browser inspection stays in the private client; it is never added to the
content-free failure bundle or Attestamp evidence. Close the helper connection
after inspection. It does not close Chrome or send any provider prompt.

After preparing another signed build, run guarded `stop`, then `stage NAMESPACE
NEW_BUILD --agent-mode`, then `start NAMESPACE NEW_BUILD --agent-mode` with the
same explicit live selection. Chrome restarts from the stable unpacked path;
no manual `chrome://extensions` action is needed after the initial load. The
stage and startup operations serialize through an exclusive control lock and
refuse a running browser. Interrupted stages retain incoming/previous bytes
for inspection, and never repair an unsafe stage automatically.

Chrome requires a [non-default profile for remote debugging](https://developer.chrome.com/blog/remote-debugging-port).
The helper uses the standard [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).

Each command resolves `~/.attestamp-agent-codex01/bootstrap/agent-config.json`
from the current OS account and validates its namespace/account marker and
owner-only permissions. Filesystem paths are accepted only by `init`. A missing
or unsafe canonical config produces a bounded failure; no fallback searches
the home directory or consults environment variables. Preflight resolves the
config inside its existing two-minute deadline. A missing profile blocks
preflight and prepare, while `stop` can still use the persisted namespace.

The default session starts the local resident engine with browser integration
disabled. It never opens Chrome. Its authenticated loopback dashboard is in the
agent control locator. Provider work additionally requires
`--live-provider-send` on **both** preflight and start. `start` always reruns
preflight; an old report grants no launch authority. The signed native host
requires the explicit session invocation, and the runtime consumes a launch
request valid for at most 60 seconds. Double-click/reopen cannot resume a live
session. Normal shutdown waits for only the Chrome process created by that
session to close, with a bounded termination fallback; a crash or stale locator
fails the next preflight before work starts.

`--live-provider-send` permits provider access for a separately authorized test;
no command in this harness synthesizes a Send. Sponsorship stays disabled in
both modes, including pending confirmation network fallbacks. There is no
sponsor/MainNet/publication/deployment option. Each would require separately
authorized tooling and its own isolated resources; the retained ledger is never
read, reset, refilled or reused.

Preflight emits one bounded JSON report and exits with code 2 on
`OWNER_ACTION_REQUIRED`. It reports the first failing prerequisite, without
paths, browser contents, account identifiers, credentials or raw errors:

| Reason | Owner action before starting a session |
| --- | --- |
| `AGENT_OPT_IN_REQUIRED`, `AGENT_CONFIG_INVALID`, `AGENT_ACCOUNT_MISMATCH` | Use the explicit opt-in, selected namespace and current signing account; initialization also requires a valid input config. |
| `AGENT_CONFIG_NOT_PREPARED` | Complete initialization for the selected namespace. Existing partial or older namespaces require a fresh namespace; normal commands never fall back to an input config path. |
| `AGENT_STATE_NOT_PREPARED`, `AGENT_NAMESPACE_MISMATCH`, `AGENT_STATE_UNSAFE` | Inspect the selected namespace; create a fresh one if needed. Do not redirect it to retained state. |
| `GUI_SESSION_REQUIRED` | Log in to the configured account before scheduling the session. |
| `LOCAL_IPC_PERMISSION_REQUIRED` | Allow the runner to create local Unix sockets and loopback listeners in this isolated namespace. |
| `ACCESSIBILITY_PERMISSION_REQUIRED`, `SCREEN_RECORDING_PERMISSION_REQUIRED`, `AUTOMATION_PERMISSION_CHECK_UNAVAILABLE` | Grant the selected automation app's permissions, restart it if required, and rerun preflight from that same app. No consent is requested automatically. |
| `SIGNING_INPUTS_INVALID`, signing/Keychain authorization labels | Fix the exact profile, certificate selection, unlocked Keychain or owner authorization using the existing signing checklist. |
| `AGENT_BUILD_INVALID` | Prepare a new signed artifact; do not patch a signed bundle. |
| `VAULT_KEYCHAIN_BOOTSTRAP_REQUIRED`, `VAULT_KEYCHAIN_UNAVAILABLE` | Complete native Keychain bootstrap, or restore the account's unlocked Keychain availability. |
| `STOP_PREVIOUS_AGENT_SESSION` | Run the guarded agent stop; inspect stale state if stop reports a conflict. |
| `CHROME_SETUP_REQUIRED`, `CLOSE_OTHER_CHROME_COPY` | Prepare the exact supported Chrome copy and close existing Chrome processes before preflight. |
| `EXTENSION_SETUP_REQUIRED`, `BROWSER_BOOTSTRAP_REQUIRED` | Load the selected extension and finish bootstrap for this build and browser. |
| `PROVIDER_LOGIN_REQUIRED` | Resolve expired login, offline access, or a provider challenge interactively. |
| `AGENT_PREFLIGHT_TIMED_OUT`, `AGENT_PREFLIGHT_FAILED` | Inspect the selected local setup before retrying; the timed-out preflight and its child processes have been stopped. |

The entire preflight runs in a clean subprocess environment with a two-minute
deadline, including filesystem traversal and build/signing inspection. Timeout
or malformed output terminates only that invocation's process group.
Signing access inspection never prompts and the existing signing watchdog
bounds each codesign operation. Native Keychain requests have an eight-second
watchdog; native preflight has a fifteen-second process limit. Login preflight
has a twenty-second deadline plus bounded child-process cleanup. Startup waits
at most fifteen seconds and reports failure instead of displaying a modal
alert. File schemas, inventories and traversal counts are bounded. After a
successful bootstrap, ordinary sessions require no predictable password/GUI
input; a changed prerequisite stops the next session before unattended work.
An unexpected provider/session change after preflight can still fail a test;
readiness is not a promise of future provider availability.

Chrome's user native-host directory is derived from its selected user-data
directory ([Chromium path implementation](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/common/chrome_paths.cc)).
The login probe uses [CDP Runtime evaluation](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate)
and [Browser.close](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-close)
over inherited pipes. The session endpoint is treated as an untrusted readiness
probe: any unavailable, changed, challenged, malformed or unauthenticated reply
fails closed, and no response body or secret is emitted.
