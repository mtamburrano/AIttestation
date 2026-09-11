package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/algorand/go-algorand-sdk/v2/client/v2/algod"
	sdkcrypto "github.com/algorand/go-algorand-sdk/v2/crypto"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"github.com/algorand/go-algorand-sdk/v2/transaction"
	"github.com/algorand/go-algorand-sdk/v2/types"
	"provenance.local/algorand/proof"
)

const endpoint = "https://testnet-api.algonode.cloud"
const fee = 1000

type request struct {
	Action            string `json:"action"`
	Payload           []byte `json:"payload"`
	SignedTransaction []byte `json:"signedTransaction"`
}
type prepared struct {
	TransactionID     string `json:"transactionId"`
	SignedTransaction []byte `json:"signedTransaction"`
	FeeMicroAlgos     uint64 `json:"feeMicroAlgos"`
	Network           string `json:"network"`
}
type transport struct{ base http.RoundTripper }

func (t transport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" || r.URL.Host != "testnet-api.algonode.cloud" || r.URL.User != nil ||
		r.URL.RawQuery != "" || r.URL.Fragment != "" ||
		!((r.Method == "GET" && r.URL.EscapedPath() == "/v2/transactions/params") ||
			(r.Method == "POST" && r.URL.EscapedPath() == "/v2/transactions")) {
		return nil, fmt.Errorf("sponsor endpoint allowlist")
	}
	response, err := t.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return nil, fmt.Errorf("sponsor redirects rejected")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(body) > 4096 {
		return nil, fmt.Errorf("sponsor response limit")
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	return response, nil
}

func validPayload(payload []byte) bool {
	return len(payload) == 36 && bytes.Equal(payload[:4], []byte{'P', 'A', 'P', 1})
}

func run(input io.Reader, output io.Writer, private ed25519.PrivateKey, expected string, base http.RoundTripper) error {
	encoded, err := io.ReadAll(io.LimitReader(input, 4097))
	if err != nil || len(encoded) > 4096 {
		return fmt.Errorf("sponsor request limit")
	}
	var req request
	if err = proof.DecodeJSON(encoded, &req); err != nil {
		return err
	}
	account, err := sdkcrypto.AccountFromPrivateKey(private)
	if err != nil || account.Address.String() != expected {
		return fmt.Errorf("dedicated sponsor account mismatch")
	}
	c, err := algod.MakeClientWithTransport(endpoint, "", nil, transport{base})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	var result any
	switch req.Action {
	case "prepare":
		if !validPayload(req.Payload) || len(req.SignedTransaction) != 0 {
			return fmt.Errorf("only a blinded payload may be prepared")
		}
		params, err := c.SuggestedParams().Do(ctx)
		if err != nil {
			return err
		}
		if params.GenesisID != proof.Network || base64.StdEncoding.EncodeToString(params.GenesisHash) != proof.Genesis ||
			params.ConsensusVersion != proof.Consensus || params.MinFee > fee || params.FirstRoundValid == 0 ||
			params.FirstRoundValid > types.Round(^uint64(0)-20) {
			return fmt.Errorf("unsupported sponsor network, consensus or fee")
		}
		params.FlatFee, params.Fee, params.LastRoundValid = true, fee, params.FirstRoundValid+20
		txn, err := transaction.MakePaymentTxn(expected, expected, 0, req.Payload, "", params)
		if err != nil {
			return err
		}
		txid, signed, err := sdkcrypto.SignTransaction(private, txn)
		if err != nil {
			return err
		}
		result = prepared{txid, signed, fee, proof.Network}
	case "broadcast":
		if len(req.Payload) != 0 || len(req.SignedTransaction) == 0 || len(req.SignedTransaction) > 1024 {
			return fmt.Errorf("only a prepared transaction may be broadcast")
		}
		var signed types.SignedTxn
		if err := msgpack.Decode(req.SignedTransaction, &signed); err != nil {
			return err
		}
		txn := signed.Txn
		if !validPayload(txn.Note) || txn.FirstValid == 0 || txn.FirstValid > types.Round(^uint64(0)-20) || txn.LastValid != txn.FirstValid+20 {
			return fmt.Errorf("invalid sponsor payload or validity window")
		}
		genesis, _ := base64.StdEncoding.DecodeString(proof.Genesis)
		params := types.SuggestedParams{FlatFee: true, Fee: fee, GenesisID: proof.Network, GenesisHash: genesis,
			FirstRoundValid: txn.FirstValid, LastRoundValid: txn.LastValid}
		allowed, err := transaction.MakePaymentTxn(expected, expected, 0, txn.Note, "", params)
		if err != nil {
			return err
		}
		// Exact reconstruction excludes rekey/close/transfer/group/lease authority and verifies the signature.
		txid, expectedSigned, err := sdkcrypto.SignTransaction(private, allowed)
		if err != nil || !bytes.Equal(expectedSigned, req.SignedTransaction) {
			return fmt.Errorf("transaction escaped sponsor authority")
		}
		sent, err := c.SendRawTransaction(req.SignedTransaction).Do(ctx)
		if err != nil || sent != txid {
			return fmt.Errorf("submission is unknown")
		}
		result = map[string]string{"transactionId": txid}
	default:
		return fmt.Errorf("unsupported sponsor action")
	}
	_, err = output.Write(proof.Encode(result))
	return err
}

func loadKey(path string) (ed25519.PrivateKey, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("absolute dedicated seed path required")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return nil, fmt.Errorf("seed aliases are forbidden")
	}
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		if _, err := os.Stat(filepath.Join(parent, ".git")); err == nil {
			return nil, fmt.Errorf("sponsor key must remain outside repositories")
		}
		if parent == filepath.Dir(parent) {
			break
		}
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() != 32 {
		return nil, fmt.Errorf("owner-only 32-byte dedicated seed required")
	}
	seed, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	defer clear(seed)
	return ed25519.NewKeyFromSeed(seed), nil
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "Usage: sponsor DEDICATED_TESTNET_SEED_PATH EXPECTED_SPONSOR_ADDRESS")
		os.Exit(1)
	}
	private, err := loadKey(os.Args[1])
	if err == nil {
		defer clear(private)
		base := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
			TLSHandshakeTimeout: 2 * time.Second, ResponseHeaderTimeout: 3 * time.Second,
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
		err = run(os.Stdin, os.Stdout, private, os.Args[2], base)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Sponsor operation unavailable")
		os.Exit(1)
	}
}
