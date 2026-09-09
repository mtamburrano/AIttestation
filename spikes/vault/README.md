# Encrypted evidence and recovery slice

This dependency-free Node.js 22.13+ experiment uses SQLite WAL with FULL synchronous
transactions. It implements exact-byte whole-object capture, encrypted private
deduplication, canonical manifests, randomized commitments and Ed25519 assertions.
It is a standalone local library, not yet integrated with the release laboratory.

`new Vault(newDirectory, vaultKey, signingIdentity, { create: true })` requires a
new directory and an independently supplied random 32-byte vault key. Omit `create`
to reopen. The caller owns credential custody; this spike has no OS keychain or
account integration. The key and signing identity are never stored in the database.
Omitting the signing identity generates a fresh device identity, including after
restore. JavaScript memory zeroization is best effort, not a secure-memory guarantee.

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

The JSON transport is a bounded canonical format, not an extracted archive. Binary
ciphertexts/objects use canonical 128-KiB chunks, keeping each encoded field below
256 KiB. Limits are 32 MiB per evidence object, 1 MiB per manifest, 512 objects and
records, 256 MiB total decoded evidence, 384 MiB encoded transport and nesting depth
32. Unknown fields/profiles, duplicate JSON names, noncanonical input and malformed
UTF-8/base64url fail closed. Names are never interpreted as paths; no decompression,
remote references or active content execution is supported.

Run `node --test test/vault.test.mjs`. Tests use only newly created temporary vaults,
separate synthetic credentials and child processes. Coverage includes real SIGKILL
boundaries, injected SQLite-full errors, recovery inventory mutations, clean-device
restore, corruption, missing material, private dedup, VMK bounds/rotation, parser
limits and cryptographic known-answer vectors. Low-disk errors are injected rather
than filling the host disk. Process-crash tests do not establish hardware/power-loss
or filesystem rollback resistance. Independent crypto/storage review is required.

Serialization follows [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html).
Cryptographic primitives use [Node.js crypto](https://nodejs.org/api/crypto.html).
