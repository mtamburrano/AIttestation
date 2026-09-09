package proof

import (
	"bytes"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"github.com/algorand/go-algorand-sdk/v2/types"
	"os"
	"testing"
)

func recorded(t *testing.T) Request {
	t.Helper()
	var req Request
	for _, p := range []struct {
		path string
		out  any
	}{{"testdata/testnet-archive.json", &req.Archive}, {"testdata/independent-checkpoint.json", &req.Trust}, {"testdata/expected-payload.json", &req.ExpectedPayload}} {
		b, e := os.ReadFile(p.path)
		if e != nil {
			t.Fatal(e)
		}
		if e = DecodeJSON(b, p.out); e != nil {
			t.Fatal(e)
		}
	}
	return req
}

func TestRecordedTestNetArchive(t *testing.T) {
	req := recorded(t)
	r := Verify(req)
	if !r.IndependentlyVerified || r.Anchor != "CONSENSUS_VERIFIED" || r.Timestamp != "BLOCK_HASH_BOUND" {
		t.Fatalf("positive archived baseline failed: %+v", r)
	}
	if r.Round != req.Archive.Round || r.TrustAssumption == "" {
		t.Fatal("missing trust/round disclosure")
	}
}

func TestRecordedAdversarialMatrix(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Request)
	}{
		{"wrong-network", func(r *Request) { r.Archive.Network = "mainnet-v1.0" }},
		{"wrong-genesis", func(r *Request) { r.Archive.Genesis = "wrong" }},
		{"unknown-consensus", func(r *Request) { r.Archive.Consensus = "unknown" }},
		{"missing-root", func(r *Request) { r.Trust = nil }},
		{"wrong-checkpoint-network", func(r *Request) { r.Trust.Network = "mainnet-v1.0" }},
		{"changed-checkpoint", func(r *Request) { r.Trust.VotersCommitment[0] ^= 1 }},
		{"impossible-checkpoint-weight", func(r *Request) { r.Trust.LnProvenWeight = ^uint64(0) }},
		{"missing-chain", func(r *Request) { r.Archive.Chain = nil }},
		{"missing-chain-link", func(r *Request) { r.Archive.Chain = r.Archive.Chain[1:] }},
		{"wrong-round", func(r *Request) { r.Archive.Round++ }},
		{"wrong-txid", func(r *Request) { r.Archive.TransactionID = "fake-rpc-confirmation" }},
		{"changed-note", func(r *Request) {
			var tx types.Transaction
			_ = DecodeMessagePack(r.Archive.Transaction, &tx)
			tx.Note[5] ^= 1
			r.Archive.Transaction = msgpack.Encode(tx)
		}},
		{"changed-transaction-bytes", func(r *Request) { r.Archive.Transaction[len(r.Archive.Transaction)-1] ^= 1 }},
		{"changed-stib", func(r *Request) { r.Archive.SignedTxnInBlock[len(r.Archive.SignedTxnInBlock)-1] ^= 1 }},
		{"rpc-supplied-leaf-hash", func(r *Request) { r.Archive.TransactionProof.Stibhash[0] ^= 1 }},
		{"altered-inclusion", func(r *Request) {
			if len(r.Archive.TransactionProof.Proof) == 0 {
				r.Archive.TransactionProof.Proof = make([]byte, 32)
			} else {
				r.Archive.TransactionProof.Proof[0] ^= 1
			}
		}},
		{"wrong-hash-type", func(r *Request) { r.Archive.TransactionProof.Hashtype = "sha512_256" }},
		{"wrong-position", func(r *Request) { r.Archive.TransactionProof.Idx++ }},
		{"truncated-light-path", func(r *Request) { r.Archive.LightProof.Proof = r.Archive.LightProof.Proof[32:] }},
		{"wrong-light-position", func(r *Request) { r.Archive.LightProof.Index++ }},
		{"altered-state-proof", func(r *Request) { r.Archive.Chain[0].StateProof[len(r.Archive.Chain[0].StateProof)/2] ^= 1 }},
		{"altered-state-message", func(r *Request) {
			var m types.Message
			_ = DecodeMessagePack(r.Archive.Chain[0].Message, &m)
			m.BlockHeadersCommitment[0] ^= 1
			r.Archive.Chain[0].Message = msgpack.Encode(m)
		}},
		{"wrong-interval", func(r *Request) {
			var m types.Message
			_ = DecodeMessagePack(r.Archive.Chain[0].Message, &m)
			m.FirstAttestedRound++
			r.Archive.Chain[0].Message = msgpack.Encode(m)
		}},
		{"wrong-payload", func(r *Request) { r.ExpectedPayload[4] ^= 1 }},
		{"trailing-msgpack", func(r *Request) { r.Archive.FullHeader = append(r.Archive.FullHeader, 0x80) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := recorded(t)
			c.change(&req)
			r := Verify(req)
			if r.IndependentlyVerified {
				t.Fatalf("accepted mutation: %+v", r)
			}
		})
	}
}

func TestTimestampDoesNotBorrowInclusionAssurance(t *testing.T) {
	req := recorded(t)
	before := Verify(req)
	if !before.IndependentlyVerified {
		t.Fatal(before)
	}
	unchangedProof := append([]byte(nil), req.Archive.LightHeader...)
	var header types.BlockHeader
	if e := DecodeMessagePack(req.Archive.FullHeader, &header); e != nil {
		t.Fatal(e)
	}
	header.TimeStamp++
	req.Archive.FullHeader = msgpack.Encode(header)
	after := Verify(req)
	if !bytes.Equal(unchangedProof, req.Archive.LightHeader) || after.Anchor != "CONSENSUS_VERIFIED" || after.Timestamp != "INVALID" || after.IndependentlyVerified {
		t.Fatalf("timestamp incorrectly inherited assurance: %+v", after)
	}
}
