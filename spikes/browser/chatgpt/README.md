# Supported ChatGPT release path

This directory implements the first narrow browser contract: Apple-silicon macOS
15.7 or later, Chrome Stable (fixture baseline 153), and `https://chatgpt.com`.
Prompt text originates in the trusted local composer. The extension receives bytes
only after the local runtime has durably recorded a release attempt and consumed
the exact version's authorization. Attachments are unsupported.

## Boundaries and modes

[`runtime-main.mjs`](runtime-main.mjs) is the fixed packaged entrypoint. It opens
or creates the app-bound Keychain vault, starts the authenticated native bridge,
and serves the bearer-paired loopback composer. [`session.mjs`](session.mjs)
composes that encrypted vault with the durable release state machine; there is no
implicit ephemeral production key. The session accepts well-formed
UTF-8 text through 256 KiB without Unicode normalization. A trusted-composer edit
revision accompanies the digest, so editing and then restoring the same visible
text cannot reuse a stale authorization.

- Continuous durably records an exact version and a retrospective dispatch attempt,
  then releases without claiming pre-disclosure anchoring.
- Sealed persists exact bytes and fast-confirmation evidence, consumes one durable
  authorization, and only then calls the browser adapter.
- Always Protect uses the identical Sealed path automatically inside one explicitly
  enrolled healthy tab scope. It is not device-wide DLP.

`PAP_ALGORAND_FAST_CONFIRM_V1` is verified locally by the fixed-purpose Go verifier.
It checks the expected TestNet/genesis, exact bounded self-payment transaction and
note, transaction ID and valid round, two configured operators with distinct
organizations and hosts, matching transaction/round/header reports, and the local
SHA-256 transaction-inclusion proof against that header. Success is reported only
as `SOURCE_CORROBORATED` with `SOURCE_REPORTED` time. A later valid State-Proof
archive adds a monotonic `CONSENSUS_VERIFIED` / `BLOCK_HASH_BOUND` receipt without
rewriting the evidence that authorized the historical release.

The bundled trust profile pins independent AlgoNode and Nodely TestNet algod
origins. [`fast-observe`](../../anchor/algorand/cmd/fastobserve/main.go) performs
three GET-only reads per operator (pending transaction, exact round block, and
SHA-256 transaction proof). It requires HTTPS, disables environment proxies,
rejects redirects and origin/path/query escapes, bounds connect/TLS/header/body
work, and has an 18-second process budget inside the collector's hard 20-second
two-source budget. The two operators are launched concurrently. Timeout, source
error, pool error, expiry, disagreement, or malformed proof returns no
authorization. Protected releases stay pending; they never fall back to Continuous.

## Managed account and sponsorship

The composer connects an anchoring account using an access code stored in a
separate app-bound Keychain item. Freezing automatically requests a sponsored
transaction from the packaged HTTPS service origin; the user needs no wallet,
seed phrase or manually entered transaction ID. The service receives only a
blinded 36-byte commitment payload plus account/operational metadata. The same
local independent fast-confirmation gate still controls release.

Outage, exhausted allowance and subscription expiry remain explicit. Continuous
keeps local evidence with an anchor pending; Sealed and Always Protect wait or
cancel without releasing. Existing transaction IDs can still be observed without
the account, and local receipts/export/verification remain free. See the
[managed service contract](../../managed/README.md) for durable quotas, replay,
account recovery, privacy boundaries and operator configuration. The default
`managed-config.json` has a null origin; configure it before signing a connected
build. The service database and sponsor executable are never bundled in the app.

## Least-authority Chrome adapter

The consumer-facing Manifest V3 package is named **Attestamp for ChatGPT** and
uses **Attestamp** as its short name. It pairs with the Attestamp desktop app
for the one supported ChatGPT path described below.

The Manifest V3 extension has only `nativeMessaging` and the single
`https://chatgpt.com/*` host permission. Its public manifest key pins the assigned
Web Store item ID `medilhopfckldjgdnchfkpmfmfnkadca`; the generated upload removes
that key. Host-scoped tab access replaces the broad `tabs` permission; incognito
access is disabled. The draft item is not yet a published or verified Web Store
listing. Adapter profile version 4 requires an acknowledged runtime epoch and
fresh engine checks before insertion and click. It rejects older extension
contracts; extension version 1.3.0 uses page contract `chatgpt-web-text/2026-09-14`.
Its JavaScript state explicitly reports browser identity as
`UNVERIFIED`; it cannot self-assert Chrome Stable. The native executable accepts
only a running parent whose macOS code signature is Google's Stable identifier and
team. Independently, the app-side peer validator derives the installed major version
and local OS/architecture from that same live process chain. The local controller
uses only this runtime-side identity and fails closed unless the exact supported
baseline matches; browser or platform fields sent over the bridge are not accepted.

The background worker requires exactly one active ChatGPT tab and forwards only a
versioned release command to its top-level frame. Detection recognizes one
supported `#prompt-textarea` independently of Send rendering, and reports draft
and attachment state separately. A detected provider-side draft remains in place
and cannot gain pre-disclosure protection. Dispatch still requires an empty
composer, no attachments and an exact transported SHA-256 text digest.

After one authorized insertion, the content script polls every 25 ms for at most
one second for one visible, enabled `data-testid="send-button"`. The entire
content request has a 1.5-second deadline, inside the worker's two-second reply
budget. Expiry checks use a monotonic clock, including after delayed callbacks.
Ambiguous controls, text/attachment/editor/destination drift, page suspension or
lost visibility abort the attempt. Each click follows fresh exact URL,
destination, editor identity, text and attachment checks with no intervening await.

`PAP_CHECK_RELEASE` checks the already-consumed, still-pending engine attempt
before insertion and again before click. The worker binds both checks to the
same content document, top-level frame, tab, phase and native connection, and
rechecks Chrome permissions and the active destination. Navigation, tab changes
and disconnect invalidate the in-flight check even if capability later returns.
The engine verifies the exact draft revision, scope and durable attempt; it
cannot restore or create authorization through this check. `PAP_RELEASE_CHECKED`
contains only the correlated check result. The durable release profile remains
`pap-chatgpt-release/1`, and native peer checks and evidence formats are unchanged.

The bridge carries exact UTF-8 bytes as bounded base64. Success records a local
click observation; provider receipt remains unknown. Once text may have reached
the provider DOM, readiness expiry, changed state and lost or mismatched replies
produce `OUTCOME_UNKNOWN`. Late readiness and duplicate attempts never cause a
blind resend or a second insertion.

[`bridge-runtime.mjs`](bridge-runtime.mjs) creates a fresh owner-only Unix socket,
256-bit token, runtime epoch, and atomically published short-lived rendezvous. The
accepted socket is paused before any bytes are parsed and duplicated into the fixed
[`macos-peer-validator`](native/macos-peer-validator.swift). Using `LOCAL_PEERPID`,
the validator requires the exact signed bundled Node relay, its exact signed
`provenance-browser-host` parent, and that host's live Google-signed Chrome Stable
parent. It derives browser/platform identity from that chain. Only after peer
validation and constant-time verification of an exact `PAP_BRIDGE_AUTH` does the
runtime construct `ChromeBridgeController → ChatGPTChromeAdapter →
ChatGPTProtectionSession`. Thus the rendezvous token is a second factor, not a
same-user process identity claim. [`native-host.mjs`](native-host.mjs) is the bounded
native-framing relay used behind the compiled
[`provenance-browser-host`](native/macos-browser-host.swift). It exposes no vault,
filesystem, clipboard, signer, or generic command API to the extension.

Native bridge profile version 3 acknowledges authentication with
`PAP_BRIDGE_READY`; the relay allows eight seconds for connection and authentication.
The controller then acknowledges the extension's hello with `PAP_READY`, bound to
the same runtime epoch used by release commands. Both ends bound the hello wait.
Backend EOF, socket errors, malformed frames and failed handshakes close the
relay's socket and stdio, allowing its native wrapper to exit and Chrome to
reconnect. Fixed `NATIVE_*` reason codes go to stderr without paths or error text.
The worker retries after 1, 2, 4, 8, 16 and at most 30 seconds; only successful
pairing resets the delay. Async observations and replies remain bound to their
originating port. Reconnection never queues or replays a release.

Eligibility is revoked on destination/scope change, browser/runtime restart,
permission loss, protocol mismatch or transport loss. Edit-revision mismatches
still reject stale versions. Temporary markup loss, an unavailable content script,
a nonempty composer, attachments, tab inactivity or an additional ChatGPT tab
produce `TEMPORARILY_UNAVAILABLE` while retaining the enrolled scope. They block
admission and release until the same pinned destination is healthy again. Tab URL
changes, tab removal or an observed different destination invalidate that scope;
an unknown destination during failed surface inspection cannot establish a change.
This adapter still admits only one tab; independent concurrent scopes require
the engine's separate conversation contexts.
Unknown and interrupted attempts are never resent automatically; an explicit retry
creates a new attempt and consumes a new authorization.

DOM/input changes trigger a fixed content-free surface notification, followed by
the runtime's ordinary capability check. Recovering the same supported surface
restores capability without automatically sending. The provider cannot download
new selectors or authorize a release through an unsigned configuration update.

## macOS package boundary

For ordinary iteration, run the [local product fixtures](../../development/PRODUCT-TESTING.md)
with `npm run test:product`. They reuse this runtime, product API and native relay
with explicitly injected synthetic provider, sponsor, confirmation and platform
identity. No installed Chrome or native Keychain authority is claimed by fixtures.

The local product page offers **Local diagnostics** in development and packaged
builds. Choose an operation/component, preview the exact bounded report, then
save that snapshot. The collector shares pseudonymous operation, epoch, connection,
capture, confirmation and dispatch references across the existing components.
Only fixed event codes and relative timings leave the collector; raw identifiers,
URLs, content digests, prompt bytes and arbitrary errors are excluded.
Details and retention limits are in the [testing guide](../../development/PRODUCT-TESTING.md).

For installed platform checks, use the [dedicated test-user workflow](../../development/README.md).
It retains Developer ID/Keychain provisioning and native peer authentication while
avoiding per-build notarization, a published Store listing and a public backend.
Its separate entrypoint and local TLS certificate are excluded from distribution
packages; the installed checks and current limitations are recorded there.

The [distribution builder and support runbook](../../distribution/README.md) adds
consented registration/removal, export opportunity, signed update verification,
rollback/schema gates, dependency inventory and build provenance. Consumer controls
remain unavailable until a fully provisioned release is packaged. The local
development builder below remains ad-hoc and never installs a native manifest.

First build the pinned Algorand tools, then create a new output directory:

```sh
make -C spikes/anchor/algorand build
npm run build:chatgpt -- /tmp/attestamp-chatgpt-test-UNIQUE
```

The builder produces `Attestamp.app` plus
`NativeMessagingHosts/ai.provenance.consumer.json`. The manifest targets the
compiled executable inside the signed app—not a source script or `/usr/bin/env`
runtime—and allows only the pinned extension origin. It is intentionally not
installed into a user's Chrome profile by the build. Distribution must sign the
app with the Keychain access-group entitlement, install that exact manifest via a
consented installer, and package the extension without changing its pinned ID.
The local ad-hoc build validates structure and sealing but correctly lacks
production Keychain authority and is not a public installer.

The fixed app host validates the complete bundle and launches only the bundled
Node runtime and `runtime-main.mjs` with a sanitized environment. The native
messaging host independently validates the complete app and its live Google Chrome
Stable parent before launching only the bundled relay. A separately signed peer
validator performs the runtime-side ancestry check before the relay may authenticate.
The local composer exposes status, account connection, enrollment, draft revisions,
freeze, blinded sponsorship/transaction observation, release, cancellation, local
receipts/export and later proof-upgrade operations. Account access cannot invoke
vault-key operations or change the release policy.

## Validation

`npm run test:chatgpt` includes an isolated end-to-end path through actual native
message framing, a fresh rendezvous and Unix socket, authentication, the controller,
adapter, durable Sealed session, and correlated release response. It also proves a
client holding the exact current token cannot proceed when peer authorization fails.
The macOS packaging regression invokes the real peer validator against a direct
same-user socket client and confirms rejection before bridge pairing. Other cases
use fresh temporary encrypted stores and explicit local fixtures. `npm run
test:algorand` builds the observer and both offline verifiers, exercises the real
observer against a fresh loopback TLS algod fixture, and checks the recorded public
TestNet archive, fast corroboration, conflict cases, and later State-Proof upgrade.
Neither command opens a user Chrome profile, accesses a ChatGPT account, submits a
transaction, or touches an operational evidence store.

`node --test test/native-bridge-lifecycle.test.mjs` also runs the real relay in
isolated child processes with Chrome's stdin held open. A synthetic Chrome API
executes the actual extension worker across normal engine stop/start, including
an interrupted dispatch, a new epoch, late replies, transient capability recovery
and bounded reconnect backoff. It uses fresh encrypted stores and memory keys;
no retained installation, browser profile or account is accessed. Native macOS
ancestry and actual provider behavior remain separately labelled platform checks.

The content-script fixture is deliberately selector-pinned. A release candidate
still needs a bounded owner-run check through the installed manifest and actual
Chrome Stable native-messaging process chain, followed by synthetic text in an
explicitly designated test/owner ChatGPT account. Automated tests do not establish
that external parent/DOM boundary; any provider drift disables protection.

## Receipts and recipient export

The local composer retains a selectable receipt history across vault reopen and
recovery. Preview the exact disclosed records, metadata and bytes before saving;
unselected activity is not included. Redacted text creates a new signed derivative
with an explicit source link and independent assurance. Shared archive bodies are
encrypted once in the vault and included once in each export, with per-record
references. Fast confirmation stays a historical client assertion for recipients;
archival verification uses a separately selected checkpoint.

The build's `Recipient` folder contains **Attestamp Verifier.app** with
the runtime and native proof verifier needed on a clean Mac. It has no vault,
Keychain broker, account, subscription or company endpoint. See the
[recipient format and verification guide](../../recipient/README.md) for limits,
trust assumptions, supported older exports and the seven report dimensions.
