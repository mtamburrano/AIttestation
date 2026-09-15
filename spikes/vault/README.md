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

Each object and immutable encrypted index receives a fresh single-use AES-256-GCM
DEK. A VMK wraps DEKs using durably reserved 96-bit counter nonces, capped at 2^20
invocations. Reservations commit before encryption; interrupted work burns nonces.
Missing or inconsistent reservation state blocks encryption. Local database rollback
by a malicious storage administrator is outside the trusted-local-storage assumption.
The VMK is never used directly for object/index encryption. Ciphertext AAD binds
purpose, crypto profile, vault, object/key role and recovery package/snapshot where
applicable. Each recovery key wraps exactly one VMK for one package.

Capture acknowledges only after the object, metadata, opening and signed event are
committed together. Deduplication authenticates existing content before reusing it.
Concurrent stale writes fail rather than replace a newer index. Rotation takes a
**caller-retained fresh VMK** and atomically rewraps stored DEKs without modifying
evidence ciphertext or historical signatures. Retain both old and new credentials
until rotation completes, so a crash at its commit boundary is recoverable. Used
VMKs cannot be reused in that vault. Old recovery packages retain their own old VMK.
The MVP retention policy is explicitly append-only: there is no object/record delete
or garbage-collection path, and the encrypted index rejects both missing referenced
objects and unreferenced private objects. This prevents retention cleanup from
silently removing evidence, openings or proof dependencies.

Schema 2 added a transactionally installed compatibility marker. Schema 3 adds the
durable key-retirement journal. Both are additive and preserve the schema-1
encrypted index/wire formats. Interrupted migration rolls back as a unit; schema-1
readers remain permitted after upgrade. `adoptLegacy()` validates a
live schema-1 vault and then installs its supplied VMK/signing identity into the
separated Keychain roles. New readers continue to accept schema-1 disclosures and
recovery packages.

`exportRecovery()` returns an encrypted package and a separate recovery key; keep
the key separately. Its authenticated encrypted inventory binds every object,
record, opening, ciphertext digest, byte length, count and snapshot checkpoint.
`restoreRecovery(package, recoveryKey, newDirectory, newVMK)` authenticates all
material before creating the destination, then stores it under fresh local keys.
`COMPLETE` means complete for that declared snapshot; `latestState` is always
`NOT_PROVEN`. Missing keys are `UNRECOVERABLE`; missing content/openings are
`INCOMPLETE`; cryptographic mismatches are `INVALID`.

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

The JSON transport is a bounded canonical format, not an extracted archive. Binary
ciphertexts/objects use canonical 128-KiB chunks, keeping each encoded field below
256 KiB. Limits are 32 MiB per evidence object, 1 MiB per manifest, 512 objects and
records, 256 MiB total decoded evidence, 384 MiB encoded transport and nesting depth
32. Unknown fields/profiles, duplicate JSON names, noncanonical input and malformed
UTF-8/base64url fail closed. Names are never interpreted as paths; no decompression,
remote references or active content execution is supported.

Run `node --test test/vault.test.mjs test/key-lifecycle.test.mjs`. Tests use only
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
local_evidence_store boundary. Commitment/signature domains, encrypted storage,
key identities and recovery format stay fixed. Readers continue authenticating
`pap-poc/1` and `pap-local-record/1` without rewriting old bytes or labels.
Recovered evidence does not imply recording consent; a restored installation
starts OFF. Legacy workflow journals remain inert encrypted history.
