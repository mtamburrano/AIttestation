package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/algorand/go-algorand-sdk/v2/client/v2/common/models"
	sdkcrypto "github.com/algorand/go-algorand-sdk/v2/crypto"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"github.com/algorand/go-algorand-sdk/v2/types"
	"provenance.local/algorand/proof"
)

type fakeTransport func(*http.Request) (*http.Response, error)

func (f fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(value any) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(proof.Encode(value)))}
}
func params() models.TransactionParametersResponse {
	genesis, _ := base64.StdEncoding.DecodeString(proof.Genesis)
	return models.TransactionParametersResponse{GenesisId: proof.Network, GenesisHash: genesis,
		ConsensusVersion: proof.Consensus, LastRound: 500, MinFee: fee, Fee: 0}
}

func TestPrepareAndExactReplay(t *testing.T) {
	account := sdkcrypto.GenerateAccount()
	payload := append([]byte{'P', 'A', 'P', 1}, bytes.Repeat([]byte{7}, 32)...)
	var sent [][]byte
	base := fakeTransport(func(r *http.Request) (*http.Response, error) {
		if r.Method == "GET" {
			if r.URL.String() != endpoint+"/v2/transactions/params" {
				t.Fatal("unexpected prepare endpoint")
			}
			return response(params()), nil
		}
		body, _ := io.ReadAll(r.Body)
		sent = append(sent, body)
		var txn types.SignedTxn
		if err := msgpack.Decode(body, &txn); err != nil {
			t.Fatal(err)
		}
		return response(map[string]string{"txId": sdkcrypto.GetTxID(txn.Txn)}), nil
	})
	var out bytes.Buffer
	if err := run(bytes.NewReader(proof.Encode(request{Action: "prepare", Payload: payload})), &out, account.PrivateKey, account.Address.String(), base); err != nil {
		t.Fatal(err)
	}
	var prepared prepared
	if err := json.Unmarshal(out.Bytes(), &prepared); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 0 || prepared.FeeMicroAlgos != fee || prepared.Network != proof.Network {
		t.Fatal("preparation must not broadcast")
	}
	var signed types.SignedTxn
	if err := msgpack.Decode(prepared.SignedTransaction, &signed); err != nil {
		t.Fatal(err)
	}
	if signed.Txn.Sender != account.Address || signed.Txn.Receiver != account.Address || signed.Txn.Amount != 0 ||
		signed.Txn.Fee != fee || signed.Txn.LastValid-signed.Txn.FirstValid != 20 || !bytes.Equal(signed.Txn.Note, payload) {
		t.Fatal("unexpected sponsored transaction")
	}
	for i := 0; i < 2; i++ {
		out.Reset()
		if err := run(bytes.NewReader(proof.Encode(request{Action: "broadcast", SignedTransaction: prepared.SignedTransaction})), &out, account.PrivateKey, account.Address.String(), base); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), prepared.TransactionID) {
			t.Fatal("replay changed transaction ID")
		}
	}
	if len(sent) != 2 || !bytes.Equal(sent[0], sent[1]) {
		t.Fatal("replay must reuse exact bytes")
	}
	for name, mutate := range map[string]func(*types.Transaction){
		"fee":      func(tx *types.Transaction) { tx.Fee++ },
		"amount":   func(tx *types.Transaction) { tx.Amount = 1 },
		"rekey":    func(tx *types.Transaction) { tx.RekeyTo = account.Address },
		"close":    func(tx *types.Transaction) { tx.CloseRemainderTo = account.Address },
		"group":    func(tx *types.Transaction) { tx.Group[0] = 1 },
		"lease":    func(tx *types.Transaction) { tx.Lease[0] = 1 },
		"network":  func(tx *types.Transaction) { tx.GenesisID = "mainnet-v1.0" },
		"receiver": func(tx *types.Transaction) { tx.Receiver[0] ^= 1 },
		"validity": func(tx *types.Transaction) { tx.LastValid++ },
	} {
		t.Run(name, func(t *testing.T) {
			txn := signed.Txn
			mutate(&txn)
			_, hostile, err := sdkcrypto.SignTransaction(account.PrivateKey, txn)
			if err != nil {
				t.Fatal(err)
			}
			if err := run(bytes.NewReader(proof.Encode(request{Action: "broadcast", SignedTransaction: hostile})), io.Discard, account.PrivateKey, account.Address.String(), base); err == nil {
				t.Fatal("hostile authority accepted")
			}
		})
	}
	if len(sent) != 2 {
		t.Fatal("invalid transactions reached a transport")
	}
}

func TestRejectUnsafePreparationAndRemoteResponses(t *testing.T) {
	account := sdkcrypto.GenerateAccount()
	payload := append([]byte{'P', 'A', 'P', 1}, bytes.Repeat([]byte{3}, 32)...)
	for _, kind := range []string{"network", "genesis", "consensus", "fee", "redirect", "oversized", "offline"} {
		t.Run(kind, func(t *testing.T) {
			base := fakeTransport(func(r *http.Request) (*http.Response, error) {
				p := params()
				switch kind {
				case "network":
					p.GenesisId = "mainnet-v1.0"
				case "genesis":
					p.GenesisHash[0] ^= 1
				case "consensus":
					p.ConsensusVersion = "other"
				case "fee":
					p.MinFee = fee + 1
				case "redirect":
					return &http.Response{StatusCode: 307, Body: io.NopCloser(strings.NewReader(""))}, nil
				case "oversized":
					return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 4097)))}, nil
				case "offline":
					return nil, fmt.Errorf("isolated outage")
				}
				return response(p), nil
			})
			if err := run(bytes.NewReader(proof.Encode(request{Action: "prepare", Payload: payload})), io.Discard, account.PrivateKey, account.Address.String(), base); err == nil {
				t.Fatal("unsafe parameters accepted")
			}
		})
	}
	deny := fakeTransport(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected network attempt"); return nil, nil })
	for _, body := range []string{`{"action":"prepare","filename":"private.txt"}`, `{"action":"prepare","payload":"YQ=="}`, strings.Repeat("x", 4097)} {
		if err := run(strings.NewReader(body), io.Discard, account.PrivateKey, account.Address.String(), deny); err == nil {
			t.Fatal("bad input accepted")
		}
	}
	for _, url := range []string{"https://mainnet-api.algonode.cloud/v2/transactions/params", endpoint + "/v2/accounts/secret", endpoint + "/v2/transactions/params?x=1"} {
		r, _ := http.NewRequest("GET", url, nil)
		if _, err := (transport{deny}).RoundTrip(r); err == nil {
			t.Fatal("endpoint allowlist bypass")
		}
	}
}
