package proof

import (
	"encoding/json"
	"github.com/algorand/go-algorand-sdk/v2/client/v2/common/models"
)

const Profile = "pap-algorand-sp/1"
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

func Encode(value any) []byte {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		panic(err)
	}
	return b
}
