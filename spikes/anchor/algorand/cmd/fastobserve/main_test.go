package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/algorand/go-algorand-sdk/v2/client/v2/common/models"
	sdkcrypto "github.com/algorand/go-algorand-sdk/v2/crypto"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"github.com/algorand/go-algorand-sdk/v2/types"
	"provenance.local/algorand/proof"
)

func recordedArchive(t *testing.T) proof.Archive {
	t.Helper()
	encoded, err := os.ReadFile(filepath.Join("..", "..", "proof", "testdata", "testnet-archive.json"))
	if err != nil {
		t.Fatal(err)
	}
	var archive proof.Archive
	if err = proof.DecodeJSON(encoded, &archive); err != nil {
		t.Fatal(err)
	}
	return archive
}

func fixtureResponses(t *testing.T, archive proof.Archive) (pending, block, transactionProof []byte) {
	t.Helper()
	var transaction types.Transaction
	var signed types.SignedTxnInBlock
	var header types.BlockHeader
	for _, item := range []struct {
		encoded []byte
		value   any
	}{{archive.Transaction, &transaction}, {archive.SignedTxnInBlock, &signed}, {archive.FullHeader, &header}} {
		if err := proof.DecodeMessagePack(item.encoded, item.value); err != nil {
			t.Fatal(err)
		}
	}
	fullSigned := signed.SignedTxn
	fullSigned.Txn = transaction
	pending = msgpack.Encode(models.PendingTransactionInfoResponse{
		ConfirmedRound: archive.Round, PoolError: "", Transaction: fullSigned,
	})
	block = msgpack.Encode(models.BlockResponse{Block: types.Block{
		BlockHeader: header, Payset: types.Payset{signed},
	}})
	transactionProof, err := json.Marshal(archive.TransactionProof)
	if err != nil {
		t.Fatal(err)
	}
	return
}

func TestObserveUsesOnlyThreeBoundedTLSReads(t *testing.T) {
	archive := recordedArchive(t)
	pending, block, transactionProof := fixtureResponses(t, archive)
	requests := map[string]int{}
	var mutex sync.Mutex
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		requests[request.URL.EscapedPath()+"?"+request.URL.RawQuery]++
		mutex.Unlock()
		switch {
		case request.URL.Path == "/v2/transactions/pending/"+archive.TransactionID && request.URL.RawQuery == "format=msgpack":
			response.Header().Set("Content-Type", "application/msgpack")
			_, _ = response.Write(pending)
		case request.URL.Path == "/v2/blocks/67143203" && request.URL.RawQuery == "format=msgpack":
			response.Header().Set("Content-Type", "application/msgpack")
			_, _ = response.Write(block)
		case request.URL.Path == "/v2/blocks/67143203/transactions/"+archive.TransactionID+"/proof" && request.URL.RawQuery == "hashtype=sha256":
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write(transactionProof)
		default:
			http.Error(response, "not found", http.StatusNotFound)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := observe(ctx, observerRequest{
		Profile:       requestProfile,
		Operator:      proof.FastOperator{ID: "isolated", Organization: "Isolated TLS Operator", Endpoint: server.URL},
		TransactionID: archive.TransactionID,
	}, server.Client().Transport)
	if err != nil {
		t.Fatal(err)
	}
	if result.Profile != proof.FastProfile || result.TransactionID != archive.TransactionID || result.ConfirmedRound != archive.Round {
		t.Fatalf("unexpected observation identity: %+v", result)
	}
	if !bytes.Equal(result.Transaction, archive.Transaction) || !bytes.Equal(result.SignedTxnInBlock, archive.SignedTxnInBlock) ||
		!bytes.Equal(result.FullHeader, archive.FullHeader) || result.TransactionProof.Hashtype != "sha256" {
		t.Fatal("observer did not preserve the exact cryptographic material")
	}
	if _, err = time.Parse(time.RFC3339Nano, result.SourceClaimedTime); err != nil {
		t.Fatalf("invalid source-reported block time: %v", err)
	}
	if len(requests) != 3 {
		t.Fatalf("expected exactly three allowlisted reads, got %#v", requests)
	}
	for path, count := range requests {
		if count != 1 {
			t.Fatalf("unexpected repeated read %s: %d", path, count)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestObserverTransportRejectsEscapesRedirectsAndOversize(t *testing.T) {
	endpoint, err := exactEndpoint("https://operator.example")
	if err != nil {
		t.Fatal(err)
	}
	transactionID := strings.Repeat("A", 52)
	base := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusFound, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("redirect"))}, nil
	})
	transport := allowlistedTransport{base: base, scheme: "https", host: endpoint.Host,
		allowed: allowedRequests(endpoint, transactionID, 0), maximumBody: 32}
	allowed := "https://operator.example/v2/transactions/pending/" + transactionID + "?format=msgpack"
	request, _ := http.NewRequest(http.MethodGet, allowed, nil)
	if _, err = transport.RoundTrip(request); err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("redirect should be rejected, got %v", err)
	}
	for _, raw := range []string{
		"http://operator.example/v2/transactions/pending/" + transactionID + "?format=msgpack",
		"https://other.example/v2/transactions/pending/" + transactionID + "?format=msgpack",
		"https://operator.example/v2/status",
		allowed + "&extra=true",
	} {
		request, _ = http.NewRequest(http.MethodGet, raw, nil)
		if _, err = transport.RoundTrip(request); err == nil || !strings.Contains(err.Error(), "allowlist") {
			t.Fatalf("request escape should be rejected: %s (%v)", raw, err)
		}
	}
	overlarge := allowlistedTransport{base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, ContentLength: 33, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 33)))}, nil
	}), scheme: "https", host: endpoint.Host, allowed: allowedRequests(endpoint, transactionID, 0), maximumBody: 32}
	request, _ = http.NewRequest(http.MethodGet, allowed, nil)
	if _, err = overlarge.RoundTrip(request); err == nil || !strings.Contains(err.Error(), "byte limit") {
		t.Fatalf("oversize response should be rejected, got %v", err)
	}
	chunked := allowlistedTransport{base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, ContentLength: -1, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 33)))}, nil
	}), scheme: "https", host: endpoint.Host, allowed: allowedRequests(endpoint, transactionID, 0), maximumBody: 32}
	response, err := chunked.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.ReadAll(response.Body); err == nil || !strings.Contains(err.Error(), "byte limit") {
		t.Fatalf("chunked oversize response should be rejected while reading, got %v", err)
	}
	_ = response.Body.Close()
}

func TestObserverRequiresCanonicalHTTPSAndProductionTLS(t *testing.T) {
	for _, raw := range []string{
		"http://operator.example", "https://user@operator.example", "https://operator.example/",
		"https://operator.example?network=testnet", "https://operator.example/#fragment",
		"https://operator.example/api/../algod", "https://:443",
	} {
		if _, err := exactEndpoint(raw); err == nil {
			t.Fatalf("unsafe endpoint accepted: %s", raw)
		}
	}
	transport := productionTransport()
	if transport.Proxy != nil || transport.TLSClientConfig == nil || transport.TLSClientConfig.MinVersion < tls.VersionTLS12 ||
		transport.ResponseHeaderTimeout <= 0 || transport.TLSHandshakeTimeout <= 0 {
		t.Fatal("production observer transport is not explicitly bounded TLS")
	}
}

func TestOnlyExplicitPendingStatesProduceRetryResults(t *testing.T) {
	archive := recordedArchive(t)
	pending, _, _ := fixtureResponses(t, archive)
	var unconfirmed models.PendingTransactionInfoResponse
	if err := msgpack.Decode(pending, &unconfirmed); err != nil {
		t.Fatal(err)
	}
	unconfirmed.ConfirmedRound = 0
	for _, item := range []struct {
		name   string
		status int
		body   []byte
		reason string
	}{
		{"not found", 404, []byte(`{"message":"not in this node's pool"}`), "ALGOD_NOT_YET_OBSERVABLE"},
		{"unconfirmed", 200, msgpack.Encode(unconfirmed), "ALGOD_NOT_YET_CONFIRMED"},
		{"trailing pending data", 200, append(msgpack.Encode(unconfirmed), 0xc0), ""},
		{"unexpected success status", 201, msgpack.Encode(unconfirmed), ""},
		{"malformed not found", 404, []byte(`not JSON`), ""},
		{"missing error message", 404, []byte(`{}`), ""},
		{"ambiguous not found", 404, []byte(`{"message":"a","message":"b"}`), ""},
		{"malformed success", 200, []byte{0xc1}, ""},
		{"missing transaction", 200, msgpack.Encode(models.PendingTransactionInfoResponse{}), ""},
		{"unauthorized", 401, []byte(`{"message":"unauthorized"}`), ""},
		{"rate limit", 429, []byte(`{"message":"limited"}`), ""},
		{"server error", 500, []byte(`{"message":"unavailable"}`), ""},
	} {
		t.Run(item.name, func(t *testing.T) {
			calls := 0
			request := observerRequest{requestProfile, proof.FastOperator{
				ID: "fixture", Organization: "Isolated Operator", Endpoint: "https://operator.invalid"}, archive.TransactionID}
			transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != http.MethodGet || r.URL.Path != "/v2/transactions/pending/"+archive.TransactionID {
					t.Fatalf("unexpected observation request: %s %s", r.Method, r.URL.Path)
				}
				return &http.Response{StatusCode: item.status, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(item.body))}, nil
			})
			var output bytes.Buffer
			err := run(bytes.NewReader(proof.Encode(request)), &output, transport)
			var retry retryObservation
			if err == nil || errors.As(err, &retry) != (item.reason != "") || calls != 1 {
				t.Fatalf("unexpected result: %v (calls %d)", err, calls)
			}
			if item.reason == "" {
				if output.Len() != 0 {
					t.Fatalf("terminal failure produced retry evidence: %s", output.String())
				}
			} else {
				var result retryObservation
				if err := proof.DecodeJSON(output.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if result != (retryObservation{retryProfile, archive.TransactionID, item.reason}) {
					t.Fatalf("unexpected retry result: %+v", result)
				}
			}
		})
	}
}

func TestPendingConflictsAndPostConfirmationFailuresAreTerminal(t *testing.T) {
	archive := recordedArchive(t)
	pending, block, _ := fixtureResponses(t, archive)
	for _, kind := range []string{"pool error", "transaction", "network", "genesis", "signature", "block missing", "proof missing"} {
		t.Run(kind, func(t *testing.T) {
			var value models.PendingTransactionInfoResponse
			if err := msgpack.Decode(pending, &value); err != nil {
				t.Fatal(err)
			}
			request := observerRequest{requestProfile, proof.FastOperator{
				ID: "fixture", Organization: "Isolated Operator", Endpoint: "https://operator.invalid"}, archive.TransactionID}
			if kind != "block missing" && kind != "proof missing" {
				value.ConfirmedRound = 0
			}
			switch kind {
			case "pool error":
				value.PoolError = "rejected"
			case "transaction":
				value.Transaction.Txn.Note[0] ^= 1
			case "network":
				value.Transaction.Txn.GenesisID = "wrong-network"
				request.TransactionID = sdkcrypto.GetTxID(value.Transaction.Txn)
			case "genesis":
				value.Transaction.Txn.GenesisHash[0] ^= 1
				request.TransactionID = sdkcrypto.GetTxID(value.Transaction.Txn)
			case "signature":
				value.Transaction.Sig[0] ^= 1
			}
			transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
				status, body := 404, []byte(`{"message":"not found"}`)
				if strings.Contains(r.URL.Path, "/pending/") {
					status, body = 200, msgpack.Encode(value)
				} else if kind == "proof missing" && !strings.HasSuffix(r.URL.Path, "/proof") {
					status, body = 200, block
				}
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body))}, nil
			})
			_, err := observe(context.Background(), request, transport)
			var retry retryObservation
			if err == nil || errors.As(err, &retry) {
				t.Fatalf("conflict or post-confirmation failure was retryable: %v", err)
			}
		})
	}
}

func TestObserverCancellationStopsTheOnlyActiveRead(t *testing.T) {
	archive := recordedArchive(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		cancel()
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	_, err := observe(ctx, observerRequest{requestProfile, proof.FastOperator{
		ID: "fixture", Organization: "Isolated Operator", Endpoint: "https://operator.invalid"}, archive.TransactionID}, transport)
	var retry retryObservation
	if err == nil || errors.As(err, &retry) || !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("unexpected cancellation result: %v (calls %d)", err, calls)
	}
}
