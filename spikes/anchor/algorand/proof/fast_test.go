package proof

import (
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"github.com/algorand/go-algorand-sdk/v2/types"
	"testing"
	"time"
)

func recordedFast(t *testing.T) FastRequest {
	t.Helper()
	base := recorded(t)
	hash := HeaderHash(base.Archive.FullHeader)
	operators := []FastOperator{
		{ID: "operator-a", Organization: "Independent Operator A", Endpoint: "https://algod-a.example"},
		{ID: "operator-b", Organization: "Independent Operator B", Endpoint: "https://algod-b.example"},
	}
	sources := make([]FastSourceReport, 0, len(operators))
	for i, operator := range operators {
		sources = append(sources, FastSourceReport{
			OperatorID: operator.ID, Organization: operator.Organization, Endpoint: operator.Endpoint,
			TransactionID: base.Archive.TransactionID, ConfirmedRound: base.Archive.Round,
			BlockHeaderHash:   append([]byte(nil), hash[:]...),
			SourceClaimedTime: time.Date(2026, 9, 10, 12, i, 0, 0, time.UTC).Format(time.RFC3339Nano),
		})
	}
	return FastRequest{
		Evidence: FastEvidence{
			Profile: FastProfile, Network: base.Archive.Network, Genesis: base.Archive.Genesis,
			Consensus: base.Archive.Consensus, TransactionID: base.Archive.TransactionID,
			Transaction: base.Archive.Transaction, SignedTxnInBlock: base.Archive.SignedTxnInBlock,
			FullHeader: base.Archive.FullHeader, TransactionProof: base.Archive.TransactionProof,
			Sources: sources, ObservedWaitMillis: 4_000,
		},
		Trust: FastTrust{
			Profile: FastProfile, Network: Network, Genesis: Genesis,
			ApplicationServiceOrigin: "https://anchor.provenance.example", Operators: operators,
		},
		ExpectedPayload: base.ExpectedPayload,
	}
}

func TestFastConfirmationCorroboratesWithoutConsensusUpgrade(t *testing.T) {
	request := recordedFast(t)
	report := VerifyFast(request)
	if !report.Authorized || report.Anchor != "SOURCE_CORROBORATED" || report.Timestamp != "SOURCE_REPORTED" || report.Assurance != FastProfile {
		t.Fatalf("fast confirmation baseline failed: %+v", report)
	}
	if report.Round != request.Evidence.Sources[0].ConfirmedRound || report.BlockTime == 0 || len(report.BlockHeaderHash) != 32 || len(report.SourceClaimedTimes) != 2 {
		t.Fatalf("missing corroboration details: %+v", report)
	}
}

func TestFastConfirmationAdversarialMatrix(t *testing.T) {
	cases := []struct {
		name   string
		change func(*FastRequest)
	}{
		{"one-source", func(r *FastRequest) { r.Evidence.Sources = r.Evidence.Sources[:1] }},
		{"same-organization", func(r *FastRequest) { r.Trust.Operators[1].Organization = r.Trust.Operators[0].Organization }},
		{"same-organization-case-folded", func(r *FastRequest) { r.Trust.Operators[1].Organization = "independent operator a" }},
		{"same-host", func(r *FastRequest) { r.Trust.Operators[1].Endpoint = "https://algod-a.example/second" }},
		{"managed-service-source", func(r *FastRequest) { r.Trust.ApplicationServiceOrigin = r.Trust.Operators[0].Endpoint }},
		{"source-endpoint-mismatch", func(r *FastRequest) { r.Evidence.Sources[1].Endpoint = "https://other.example" }},
		{"source-round-conflict", func(r *FastRequest) { r.Evidence.Sources[1].ConfirmedRound++ }},
		{"source-header-conflict", func(r *FastRequest) { r.Evidence.Sources[1].BlockHeaderHash[0] ^= 1 }},
		{"source-transaction-conflict", func(r *FastRequest) { r.Evidence.Sources[1].TransactionID = "other" }},
		{"pool-error", func(r *FastRequest) { r.Evidence.Sources[0].PoolError = "rejected" }},
		{"source-error", func(r *FastRequest) { r.Evidence.Sources[0].Error = "unavailable" }},
		{"expired", func(r *FastRequest) { r.Evidence.Sources[0].Expired = true }},
		{"invalid-source-time", func(r *FastRequest) { r.Evidence.Sources[0].SourceClaimedTime = "yesterday" }},
		{"wait-timeout", func(r *FastRequest) { r.Evidence.ObservedWaitMillis = 20_001 }},
		{"wrong-network", func(r *FastRequest) { r.Evidence.Network = "mainnet-v1.0" }},
		{"wrong-genesis", func(r *FastRequest) { r.Trust.Genesis = "wrong" }},
		{"wrong-profile", func(r *FastRequest) { r.Evidence.Profile = "other" }},
		{"wrong-transaction", func(r *FastRequest) { r.Evidence.TransactionID = "fake-rpc-success" }},
		{"changed-note", func(r *FastRequest) {
			var transaction types.Transaction
			_ = DecodeMessagePack(r.Evidence.Transaction, &transaction)
			transaction.Note[5] ^= 1
			r.Evidence.Transaction = msgpack.Encode(transaction)
		}},
		{"changed-signed-transaction", func(r *FastRequest) { r.Evidence.SignedTxnInBlock[len(r.Evidence.SignedTxnInBlock)-1] ^= 1 }},
		{"altered-inclusion", func(r *FastRequest) {
			if len(r.Evidence.TransactionProof.Proof) == 0 {
				r.Evidence.TransactionProof.Proof = make([]byte, 32)
			} else {
				r.Evidence.TransactionProof.Proof[0] ^= 1
			}
		}},
		{"wrong-hash-type", func(r *FastRequest) { r.Evidence.TransactionProof.Hashtype = "sha512_256" }},
		{"wrong-expected-payload", func(r *FastRequest) { r.ExpectedPayload[4] ^= 1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := recordedFast(t)
			tc.change(&request)
			if report := VerifyFast(request); report.Authorized {
				t.Fatalf("accepted mutation: %+v", report)
			}
		})
	}
}
