# Supported ChatGPT release path

This directory implements the first narrow browser contract: Apple-silicon macOS
15.7 or later, Chrome Stable (fixture baseline 153), and `https://chatgpt.com`.
Prompt text originates in the trusted local composer. The extension receives bytes
only after the local runtime has durably recorded a release attempt and consumed
the exact version's authorization. Attachments are unsupported.

## Boundaries and modes

[`session.mjs`](session.mjs) composes the encrypted vault with the durable release
state machine. Product code must provide an already-opened OS-custodied vault;
there is no implicit ephemeral production key. The session accepts well-formed
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

The two-source collector has a hard 20-second budget and injected endpoint I/O so
the signed local application can enforce its TLS and endpoint allowlist. Timeout,
source error, pool error, expiry, disagreement, or malformed proof returns no
authorization. Protected releases stay pending; they never fall back to Continuous.

## Least-authority Chrome adapter

The Manifest V3 extension has only `nativeMessaging`, `tabs`, and the single
`https://chatgpt.com/*` host permission. Its public manifest key pins the development
extension ID. Packaging must install a native-host manifest with that same ID and
the absolute signed-host path; the template is included here but is not itself an
installer.

The background worker requires exactly one active ChatGPT tab and forwards only a
versioned release command. The content script recognizes the pinned
`#prompt-textarea` plus `data-testid="send-button"` contract, requires an empty
composer and no attachment state, injects the already-authorized text, checks the
exact URL, destination, transported SHA-256 text digest and DOM string, and clicks
Send. The bridge carries the exact UTF-8 bytes as bounded base64 rather than a
second ambient text source. It reports a local click observation—not provider
receipt. Once text may have reached the provider DOM, loss of a reply becomes
`OUTCOME_UNKNOWN`, never a safe retry.

[`native-host.mjs`](native-host.mjs) is a bounded native-messaging-to-Unix-socket
relay. It accepts only the pinned extension origin and a short-lived, owner-only,
non-symlink rendezvous record containing a fresh 256-bit token. It exposes no vault,
filesystem, clipboard, signer, or generic command API to the extension.

Eligibility is revoked on edit-revision mismatch, destination/scope change, a
second ChatGPT tab, browser/runtime restart, permission loss, protocol mismatch,
unrecognized provider markup, nonempty provider composer, or attachment state.
Unknown and interrupted attempts are never resent automatically; an explicit retry
creates a new attempt and consumes a new authorization.

## Validation

`npm run test:chatgpt` uses only fresh temporary encrypted stores and in-memory
browser/source fixtures. `npm run test:algorand` builds both offline verifiers and
checks the recorded public TestNet archive, fast corroboration, conflict cases, and
the later State-Proof upgrade. Neither command opens a user Chrome profile, accesses
a ChatGPT account, submits a transaction, or touches an operational evidence store.

The content-script fixture is deliberately selector-pinned. Revalidate it against
the then-current Chrome Stable and an explicitly designated test/owner ChatGPT
account with synthetic text before release; any provider drift disables protection.
