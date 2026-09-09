# Algorand TestNet archived verification

This bounded native adapter uses Go 1.25.1, Algorand SDK v2.12.0 and the official
State-Proof verifier v1.0.0. It supports only `pap-algorand-sp/1` on `testnet-v1.0`
with genesis hash `SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` and consensus
version `268b63433a907455d439995bf916f6b296018f4f` (v42). Unknown versions fail closed.
This profile inherits SHA-256 transaction commitments, 256-round State-Proof
intervals and light-header block-hash binding.

The [recorded results](RESULTS.md) include a real exported TestNet proof, measured
confirmation/archive lag, collection failures and OS-enforced offline validation.

`make build` creates ignored `bin/verify` and `bin/live` executables. `make test`
uses only recorded public fixtures and fresh temporary filesystem resources.
No default test contacts a network or reads signing credentials. The native
verifier reads one bounded JSON request from stdin and emits dimensional results.
Its package and command import no network client or live producer code.

The JavaScript anchor envelope remains unchanged: network-specific material lives
inside `proof`. The JS verifier invokes this fixed local executable, with an empty
environment, a 30-second deadline and bounded output. It never executes paths or
code specified by a proof bundle. Missing binaries return `UNSUPPORTED`.

## What is verified

The verifier decodes bounded canonical MessagePack, reconstructs the exact
transaction from its compressed SignedTxnInBlock, validates its ID/signature and
network, and requires an exact 36-byte PAP note in a zero-value self-payment.
It computes both SHA-256 transaction and SignedTxnInBlock hashes locally; it never
trusts a supplied transaction leaf. Algorand's `TL` vector commitment proves those
bytes against the light header's transaction root, with position binding.

Every State-Proof message must advance exactly one 256-round interval from the
separately supplied voter-commitment/weight checkpoint. Falcon signatures, weights,
reveals, proof trees and successive contexts are verified by the pinned official
library. The matching `B256` light-header inclusion path must land in the final
authenticated interval. Missing/skipped links, altered messages, wrong roots and
unsupported profiles cannot upgrade assurance.

Timestamp validation is separate: SHA-512/256 of `BH || canonical full-header`
must match the authenticated light header's block hash. A changed timestamp leaves
transaction inclusion `CONSENSUS_VERIFIED` but sets timestamp `INVALID` and makes
the overall verification unsuccessful. A valid complete archive reports
`CONSENSUS_VERIFIED` and `BLOCK_HASH_BOUND`, not authorship, exact UTC creation time,
provider receipt, complete history or latest-state proof.

## Independent checkpoint and trust assumption

The live experiment selects its TestNet checkpoint before submitting the anchor,
stores it outside the producer bundle, and passes it explicitly to the verifier.
The checkpoint is source-trusted from AlgoNode over HTTPS. Its authenticity is an
explicit trust assumption: this is not a genesis-to-tip bootstrap or corroboration
by independently operated nodes. Subsequent State-Proof links and inclusion are
cryptographically verified offline. The bundle cannot supply its own authority.
The recorded checkpoint file is a public test fixture, not an automatically trusted
production default. A recipient must independently select their own trust input.

## Live resource boundary

The experiment uses a newly generated dedicated TestNet account, funded only with
free faucet ALGO. Its seed is in an owner-only file outside the repository. Neither
the seed nor a mnemonic is included in output, proof fixtures, exports or metadata.
The live driver rejects repository directories and symlink aliases for custody.
The account's public address is passed explicitly and checked against the local
key. No existing account, wallet/keychain, MainNet endpoint or inherited proxy is
used.

The only enabled transaction is a zero-value self-payment with a 36-byte blinded
note and 1,000 microALGO fee. An exclusively created, fsynced submission record
precedes egress and prevents a repeated `submit` command from submitting again.
An unknown confirmation never causes an automatic re-sign or resend. Retain this
record to preserve the guard.

The fixed live endpoint is `https://testnet-api.algonode.cloud`; transport guards
reject other schemes/hosts and mutation methods except transaction submission.
Indexer queries are unnecessary. `collect` only reads public proof material and
waits at most 35 minutes, polling every five seconds. State-Proof API lookup uses
the **interval-ending round**; the light-header lookup uses the transaction round.
Confirmation remains explicitly source-reported until independent proof checking.

Live commands are explicit and excluded from test scripts:

```sh
bin/live checkpoint "$TESTNET_RUN_DIR"
bin/live submit "$TESTNET_RUN_DIR" "$NEW_TESTNET_PUBLIC_ADDRESS"
bin/live collect "$TESTNET_RUN_DIR"
```

The dedicated directory must already contain the separately selected public
checkpoint source, synthetic blinded payload and newly generated seed. Never point
these commands at an existing account or operational directory. Free faucet login
is handled separately; there are no paid funds, token contracts or asset operations.
Recorded metrics distinguish source confirmation latency from observed complete
archive acquisition lag. The latter includes polling and retrieval overhead and is
not the exact protocol publication instant. A single sample is not a latency SLA.

## Implementation references

The native implementation follows hash-domain and encoding definitions from the
[pinned official Algorand source revision](https://github.com/algorand/go-algorand/tree/3f80455969769b54b0effc691e3cc0c422138c01),
including `data/bookkeeping/txn_merkle.go`, `lightBlockHeader.go`, `block.go`,
`config/consensus.go` and `protocol/hash.go`. Cryptographic proof checking uses the
[official MIT-licensed State-Proof library](https://github.com/algorand/go-stateproof-verification).
Dependencies remain pinned in `go.mod`/`go.sum`; source is not vendored. Independent
security/protocol review remains required before production use.
