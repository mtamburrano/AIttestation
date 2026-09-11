package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
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
