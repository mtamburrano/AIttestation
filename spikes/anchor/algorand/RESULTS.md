# Recorded TestNet experiment

One synthetic record was anchored on 2026-09-09 using a newly generated dedicated
TestNet account funded with 10 free faucet ALGO. Exactly one zero-value self-payment
was submitted. Its 36-byte note contains only the blinded PAP Merkle payload.

| Observation | Recorded result |
| --- | --- |
| Transaction | `QU4LJEDFCWMTAJX5C27COMM6WED2OAC7OEML2BXD5N6TY6E2NUFQ` |
| Confirmation round | 67143203 |
| Source confirmation latency | 5,525 ms |
| Complete archive observed after confirmation | 1,003,681 ms (16 min 43.681 s) |
| Complete archive acquisition time | 2026-09-09 17:48:28.214003 UTC |
| Native archive JSON | 443,845 bytes |
| Canonical anchor envelope | 443,966 bytes |
| State-Proof chain | Five consecutive intervals, ending at 67143424 |
| Transaction fee | 1,000 microALGO (0.001 free TestNet ALGO) |
| Offline anchor / timestamp result | `CONSENSUS_VERIFIED` / `BLOCK_HASH_BOUND` |

The public [measurements](proof/testdata/measurements.json),
[archive](proof/testdata/testnet-archive.json),
[envelope](proof/testdata/anchor-envelope.json),
[synthetic disclosure](proof/testdata/disclosure.json) and
[verification report](proof/testdata/offline-verification-report.json) are retained.
Signing material is absent from these artifacts and stays outside the repository.

## Availability and failure observations

Confirmation did not make an archival proof immediately available. The endpoint
returned HTTP 404 while the relevant State Proof was pending. An initial collector
used a transaction round where this endpoint needed the interval-ending round;
that lookup was corrected without resubmitting the transaction.

After the target proof appeared, fetching the first checkpoint link returned HTTP
500 with a missing historical ledger entry. The earlier successfully downloaded
and cryptographically checked copy of that same public link restored collection.
The final collector now preserves available earlier links before its bounded wait
and reuses local cached links, whose authenticity is still verified by the offline
verifier. A cache supplies proof bytes, never authority.

The recorded lag is an **observed complete acquisition upper bound**, including
polling, retrieval and the collection repair. It is not the precise publication
instant or a network SLA. The metrics' one poll and 1,570 ms collector duration
describe the final successful collection invocation, not the preceding pending
polls. No second transaction or paid resource was needed.

## Independent offline check

The verifier used the separately stored checkpoint ending at round 67142144,
selected before submission. That checkpoint is trusted from AlgoNode HTTPS;
its initial authenticity is an explicit assumption, not genesis-to-tip proof or
independent node corroboration. The bundle cannot substitute its own checkpoint.
All five successor State Proofs, transaction inclusion and the block-hash binding
were checked cryptographically using the pinned official library.

The native verifier and the full JavaScript disclosure-to-record-to-anchor test
both succeeded under macOS `sandbox-exec` with `(deny network*)`. A curl request
to the same public TestNet endpoint failed under that policy as a control. This
blocks company endpoints, indexers and every other network service during checking.

After building with `npm run test:algorand`, reproduce the full offline check on
macOS from the repository root:

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' node test/algorand-archive.mjs
```

The native suite passes the positive recorded proof, 25 hostile archive mutations,
timestamp-only tampering, decoder limits and live endpoint/custody guards. The
JavaScript integration rejects forged RPC metadata, missing/wrong roots and a
missing native verifier. The 30-test default suite also passes, including a
non-Algorand signed-log fixture using the same envelope and record schemas.

The collector prefetch/cache improvement was built and checked by the offline
suite; no additional live submission was made to retest the full waiting cycle.
