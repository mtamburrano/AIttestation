package proof

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"fmt"
	sdkcrypto "github.com/algorand/go-algorand-sdk/v2/crypto"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"github.com/algorand/go-algorand-sdk/v2/types"
	"github.com/algorand/go-stateproof-verification/merklearray"
	"github.com/algorand/go-stateproof-verification/stateproof"
	spcrypto "github.com/algorand/go-stateproof-verification/stateproofcrypto"
	"strings"
)

type hashable struct {
	domain spcrypto.HashID
	data   []byte
}

func (h hashable) ToBeHashed() (spcrypto.HashID, []byte) { return h.domain, h.data }
func sum256(domain string, b []byte) []byte {
	h := sha256.New()
	h.Write([]byte(domain))
	h.Write(b)
	return h.Sum(nil)
}
func HeaderHash(b []byte) types.Digest { return sha512.Sum512_256(append([]byte("BH"), b...)) }
func Light(header types.BlockHeader) types.LightBlockHeader {
	return types.LightBlockHeader{BlockHash: HeaderHash(msgpack.Encode(header)), RoundNumber: header.Round, GenesisHash: header.GenesisHash, Sha256TxnCommitment: header.Sha256Commitment}
}

func vector(root []byte, index, depth uint64, path []byte, domain string, data []byte) error {
	if len(root) != 32 || depth > 16 || index >= uint64(1)<<depth || len(path) != int(depth)*32 {
		return fmt.Errorf("INVALID: vector dimensions")
	}
	proof := merklearray.Proof{TreeDepth: uint8(depth), HashFactory: spcrypto.HashFactory{HashType: spcrypto.Sha256}}
	for n := 0; n < len(path); n += 32 {
		proof.Path = append(proof.Path, spcrypto.GenericDigest(path[n:n+32]))
	}
	return merklearray.VerifyVectorCommitment(root, map[uint64]spcrypto.Hashable{index: hashable{spcrypto.HashID(domain), data}}, &proof)
}

func Verify(req Request) (r Report) {
	r = Report{Anchor: "INVALID", Timestamp: "INDETERMINATE"}
	defer func() {
		if recover() != nil {
			r = Report{Anchor: "INVALID", Timestamp: "INDETERMINATE", Reason: "Malformed cryptographic proof"}
		}
	}()
	err := verify(req, &r)
	if err != nil {
		r.IndependentlyVerified = false
		r.Reason = err.Error()
		if r.Timestamp == "INVALID" && r.Anchor == "CONSENSUS_VERIFIED" {
			// Preserve proven transaction inclusion when only the supplied timestamp/header fails.
			return r
		}
		if strings.HasPrefix(err.Error(), "UNSUPPORTED") || strings.HasPrefix(err.Error(), "LIMIT_EXCEEDED") {
			r.Anchor = "UNSUPPORTED"
		} else if strings.HasPrefix(err.Error(), "INDETERMINATE") {
			r.Anchor = "INDETERMINATE"
		} else {
			r.Anchor = "INVALID"
		}
	}
	return r
}

func verify(req Request, r *Report) error {
	a := req.Archive
	t := req.Trust
	if a.Format != "algorand-archive/1" || a.Consensus != Consensus {
		return fmt.Errorf("UNSUPPORTED: archive/consensus profile")
	}
	if a.Network != Network || a.Genesis != Genesis {
		return fmt.Errorf("INVALID: TestNet identity")
	}
	if len(req.ExpectedPayload) != 36 || !bytes.Equal(req.ExpectedPayload[:4], []byte{'P', 'A', 'P', 1}) {
		return fmt.Errorf("INVALID: expected anchor payload")
	}
	var txn types.Transaction
	var stib types.SignedTxnInBlock
	var header types.BlockHeader
	var light types.LightBlockHeader
	for _, x := range []struct {
		b   []byte
		out any
	}{{a.Transaction, &txn}, {a.SignedTxnInBlock, &stib}, {a.FullHeader, &header}, {a.LightHeader, &light}} {
		if err := DecodeMessagePack(x.b, x.out); err != nil {
			return err
		}
	}
	if header.CurrentProtocol != Consensus {
		return fmt.Errorf("UNSUPPORTED: full-header consensus")
	}
	if header.GenesisID != Network || base64.StdEncoding.EncodeToString(header.GenesisHash[:]) != Genesis || uint64(header.Round) != a.Round {
		return fmt.Errorf("INVALID: full-header network/round")
	}
	if base64.StdEncoding.EncodeToString(light.GenesisHash[:]) != Genesis || uint64(light.RoundNumber) != a.Round || light.Seed != (types.Seed{}) {
		return fmt.Errorf("INVALID: light-header network/round/profile")
	}
	if !bytes.Equal(txn.Note, req.ExpectedPayload) || txn.GenesisID != Network || txn.GenesisHash != header.GenesisHash || txn.Type != types.PaymentTx || txn.Sender != txn.Receiver || txn.Amount != 0 || txn.CloseRemainderTo != (types.Address{}) || txn.RekeyTo != (types.Address{}) || txn.Group != (types.Digest{}) || uint64(txn.Fee) > 1000 || uint64(txn.Fee) == 0 {
		return fmt.Errorf("INVALID: exact bounded self-payment")
	}
	if uint64(txn.FirstValid) > a.Round || uint64(txn.LastValid) < a.Round || sdkcrypto.GetTxID(txn) != a.TransactionID {
		return fmt.Errorf("INVALID: transaction identity/round")
	}
	reconstructed := stib.Txn
	if reconstructed.GenesisID != "" || reconstructed.GenesisHash != (types.Digest{}) || stib.HasGenesisHash {
		return fmt.Errorf("INVALID: compressed transaction genesis")
	}
	if stib.HasGenesisID {
		reconstructed.GenesisID = header.GenesisID
	}
	reconstructed.GenesisHash = header.GenesisHash
	if !bytes.Equal(msgpack.Encode(reconstructed), a.Transaction) {
		return fmt.Errorf("INVALID: transaction differs from committed SignedTxnInBlock")
	}
	if stib.AuthAddr != (types.Address{}) || !ed25519.Verify(ed25519.PublicKey(txn.Sender[:]), append([]byte("TX"), a.Transaction...), stib.Sig[:]) {
		return fmt.Errorf("INVALID: transaction signature")
	}
	txProof := a.TransactionProof
	if txProof.Hashtype != "sha256" {
		return fmt.Errorf("UNSUPPORTED: transaction hash profile")
	}
	stibHash := sum256("STIB", a.SignedTxnInBlock)
	if !bytes.Equal(stibHash, txProof.Stibhash) {
		return fmt.Errorf("INVALID: computed SignedTxnInBlock hash")
	}
	leaf := append(sum256("TX", a.Transaction), stibHash...)
	if err := vector(light.Sha256TxnCommitment[:], txProof.Idx, txProof.Treedepth, txProof.Proof, "TL", leaf); err != nil {
		return fmt.Errorf("INVALID: transaction membership: %w", err)
	}
	r.Anchor = "BLOCK_MEMBERSHIP_VERIFIED"
	if t == nil {
		return fmt.Errorf("INDETERMINATE: independently provisioned checkpoint missing")
	}
	if t.Profile != Profile || t.Consensus != Consensus {
		return fmt.Errorf("UNSUPPORTED: trust profile")
	}
	if t.Network != Network || t.Genesis != Genesis {
		return fmt.Errorf("INVALID: trusted network mismatch")
	}
	if len(t.VotersCommitment) != 64 || t.LnProvenWeight == 0 || t.LastAttestedRound == 0 || t.LastAttestedRound%Interval != 0 {
		return fmt.Errorf("INDETERMINATE: checkpoint incomplete")
	}
	if len(a.Chain) == 0 {
		return fmt.Errorf("INDETERMINATE: State-Proof chain missing")
	}
	if len(a.Chain) > 32 {
		return fmt.Errorf("LIMIT_EXCEEDED: State-Proof chain")
	}
	last := t.LastAttestedRound
	voters := t.VotersCommitment
	weight := t.LnProvenWeight
	var target types.Message
	for i, link := range a.Chain {
		var message types.Message
		var sp stateproof.StateProof
		if err := DecodeMessagePack(link.Message, &message); err != nil {
			return err
		}
		if err := DecodeMessagePack(link.StateProof, &sp); err != nil {
			return err
		}
		if message.FirstAttestedRound != last+1 || message.LastAttestedRound != last+Interval || len(message.BlockHeadersCommitment) != 32 || len(message.VotersCommitment) != 64 || message.LnProvenWeight == 0 {
			return fmt.Errorf("INVALID: State-Proof interval/context chain")
		}
		if len(sp.Reveals) == 0 || len(sp.Reveals) > 640 || len(sp.PositionsToReveal) > 640 || sp.PartProofs.HashFactory.HashType != spcrypto.Sumhash || sp.SigProofs.HashFactory.HashType != spcrypto.Sumhash {
			return fmt.Errorf("UNSUPPORTED: State-Proof parameters")
		}
		for _, reveal := range sp.Reveals {
			if reveal.SigSlot.Sig.Proof.TreeDepth > 16 || len(reveal.SigSlot.Sig.Proof.Path) != int(reveal.SigSlot.Sig.Proof.TreeDepth) || reveal.SigSlot.Sig.Proof.HashFactory.HashType != spcrypto.Sumhash {
				return fmt.Errorf("INVALID: signature vector shape")
			}
		}
		verifier := stateproof.MkVerifierWithLnProvenWeight(voters, weight)
		if err := verifier.Verify(message.LastAttestedRound, spcrypto.MessageHash(sdkcrypto.HashStateProofMessage(&message)), &sp); err != nil {
			return fmt.Errorf("INVALID: State-Proof verification: %w", err)
		}
		if a.Round >= message.FirstAttestedRound && a.Round <= message.LastAttestedRound {
			if i != len(a.Chain)-1 {
				return fmt.Errorf("INVALID: trailing State-Proof contexts")
			}
			target = message
		}
		last = message.LastAttestedRound
		voters = message.VotersCommitment
		weight = message.LnProvenWeight
	}
	if target.LastAttestedRound == 0 {
		return fmt.Errorf("INDETERMINATE: target interval absent")
	}
	lp := a.LightProof
	if lp.Treedepth != 8 || lp.Index != a.Round-target.FirstAttestedRound {
		return fmt.Errorf("INVALID: light-header interval position")
	}
	if err := vector(target.BlockHeadersCommitment, lp.Index, lp.Treedepth, lp.Proof, "B256", a.LightHeader); err != nil {
		return fmt.Errorf("INVALID: light-header membership: %w", err)
	}
	r.Anchor = "CONSENSUS_VERIFIED"
	r.Round = a.Round
	r.TrustAssumption = "Explicit separately provisioned pre-submission checkpoint; checkpoint authenticity is a trust assumption, not a genesis-to-tip proof"
	if HeaderHash(a.FullHeader) != light.BlockHash || header.Sha256Commitment != light.Sha256TxnCommitment {
		r.Timestamp = "INVALID"
		return fmt.Errorf("INVALID: full-header timestamp/hash binding")
	}
	r.Timestamp = "BLOCK_HASH_BOUND"
	r.BlockTime = header.TimeStamp
	r.IndependentlyVerified = true
	r.Reason = "Exact transaction and State-Proof chain verified offline under the selected checkpoint"
	return nil
}
