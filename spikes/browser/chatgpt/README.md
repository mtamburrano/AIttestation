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
listing. Adapter profile version 2 rejects the older permission contract.
Its JavaScript state explicitly reports browser identity as
`UNVERIFIED`; it cannot self-assert Chrome Stable. The native executable accepts
only a running parent whose macOS code signature is Google's Stable identifier and
team. Independently, the app-side peer validator derives the installed major version
and local OS/architecture from that same live process chain. The local controller
uses only this runtime-side identity and fails closed unless the exact supported
baseline matches; browser or platform fields sent over the bridge are not accepted.

The background worker requires exactly one active ChatGPT tab and forwards only a
versioned release command. The content script recognizes the pinned
`#prompt-textarea` plus `data-testid="send-button"` contract, requires an empty
composer and no attachment state, injects the already-authorized text, checks the
exact URL, destination, transported SHA-256 text digest and DOM string, and clicks
Send. The bridge carries the exact UTF-8 bytes as bounded base64 rather than a
second ambient text source. It reports a local click observation—not provider
receipt. Once text may have reached the provider DOM, loss of a reply becomes
`OUTCOME_UNKNOWN`, never a safe retry.

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

Eligibility is revoked on edit-revision mismatch, destination/scope change, a
second ChatGPT tab, browser/runtime restart, permission loss, protocol mismatch,
unrecognized provider markup, nonempty provider composer, or attachment state.
Unknown and interrupted attempts are never resent automatically; an explicit retry
creates a new attempt and consumes a new authorization.

DOM/input changes trigger a fixed content-free surface notification, followed by
the runtime's ordinary capability check. Unrecognized provider markup revokes
enrollment; the provider cannot download new selectors or retain a protected state
through an unsigned configuration update.

## macOS package boundary

For private iteration, use the [dedicated test-user workflow](../../development/README.md).
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
