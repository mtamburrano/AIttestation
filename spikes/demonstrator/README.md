# Integrated local demonstrator

This macOS/Chrome/synthetic-provider experiment composes the encrypted vault,
durable release runtime and separate anchor verifier. The participant guide is
[WALKTHROUGH.md](WALKTHROUGH.md). It does not connect a real AI provider or submit
any Algorand transaction.

## Developer preparation

Use Node 22.13+ and the pinned Go toolchain described in the anchor adapter. Build
the native verifier with `make build` in `spikes/anchor/algorand`. Then run:

```sh
npm run build:consumer -- /tmp/provenance-demo-build-UNIQUE
```

Choose a new output directory; the builder refuses an existing one. It bundles
the current Node executable, source and native verifier, applies an ad-hoc local
signature, verifies it, and records elapsed build time in `build-measurement.json`.
The binary architecture matches the development machine. No account credentials,
public proof fixtures or live submission executable are included. Dependency
source/license material remains with the prototype. No Developer ID, notarization
or store acceptance is implied. This is a local developer artifact; do not treat
the ad-hoc signature as a trusted publisher identity or public release gate.

For direct developer use, `npm run demo:consumer` prints a local pairing URL and
the new temporary directory. The URL fragment is a session secret, removed from
browser history by the UI. Do not share it. `main.mjs --open` launches the installed
Chrome executable with a fresh session-only profile, no extensions, a mock keychain
and external DNS disabled. It never selects an existing browser profile. Launch
measurements are written inside that session's temporary directory, with real
external call count zero. Participant installation/Gatekeeper measurements remain
null until the owner actually performs the walkthrough.

## Durable boundaries and recovery

The release runtime accepts a storage/confirmation adapter; its original laboratory
retains its default test stub. The integrated adapter stores exact selected UTF-8
text and attachment bytes as private-deduplicated encrypted vault objects. Durable
release snapshots reference those objects rather than copying content into a
plaintext journal. A fsynced random event pointer selects the committed encrypted
snapshot. The trusted-local-filesystem and rollback assumptions of the vault apply.

Frozen descriptors bind the mode, enrolled scope, payload digest, exact-byte object
references and capture record IDs in a signed vault object. Confirmation uses the
descriptor's locally selected signed-record digest, never a proof-selected digest.
Validated proof receipts are themselves retained as encrypted signed objects.
Disclosure export content-addresses the public proof body and includes each shared
body once; descriptor-specific batch paths refer to it by digest. The verifier also
accepts the earlier self-contained envelope representation so recorded exports do
not become unverifiable after upgrade.
Authorization consumption still precedes dispatch in the existing release runtime.
A reload of an interrupted durable attempt produces `OUTCOME_UNKNOWN`, with no
automatic resend. The participant app intentionally has no retry/reopen authority:
new sessions are fresh, and restored history cannot authorize dispatch.

Continuous records an attempt durably and releases without a pre-disclosure anchor.
Its later confirmation cannot retroactively become a Sealed guarantee. The local
provider frame supplies observed DOM text via a checked origin/window/attempt
message; this remains a key-attributed client assertion, not independently proven
provider truth. Host, origin and temporary bearer pairing gate the local API.
No arbitrary path, filesystem lookup, signer or remote-fetch API is page-facing.

The existing vault manifest remains a generic byte-capture profile. Demonstrator
descriptors, release receipts and observations are signed **object contents**, not
a new normative event-schema implementation. The verifier reports release control
as local assertions only. All selected records are independently byte/signature
checked; anchors apply only to the explicitly linked descriptors. This compact
integration does not upgrade the earlier cryptographic/semantic contract.

Recovery packages retain the proof receipt objects and historical records. An
explicit final signed recovery index links descriptors to their proof receipts;
captured text is never classified as metadata based on its contents.
Restore authenticates the declared snapshot into a fresh vault under new local
keys. Operational pointers and consumed authorizations are not reinstated. Use the
restored evidence download and independently selected trust configuration for portable
anchor verification. Restore is read-only after verification; its temporary vault
is closed, while the downloadable bytes remain available in the page. The app is
limited to 16 MiB imports and the vault's 512-record
budget; begin a new disposable session when the limit is reached. Session keys are
ephemeral: without a prior snapshot and secret, a stopped session is unrecoverable.

## Validation and limitations

```sh
node --test test/demonstrator.test.mjs
npm run test:consumer-browser
node spikes/demonstrator/verify.mjs evidence-export.json independent-trust.json
npm run test:consumer-archive
```

Tests create fresh temporary vaults, keys, profiles and download directories. No
existing storage, browser profile, account or external service is used. The browser
test disables external DNS and exercises all modes, DOM capture, downloads, restore
and verification. `--keep-artifacts` explicitly preserves its synthetic test folder
and screenshot for inspection; default cleanup removes only that run's directory.
The subprocess verifier and clean restore use an empty environment and disabled
Node network entry points. Public Algorand archive fixtures are read-only; replay
against a new descriptor must fail. Core release/vault adversarial tests remain
applicable, including real process-kill tests in their original slices.

The [recorded results](RESULTS.md) include one real TestNet transaction binding
three new mode commitments, original/restored offline verification, and Finder
launch measurements. `live-validation.mjs` is a developer-only local harness:
it prepares one aggregate payload in a fresh declared test directory and waits
for the separately authorized native live driver to supply the archive. It reads
no account seed and never submits a transaction itself.

Offline rehearsal alone supplies no real Algorand assurance. Owner usability
acceptance remains separate from automated integration validation. No signed public installer,
OS keychain integration, persistent session identity, real provider extension or
provider-internal observation is claimed.
