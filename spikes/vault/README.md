# Encrypted evidence and recovery slice

This dependency-free Node.js 22.13+ library uses SQLite WAL with FULL synchronous
transactions. It implements exact-byte whole-object capture, encrypted private
deduplication, canonical manifests, randomized commitments and Ed25519 assertions.
The durable lifecycle targets Apple-silicon macOS; the lower-level vault remains
portable for offline verification and isolated tests.

## Durable macOS keys

`DurableVault.create()` and `DurableVault.open()` in `key-lifecycle.mjs` keep the
active Ed25519 signing private key and the 256-bit vault master key in distinct
macOS Keychain generic-password items. Secret values are supplied to the Keychain
tool over stdin, never argv. The public vault header contains only a random vault
identifier and a domain-separated VMK identifier. `lock()` closes SQLite, wipes
the JS VMK buffer and drops the signing `KeyObject`; `unlock()` must reacquire both
roles from Keychain. A locked or unavailable Keychain fails closed.

`rotateSigningKey()` replaces only future assertion authority. Historical records
retain their public keys and stay verifiable. `rotateVaultKey()` writes the new
Keychain item before atomically rewrapping DEKs and changing the durable header;
post-commit interruption selects the new key on reopen. A failure to delete the
retired Keychain item is reported without misreporting a committed rotation as
failed. `DurableVault.restore()` authenticates the complete snapshot before it
creates a destination, then provisions a fresh VMK and fresh signing identity.
Recovered history carries no old send authorization.

The production adapter intentionally writes only to the user's default macOS
Keychain: the `security` CLI cannot combine its safe stdin prompt with an explicit
custom-keychain pathname. Tests therefore inject a fresh `MemoryKeyStore`; it is
test-only and must not be used for consumer evidence.

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

Schema 2 adds only a transactionally installed compatibility marker and preserves
the schema-1 encrypted index/wire formats. Interrupted migration rolls back as a
unit; schema-1 readers remain permitted after upgrade. `adoptLegacy()` validates a
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
newly created temporary vaults, fresh in-memory key stores, separate synthetic
credentials and child processes. Coverage includes real SIGKILL boundaries,
injected SQLite-full errors, recovery inventory mutations, clean-device restore,
locked-key behavior, both key rotations, interrupted schema migration, rollback
reading, shared public-proof references, corruption, VMK bounds, parser limits and
cryptographic known-answer vectors. Low-disk errors are injected rather than filling
the host disk. Process-crash tests do not establish hardware/power-loss or filesystem
rollback resistance. Independent crypto/storage review is required.

Serialization follows [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html).
Cryptographic primitives use [Node.js crypto](https://nodejs.org/api/crypto.html).
