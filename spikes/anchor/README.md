# Offline anchor envelope experiment

The core anchors only `PAP || 0x01 || root_sha256`, exactly 36 bytes. It uses the
[RFC 9162 tree construction](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1)
over signed record digests. Neither a raw content digest nor an opening is an
anchor payload. Ordered tree size, leaf position and inclusion path are retained.

The bounded `pap-anchor-envelope/1` format separates `recordDigest`, `batch`,
`adapter` and `proof`. The adapter carries its own profile/network/genesis identity,
so switching networks does not rewrite event manifests or the root payload.

`pap-signed-log-fixture/1` is an **offline synthetic non-Algorand adapter**. Its
producer signs a log entry, while the separate verifier requires a public key and
minimum sequence selected in a separate trust configuration. Bundle-supplied keys
cannot grant authority. `FIXTURE_VERIFIED` is an experimental result meaning only
that the test log signature and record inclusion match that independently supplied
key. It is not a public-chain consensus result. Timestamps remain `SOURCE_REPORTED`.
The fixture does not prove log append-only consistency, latest state, real UTC time,
authorship or complete activity.

Verify an exported fixture using:

```sh
node spikes/anchor/verify.mjs bundle.json independent-trust.json EXPECTED_RECORD_DIGEST
```

The expected signed-record digest comes from the locally checked disclosure record.
The verifier accepts explicit local files only, imports no producer code, and has
no account/service/network client. Tests also disable Node network entry points in
its subprocess. It validates record-to-root inclusion separately from anchor trust.

## Algorand TestNet adapter

The [native adapter](algorand/README.md) implements `pap-algorand-sp/1` for one
explicit TestNet consensus version. It binds exact transaction bytes and note to
the SHA-256 transaction vector commitment, authenticates the light header through
the official State-Proof verifier and a separately supplied checkpoint, and checks
the full-header hash separately for timestamp assurance. Missing native binaries,
unsupported profiles, missing roots and forged RPC claims fail closed.

The checkpoint's initial authenticity remains an explicit source-trust assumption;
subsequent links and inclusion are checked cryptographically without company
endpoints or indexer access. See the native adapter documentation for supported
versions, custody, resource boundaries and reproducible archived tests.

## Measurements and resources

`measurement()` records explicit monotonic submission, confirmation and archival
times, bundle size and fee, preserving missing samples as null. Synthetic timing
fixtures are labeled `SYNTHETIC`; they are not Algorand performance measurements.
The live driver records actual TestNet observations separately from these synthetic
fixtures. Observed archive acquisition lag includes polling and retrieval overhead;
it is not an exact protocol publication timestamp.

An actual experiment needs an explicitly selected dedicated test network/account,
approved Algod endpoints, a separately chosen genesis/checkpoint, bounded test-only
transactions, and retained transaction/light-header/State-Proof/full-header bytes.
Keep account signing credentials outside evidence/proof bundles. Archive public
proof material, then verify with network access disabled. The live driver pins the
public AlgoNode TestNet endpoint. Account signing credentials are never configured
in this repository.

Run `node --test test/anchor.test.mjs`. Tests cover independently computed Merkle
vectors, uneven trees and path mutation, privacy of the root payload, independent
trust configuration, network/profile mismatch, forged RPC claims, a separate
network-disabled verifier process and honest pending measurement states. All data
and signing keys are synthetic; temporary files belong only to that invocation.
