# Encrypted evidence and recovery slice

This dependency-free Node.js 22.13+ library uses SQLite WAL with FULL synchronous
transactions. It implements exact-byte whole-object capture, encrypted private
deduplication, canonical manifests, randomized commitments and Ed25519 assertions.
The durable lifecycle targets Apple-silicon macOS; the lower-level vault remains
portable for offline verification and isolated tests.

## Durable macOS keys

`DurableVault.create()` and `DurableVault.open()` in `key-lifecycle.mjs` keep the
active Ed25519 signing private key and the 256-bit vault master key in distinct
macOS Data Protection Keychain generic-password items. The JavaScript runtime sends
a bounded request over private file descriptors inherited from the native
`provenance-app-host`. That fixed-purpose host validates the complete signed bundle,
constructs a sanitized environment and launches only the sealed application
entrypoint; it never accepts a script path or Keychain request from its caller. The
host alone invokes `provenance-keychain-helper`, which calls Security.framework
directly and verifies that its parent is the same-team signed
`ai.provenance.consumer.host`. It selects only its provisioned
`*.ai.provenance.evidence-vault` access group. Items are non-synchronizable and
`WhenUnlockedThisDeviceOnly`. Directly launching the bundled Node interpreter with
caller-selected JavaScript provides no broker channel, and the helper rejects that
interpreter as its parent. The public vault header contains only a random vault
identifier and a domain-separated VMK identifier. `lock()` closes SQLite, wipes
the JS VMK buffer and drops the signing `KeyObject`; `unlock()` must reacquire both
roles from Keychain. A locked or unavailable Keychain fails closed.

`rotateSigningKey()` replaces only future assertion authority. Historical records
retain their public keys and stay verifiable. `rotateVaultKey()` writes the new
Keychain item before atomically rewrapping DEKs and changing the durable header;
before doing so it commits a retirement intent in the same FULL-synchronous SQLite
database. On every open, that intent determines whether the old or replacement item
is obsolete and cleanup is retried before the intent is cleared. A process death
after the rotation commit therefore selects the new key and deterministically
retires the old item on reopen. A transient cleanup failure remains visible through
`retiredKeyRemovalPending`. `DurableVault.restore()` authenticates the complete snapshot before it
creates a destination, then provisions a fresh VMK and fresh signing identity.
Recovered history carries no old send authorization.

The native host, helper and runtime are separate executables. Production packaging must
sign the helper with `native/keychain-helper.entitlements.plist` (expanding the
Apple application-identifier prefix), seal the native host as bundle identifier
`ai.provenance.consumer.host`, sign the bundled Node with the distinct identifier
`ai.provenance.consumer.runtime`, and use the same non-ad-hoc Team ID with Hardened
Runtime for the complete bundle. The helper never authorizes the runtime identifier;
it rejects ad-hoc, unsigned, wrong-team or wrong-identifier parents. The host rejects
a modified bundle before starting Node.
The developer demonstrator build compiles both native executables but remains
explicitly ad-hoc and cannot exercise production Keychain custody. Tests inject a
fresh `MemoryKeyStore` or a fresh temporary process-test store; both are test-only
and must not be used for consumer evidence.

`new Vault(newDirectory, vaultKey, signingIdentity, { create: true })` requires a
new directory and an independently supplied random 32-byte vault key. Omit `create`
to reopen. The caller owns credential custody; this spike has no OS keychain or
account integration. The key and signing identity are never stored in the database.
Omitting the signing identity generates a fresh device identity, including after
restore. Direct `Vault` construction remains the POC/testing API; production callers
use `DurableVault`. JavaScript memory zeroization is best effort, not a secure-memory
guarantee.

Each evidence object, signed-record row, metadata row and preference receives a
fresh single-use AES-256-GCM DEK. Schema 4 derives a vault-specific wrapping key
from the VMK for each group of 65,536 nonce reservations, using domain-separated
HMAC-SHA256. Reservations are fsynced in blocks of 64 before encryption; crashes
burn unused reservations. Every wrapping key therefore stays below the original
2^20-invocation bound without imposing an archive lifetime limit. Missing or
inconsistent reservation state fails closed. Legacy direct VMK wraps remain
readable. The VMK never directly encrypts new evidence or index plaintext.
Ciphertext AAD still binds purpose, vault, role and object identity. Local rollback
by a malicious storage administrator remains outside the trusted-local-storage
assumption; snapshots never establish latest state.

Capture acknowledges only after the object, metadata, opening and signed event are
committed together. Deduplication authenticates existing content before reusing it.
Concurrent stale writes fail rather than replace a newer index. Rotation takes a
**caller-retained fresh VMK** and atomically rewraps stored DEKs without modifying
evidence ciphertext or historical signatures. Retain both old and new credentials
until rotation completes, so a crash at its commit boundary is recoverable. Used
VMKs cannot be reused in that vault. Old recovery packages retain their own old VMK.
The MVP retention policy is explicitly append-only: there is no object/record delete
or garbage-collection path, and full verification checks the complete signed sequence, object references and
authenticated checkpoint. Reads authenticate their selected rows and exact bytes. This prevents retention cleanup from
silently removing evidence, openings or proof dependencies.

Schema 4 migrates schemas 1–3 transactionally into encrypted rows and private
B-tree lookup indexes. Migration is the one-time archive scan; historical signed
records, openings and evidence bytes remain identical. Old schema writers are
rejected after publication (minimum reader 4), while legacy disclosure/recovery
readers remain supported. A pre-commit interruption leaves the old layout usable;
a post-commit interruption reopens the new layout. `adoptLegacy()` preserves the
same separated Keychain custody.

`exportRecovery()` keeps the bounded legacy JSON package for small snapshots.
It uses a fresh package-only wrapping key and the established recovery profile.
For large collections, `exportRecoveryFile(vault, path)` in `recovery-stream.mjs`
writes `pap-recovery-stream/1`: length-prefixed authenticated frames, exact signed
records, compressed payloads and an authenticated final count/chain checkpoint.
Memory is bounded to one record/object plus the SQLite page cache. Package-derived
keys encrypt at most 1,024 frames each. `inspectRecoveryFile` validates the entire
chain and rejects truncation, substitution or extra frames; `restoreRecoveryFile`
validates before creating its new destination and imports without resigning.
`DurableVault.restoreFile()` also provisions fresh app-bound keys. All recovery
forms exclude current recording consent, account credentials and cached indexes.

Keep the returned recovery key separately. `COMPLETE` means complete for that
declared snapshot; `latestState` remains `NOT_PROVEN`. Missing keys are
`UNRECOVERABLE`; missing content/openings are `INCOMPLETE`; cryptographic mismatches
are `INVALID`. The dashboard offers a short-lived, single-use streaming download
for large snapshots, and the private recovery CLI accepts `.pap-recovery` files.

`exportDisclosure(eventIds)` deliberately exports selected plaintext evidence and
portable public verification material, with no encryption/recovery/private signing
keys. `includeEvidence: false` preserves an explicit incomplete result. Verify with
`node spikes/vault/verify.mjs disclosure.json`; this verifier uses no credentials or
network. All exports are selective and local. There is no managed-service API.
This slice contains no anchor artifacts; it reports `UNANCHORED` and `LOCAL_CLAIMED`.
Signatures establish key-attributed assertions, not authorship or event truth.

When callers supply public proof bytes, disclosure profile 2 content-addresses each
proof object under a separate domain and emits it once with record-to-proof
references. The verifier checks every reference and digest before exposing the
shared material. Profile-1 bundles remain accepted. The integrated demonstrator
uses the same representation for shared anchor archives while retaining legacy
export support in its verifier.

Portable JSON transport retains its existing bounds: 32 MiB per evidence object,
1 MiB per manifest, 512 objects/records per core bundle, 256 MiB decoded evidence,
384 MiB wire size, nesting depth 32 and 256 KiB individual metadata fields.
These are operation/legacy-package limits, not a lifetime vault limit. Streaming
recovery bounds individual frames to 64 MiB. Unknown profiles, duplicate names,
noncanonical input and invalid encodings fail closed. Paths and remote content
are never interpreted by the verifier.

Local storage losslessly compresses evidence before encryption only when it saves
at least 32 bytes. Decompression is bounded by the authenticated original length;
original byte length and digest must match before evidence is returned. Portable
exports always contain original bytes, preserving signature and verifier semantics.

The [storage design, persisted-artifact audit and benchmarks](SCALING.md) cover
50,000 prompts, bounded startup, five-receipt History, indexed word search,
transactional rebuilds and the retained legacy compatibility surface.

Run `node --test test/vault.test.mjs test/vault-indexed.test.mjs test/key-lifecycle.test.mjs`. Tests use only
newly created temporary vaults, fresh in-memory or temporary-file test stores, separate synthetic
credentials and child processes. Coverage includes real SIGKILL boundaries,
injected SQLite-full errors, recovery inventory mutations, clean-device restore,
locked-key behavior, both key rotations, interrupted schema migration, rollback
reading, shared public-proof references, corruption, VMK bounds, parser limits and
cryptographic known-answer vectors. Low-disk errors are injected rather than filling
the host disk. Process-crash tests do not establish hardware/power-loss or filesystem
rollback resistance. Independent crypto/storage review is required.

Serialization follows [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html).
Cryptographic primitives use [Node.js crypto](https://nodejs.org/api/crypto.html).

## ON/OFF record compatibility

New local writes use `pap-local-record/2` with LOCAL_RECORD mode and
local_evidence_store boundary. Commitment/signature domains, key identities and selective disclosure formats stay fixed. Storage/recovery formats
are explicitly versioned independently of historical evidence. Readers continue authenticating
`pap-poc/1` and `pap-local-record/1` without rewriting old bytes or labels.
Recovered evidence does not imply recording consent; a restored installation
starts OFF. Legacy workflow journals remain inert encrypted history.
