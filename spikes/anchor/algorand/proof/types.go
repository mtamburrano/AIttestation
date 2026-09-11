package proof

import (
	"encoding/json"
	"github.com/algorand/go-algorand-sdk/v2/client/v2/common/models"
)

const Profile = "pap-algorand-sp/1"
const FastProfile = "PAP_ALGORAND_FAST_CONFIRM_V1"
const Consensus = "https://github.com/algorandfoundation/specs/tree/268b63433a907455d439995bf916f6b296018f4f"
const Network = "testnet-v1.0"
const Genesis = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="
const Interval uint64 = 256
const MaxArchive = 8 << 20

type Trust struct {
	Profile           string `json:"profile"`
	Network           string `json:"network"`
	Genesis           string `json:"genesis"`
	Consensus         string `json:"consensus"`
	LastAttestedRound uint64 `json:"lastAttestedRound"`
	VotersCommitment  []byte `json:"votersCommitment"`
	LnProvenWeight    uint64 `json:"lnProvenWeight"`
	Source            string `json:"source"`
	SelectedAt        string `json:"selectedAt"`
}

type Link struct {
	Message    []byte `json:"message"`
	StateProof []byte `json:"stateProof"`
}

type Archive struct {
	Format           string                       `json:"format"`
	Network          string                       `json:"network"`
	Genesis          string                       `json:"genesis"`
	Consensus        string                       `json:"consensus"`
	Round            uint64                       `json:"round"`
	TransactionID    string                       `json:"transactionId"`
	Transaction      []byte                       `json:"transaction"`
	SignedTxnInBlock []byte                       `json:"signedTxnInBlock"`
	FullHeader       []byte                       `json:"fullHeader"`
	LightHeader      []byte                       `json:"lightHeader"`
	TransactionProof models.TransactionProof      `json:"transactionProof"`
	LightProof       models.LightBlockHeaderProof `json:"lightProof"`
	Chain            []Link                       `json:"chain"`
}

type Report struct {
	Anchor                string `json:"anchor"`
	Timestamp             string `json:"timestamp"`
	IndependentlyVerified bool   `json:"independentlyVerified"`
	Reason                string `json:"reason"`
	Round                 uint64 `json:"round,omitempty"`
	BlockTime             int64  `json:"blockTime,omitempty"`
	TrustAssumption       string `json:"trustAssumption,omitempty"`
}

type Request struct {
	Archive         Archive `json:"archive"`
	Trust           *Trust  `json:"trust"`
	ExpectedPayload []byte  `json:"expectedPayload"`
}

type FastOperator struct {
	ID           string `json:"id"`
	Organization string `json:"organization"`
	Endpoint     string `json:"endpoint"`
}

type FastTrust struct {
	Profile                  string         `json:"profile"`
	Network                  string         `json:"network"`
	Genesis                  string         `json:"genesis"`
	ApplicationServiceOrigin string         `json:"applicationServiceOrigin"`
	Operators                []FastOperator `json:"operators"`
}

type FastSourceReport struct {
	OperatorID        string `json:"operatorId"`
	Organization      string `json:"organization"`
	Endpoint          string `json:"endpoint"`
	TransactionID     string `json:"transactionId"`
	ConfirmedRound    uint64 `json:"confirmedRound"`
	BlockHeaderHash   []byte `json:"blockHeaderHash"`
	SourceClaimedTime string `json:"sourceClaimedTime"`
	PoolError         string `json:"poolError"`
	Error             string `json:"error"`
	Expired           bool   `json:"expired"`
}

type FastEvidence struct {
	Profile            string                  `json:"profile"`
	Network            string                  `json:"network"`
	Genesis            string                  `json:"genesis"`
	Consensus          string                  `json:"consensus"`
	TransactionID      string                  `json:"transactionId"`
	Transaction        []byte                  `json:"transaction"`
	SignedTxnInBlock   []byte                  `json:"signedTxnInBlock"`
	FullHeader         []byte                  `json:"fullHeader"`
	TransactionProof   models.TransactionProof `json:"transactionProof"`
	Sources            []FastSourceReport      `json:"sources"`
	ObservedWaitMillis uint64                  `json:"observedWaitMillis"`
}

type FastRequest struct {
	Evidence        FastEvidence `json:"evidence"`
	Trust           FastTrust    `json:"trust"`
	ExpectedPayload []byte       `json:"expectedPayload"`
}

type FastReport struct {
	Profile            string   `json:"profile"`
	Anchor             string   `json:"anchor"`
	Timestamp          string   `json:"timestamp"`
	Authorized         bool     `json:"authorized"`
	Round              uint64   `json:"round,omitempty"`
	BlockTime          int64    `json:"blockTime,omitempty"`
	BlockHeaderHash    []byte   `json:"blockHeaderHash,omitempty"`
	SourceClaimedTimes []string `json:"sourceClaimedTimes,omitempty"`
	Assurance          string   `json:"assurance"`
	Reason             string   `json:"reason"`
}

func Encode(value any) []byte {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		panic(err)
	}
	return b
}
