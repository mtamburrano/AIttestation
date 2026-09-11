package proof

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"
	"time"

	sdkcrypto "github.com/algorand/go-algorand-sdk/v2/crypto"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"github.com/algorand/go-algorand-sdk/v2/types"
)

const fastWaitBudgetMillis uint64 = 20_000

func VerifyFast(req FastRequest) (r FastReport) {
	r = FastReport{
		Profile:   FastProfile,
		Anchor:    "INVALID",
		Timestamp: "INDETERMINATE",
		Assurance: "NONE",
	}
	defer func() {
		if recover() != nil {
			r = FastReport{Profile: FastProfile, Anchor: "INVALID", Timestamp: "INDETERMINATE", Assurance: "NONE", Reason: "Malformed fast confirmation evidence"}
		}
	}()
	if err := verifyFast(req, &r); err != nil {
		r.Authorized = false
		r.Reason = err.Error()
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

func exactHTTPS(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("INVALID: operator endpoint")
	}
	return u, nil
}

func verifyFast(req FastRequest, r *FastReport) error {
	e := req.Evidence
	t := req.Trust
	if e.Profile != FastProfile || t.Profile != FastProfile {
		return fmt.Errorf("UNSUPPORTED: fast confirmation profile")
	}
	if e.Network != Network || e.Genesis != Genesis || t.Network != Network || t.Genesis != Genesis {
		return fmt.Errorf("INVALID: TestNet identity")
	}
	if e.Consensus != Consensus {
		return fmt.Errorf("UNSUPPORTED: consensus profile")
	}
	if len(req.ExpectedPayload) != 36 || !bytes.Equal(req.ExpectedPayload[:4], []byte{'P', 'A', 'P', 1}) {
		return fmt.Errorf("INVALID: expected anchor payload")
	}
	if e.ObservedWaitMillis > fastWaitBudgetMillis {
		return fmt.Errorf("INDETERMINATE: 20-second confirmation budget exceeded")
	}
	if len(t.Operators) != 2 || len(e.Sources) != 2 {
		return fmt.Errorf("INVALID: exactly two corroborating operators required")
	}
	app, err := exactHTTPS(t.ApplicationServiceOrigin)
	if err != nil {
		return fmt.Errorf("INVALID: application service origin")
	}
	trusted := make(map[string]FastOperator, 2)
	organizations := make(map[string]bool, 2)
	hosts := make(map[string]bool, 2)
	for _, operator := range t.Operators {
		u, endpointErr := exactHTTPS(operator.Endpoint)
		organization := strings.ToLower(strings.TrimSpace(operator.Organization))
		if endpointErr != nil || operator.ID == "" || organization == "" || operator.Organization != strings.TrimSpace(operator.Organization) || trusted[operator.ID].ID != "" {
			return fmt.Errorf("INVALID: operator trust configuration")
		}
		host := strings.ToLower(u.Hostname())
		if strings.EqualFold(host, app.Hostname()) || organizations[organization] || hosts[host] {
			return fmt.Errorf("INVALID: operators must be distinct from each other and the application service")
		}
		trusted[operator.ID] = operator
		organizations[organization] = true
		hosts[host] = true
	}

	var transaction types.Transaction
	var signed types.SignedTxnInBlock
	var header types.BlockHeader
	for _, item := range []struct {
		bytes []byte
		out   any
	}{{e.Transaction, &transaction}, {e.SignedTxnInBlock, &signed}, {e.FullHeader, &header}} {
		if err = DecodeMessagePack(item.bytes, item.out); err != nil {
			return err
		}
	}
	if header.CurrentProtocol != Consensus {
		return fmt.Errorf("UNSUPPORTED: full-header consensus")
	}
	if header.GenesisID != Network || base64.StdEncoding.EncodeToString(header.GenesisHash[:]) != Genesis || uint64(header.Round) == 0 {
		return fmt.Errorf("INVALID: full-header network/round")
	}
	round := uint64(header.Round)
	if !bytes.Equal(transaction.Note, req.ExpectedPayload) || transaction.GenesisID != Network || transaction.GenesisHash != header.GenesisHash || transaction.Type != types.PaymentTx || transaction.Sender != transaction.Receiver || transaction.Amount != 0 || transaction.CloseRemainderTo != (types.Address{}) || transaction.RekeyTo != (types.Address{}) || transaction.Group != (types.Digest{}) || uint64(transaction.Fee) == 0 || uint64(transaction.Fee) > 1000 {
		return fmt.Errorf("INVALID: exact bounded self-payment")
	}
	if uint64(transaction.FirstValid) > round || uint64(transaction.LastValid) < round || sdkcrypto.GetTxID(transaction) != e.TransactionID {
		return fmt.Errorf("INVALID: transaction identity/round")
	}
	reconstructed := signed.Txn
	if reconstructed.GenesisID != "" || reconstructed.GenesisHash != (types.Digest{}) || signed.HasGenesisHash {
		return fmt.Errorf("INVALID: compressed transaction genesis")
	}
	if signed.HasGenesisID {
		reconstructed.GenesisID = header.GenesisID
	}
	reconstructed.GenesisHash = header.GenesisHash
	if !bytes.Equal(msgpack.Encode(reconstructed), e.Transaction) {
		return fmt.Errorf("INVALID: transaction differs from committed SignedTxnInBlock")
	}
	if signed.AuthAddr != (types.Address{}) || !ed25519.Verify(ed25519.PublicKey(transaction.Sender[:]), append([]byte("TX"), e.Transaction...), signed.Sig[:]) {
		return fmt.Errorf("INVALID: transaction signature")
	}
	proof := e.TransactionProof
	if proof.Hashtype != "sha256" {
		return fmt.Errorf("UNSUPPORTED: transaction hash profile")
	}
	signedHash := sum256("STIB", e.SignedTxnInBlock)
	if !bytes.Equal(signedHash, proof.Stibhash) {
		return fmt.Errorf("INVALID: computed SignedTxnInBlock hash")
	}
	leaf := append(sum256("TX", e.Transaction), signedHash...)
	if err = vector(header.Sha256Commitment[:], proof.Idx, proof.Treedepth, proof.Proof, "TL", leaf); err != nil {
		return fmt.Errorf("INVALID: transaction membership: %w", err)
	}

	headerHash := HeaderHash(e.FullHeader)
	seen := make(map[string]bool, 2)
	times := make([]string, 0, 2)
	for _, source := range e.Sources {
		operator, ok := trusted[source.OperatorID]
		if !ok || seen[source.OperatorID] || source.Organization != operator.Organization || source.Endpoint != operator.Endpoint {
			return fmt.Errorf("INVALID: untrusted or duplicate operator report")
		}
		seen[source.OperatorID] = true
		if source.TransactionID != e.TransactionID || source.ConfirmedRound != round || !bytes.Equal(source.BlockHeaderHash, headerHash[:]) {
			return fmt.Errorf("INVALID: conflicting transaction, round, or block-header report")
		}
		if source.PoolError != "" || source.Error != "" || source.Expired {
			return fmt.Errorf("INDETERMINATE: operator reported pool, error, or expiry state")
		}
		if _, parseErr := time.Parse(time.RFC3339Nano, source.SourceClaimedTime); parseErr != nil {
			return fmt.Errorf("INVALID: source-reported time")
		}
		times = append(times, source.SourceClaimedTime)
	}

	r.Anchor = "SOURCE_CORROBORATED"
	r.Timestamp = "SOURCE_REPORTED"
	r.Authorized = true
	r.Round = round
	r.BlockTime = header.TimeStamp
	r.BlockHeaderHash = append([]byte(nil), headerHash[:]...)
	r.SourceClaimedTimes = times
	r.Assurance = FastProfile
	r.Reason = "Exact transaction binding and SHA-256 inclusion verified locally against one header independently reported by two configured algod operators"
	return nil
}
