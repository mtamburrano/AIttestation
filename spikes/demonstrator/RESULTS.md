# Integrated demonstration results

On 2026-09-10, three new synthetic drafts and binary attachments were captured
in Continuous, Sealed and scoped Always Protect modes. Their signed descriptors
were batched into one 36-byte blinded commitment. A fresh dedicated TestNet account
received 5 free faucet ALGO, and submitted exactly one zero-value self-payment.
No existing account, paid funds, MainNet or real AI provider was used.

| Observation | Result |
| --- | --- |
| Transaction | `67IWOVEKAW322Q2LBJMA2RYPM57P6Y7NAAM72NTYLGT4FBOQ66TA` |
| Confirmation round | 67153906 |
| Source confirmation latency | 5,678 ms |
| Complete archive observed after confirmation | 393,262 ms (6 min 33.262 s) |
| Archive size | 179,303 bytes |
| State-Proof chain | Two consecutive links, through round 67153920 |
| Separately selected checkpoint | Round 67153408, selected before submission |
| Fee | 1,000 microALGO (0.001 free TestNet ALGO) |
| All three anchor / timestamp results | `CONSENSUS_VERIFIED` / `BLOCK_HASH_BOUND` |
| Restore | `COMPLETE` for the declared snapshot; latest state `NOT_PROVEN` |
| Restored send authority | None |

Continuous released before anchoring. Sealed and Always Protect remained pending
until independent archive checking succeeded, reached sealed-not-sent state, and
then released only their exact frozen payloads. Edited payloads and unsupported
scope were rejected. This deliberately conservative demonstrator waits for full
archival proof; it does not implement a lower-latency source-confirmation policy.

The live API harness validates the actual Algorand-to-vault-to-release path. The
separate isolated Chrome walkthrough validates automatic scoped UI behavior,
visible provider DOM text capture, binary attachments, downloads and fresh restore.
The live harness does not falsely label API strings as browser-observed output.

The [live integration report](testdata/live-integration-report.json),
[measurements](testdata/measurements.json), [original export](testdata/evidence-export.json),
[restored export](testdata/restored-evidence-export.json), and separate
[trust input](testdata/independent-trust.json) contain only synthetic evidence and
public proof material. Signing and recovery secrets remain outside the repository.
The checkpoint is source-trusted from AlgoNode HTTPS; this is an explicit assumption,
not independently corroborated genesis-to-tip trust. Observed archive lag includes
polling/retrieval and is not an SLA.

Both original and restored exports passed separate verifier processes under macOS
`sandbox-exec` with all network access denied. Reproduce after building the native
verifier:

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' node test/demonstrator-archive.mjs
```

The local packaged Chrome rehearsal measured 75.08 ms fixture sealing and 163.12 ms
restore, with 78,093-byte disclosure and 95,850-byte encrypted recovery. These are
synthetic local observations, not chain latency or representative storage rates.

The macOS arm64 app was opened through Finder without participant terminal commands.
Its paired Chrome page reported ready 1,872.80 ms after runtime startup (server
startup 29.07 ms). The profile was newly created with extensions, external DNS and
personal-keychain use disabled. No Gatekeeper approval appeared for this locally
built artifact. It has an ad-hoc signature only; downloaded/notarized distribution
and owner usability acceptance remain separate checks. Build and runtime timings
do not substitute for the owner's installation experience.
