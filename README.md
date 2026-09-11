# Private provenance experiments

Disposable technical slices for private, portable evidence of human + AI work.
These experiments are not a production protection product.

## Integrated local demonstrator

The [consumer demonstrator](spikes/demonstrator/README.md) combines encrypted
evidence/recovery, exact-version release and anchor verification on macOS + Chrome
with a synthetic loopback provider. A developer-built double-click app supports
Continuous, Sealed and scoped Always Protect, readable receipts, local export and
fresh-vault restore. Offline rehearsal is explicitly synthetic; real Algorand mode
requires a new independently verified proof before protected release. See the
[participant walkthrough](spikes/demonstrator/WALKTHROUGH.md) for installation and
the remaining signing, recovery and trust limitations.

## Local release laboratory

With Node.js 22 or newer, run `npm run demo:release` and open the printed local URL.
Use synthetic content only: this slice keeps a **plaintext temporary journal** and
uses a **confirmation stub**, with no signing, encryption or external anchor claim.
The URL contains a temporary local pairing secret; do not share it.

The local composer freezes exact UTF-8 text and selected attachment bytes. A test
confirmation authorizes that immutable version. Before dispatch, the runtime
durably consumes authorization and records a scoped attempt. Edits require a new
seal. Concurrent releases cannot reuse authorization. Interrupted attempts become
unknown on restart and never automatically resend; the runtime exposes an explicit
retry operation for failed or unknown attempts.

The paired synthetic provider is a separate loopback origin. It models an eager
provider page that transmits drafts and uploads immediately: intercepting its Send
button would not prevent disclosure. The fixture adapter has disable, unsupported
surface and session-scope controls. These simulate extension lifecycle failures;
this slice does **not** ship a browser extension or support a real provider.
All authority stays in the local runtime; page-facing operations have no arbitrary
filesystem or signing API. The fixture checks origin, pairing, protocol, attempt,
scope and exact payload digest. A compromised local OS/runtime is outside scope.

Visible output capture records DOM `textContent` as UTF-8, independently from input
attachment bytes. Attachment references are unsupported. A local submission
observation does not establish provider receipt, internal context, authorship,
complete history or prior non-disclosure. Browser textarea line ending behavior
applies before the composer value is captured; no Unicode normalization is added.

## Validation

- `npm test`: deterministic release state and failure fixtures in fresh temporary directories.
- `npm run test:browser`: isolated headless Chrome with a fresh temporary profile,
  loopback-only fixtures, exact-byte assertions and provider-owned eager-input
  counterexamples. On other systems set `PROVENANCE_TEST_CHROME` to a Chrome binary.

Tests do not use existing profiles, evidence stores, provider accounts or external
anchor services. Cleanup removes only directories created by the current run.
The demo intentionally leaves its printed synthetic journal for inspection.
Atomic rename and file/directory sync model process-crash durability; this spike
does not establish guarantees against storage hardware failure or journal tampering.

## Supported ChatGPT browser path

The [first scoped browser path](spikes/browser/chatgpt/README.md) adds a text-only
256 KiB trusted composer, a least-authority Chrome/ChatGPT extension contract, all
three protection modes, an authenticated native rendezvous, a fixed signed macOS
host, runtime-side macOS socket-peer/code-sign validation, and local
`PAP_ALGORAND_FAST_CONFIRM_V1` verification backed by two bounded TLS algod observers.
Fast confirmation is explicitly source-corroborated rather than consensus-verified;
later State-Proof evidence upgrades assurance without changing historical release
authorization. Automated fixtures cover stale edits, tab/scope ambiguity, restart,
permission/protocol/provider drift, timeout/conflict, and unsupported attachments.
Use `npm run build:chatgpt -- NEW_OUTPUT_DIRECTORY` after building the pinned Go
tools to create the app and its not-yet-installed native-host manifest.

## Encrypted evidence slice

The separate [vault library](spikes/vault/README.md) adds encrypted private dedup,
crash-safe capture, signed commitments, authenticated recovery inventories,
macOS-Keychain-backed signing/VMK lifecycles, compatible schema migration, key
rotation, append-only retention and reference-shared public proof export. It
requires Node.js 22.13 or newer and does not yet replace the release laboratory's
synthetic plaintext journal.

## Offline anchor envelope

The [anchor experiment](spikes/anchor/README.md) implements the blinded Merkle
payload, a non-Algorand fixture, and a native Algorand TestNet archive verifier.
`npm run test:algorand` builds the Go adapter and verifies recorded public proofs
offline, including adversarial mutations. Live TestNet commands are explicit and
are never part of the default tests.
