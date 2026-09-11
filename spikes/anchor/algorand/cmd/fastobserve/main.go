package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	pathpkg "path"
	"regexp"
	"strings"
	"time"

	"github.com/algorand/go-algorand-sdk/v2/client/v2/algod"
	"github.com/algorand/go-algorand-sdk/v2/client/v2/common/models"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"provenance.local/algorand/proof"
)

const (
	requestProfile    = "pap-algod-observer-request/1"
	requestLimit      = 16 << 10
	responseBodyLimit = 16 << 20
	observationBudget = 18 * time.Second
)

var transactionIDPattern = regexp.MustCompile(`^[A-Z2-7]{52}$`)

type observerRequest struct {
	Profile       string             `json:"profile"`
	Operator      proof.FastOperator `json:"operator"`
	TransactionID string             `json:"transactionId"`
}

type observation struct {
	Profile           string                  `json:"profile"`
	Network           string                  `json:"network"`
	Genesis           string                  `json:"genesis"`
	Consensus         string                  `json:"consensus"`
	TransactionID     string                  `json:"transactionId"`
	ConfirmedRound    uint64                  `json:"confirmedRound"`
	BlockHeaderHash   []byte                  `json:"blockHeaderHash"`
	SourceClaimedTime string                  `json:"sourceClaimedTime"`
	PoolError         string                  `json:"poolError"`
	Error             string                  `json:"error"`
	Expired           bool                    `json:"expired"`
	Transaction       []byte                  `json:"transaction"`
	SignedTxnInBlock  []byte                  `json:"signedTxnInBlock"`
	FullHeader        []byte                  `json:"fullHeader"`
	TransactionProof  models.TransactionProof `json:"transactionProof"`
}

type limitedBody struct {
	reader    io.Reader
	closer    io.Closer
	remaining int64
}

func (b *limitedBody) Read(buffer []byte) (int, error) {
	if b.remaining < 0 {
		return 0, fmt.Errorf("algod response exceeded the byte limit")
	}
	if int64(len(buffer)) > b.remaining+1 {
		buffer = buffer[:b.remaining+1]
	}
	count, err := b.reader.Read(buffer)
	if int64(count) > b.remaining {
		allowed := int(b.remaining)
		b.remaining = -1
		return allowed, fmt.Errorf("algod response exceeded the byte limit")
	}
	b.remaining -= int64(count)
	return count, err
}
func (b *limitedBody) Close() error { return b.closer.Close() }

type allowlistedTransport struct {
	base        http.RoundTripper
	scheme      string
	host        string
	allowed     map[string]string
	maximumBody int64
}

func (t allowlistedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	query, permitted := t.allowed[request.URL.EscapedPath()]
	if request.Method != http.MethodGet || request.Body != nil || request.URL.Scheme != t.scheme ||
		request.URL.Host != t.host || request.URL.User != nil || request.URL.Fragment != "" ||
		!permitted || request.URL.RawQuery != query {
		return nil, fmt.Errorf("observer request escaped the configured HTTPS endpoint allowlist")
	}
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		response.Body.Close()
		return nil, fmt.Errorf("algod redirects are not accepted")
	}
	if response.ContentLength > t.maximumBody {
		response.Body.Close()
		return nil, fmt.Errorf("algod response exceeded the byte limit")
	}
	response.Body = &limitedBody{reader: response.Body, closer: response.Body, remaining: t.maximumBody}
	return response, nil
}

func exactEndpoint(raw string) (*url.URL, error) {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.Hostname() == "" || endpoint.User != nil ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.RawPath != "" ||
		strings.HasSuffix(endpoint.Path, "/") || strings.Contains(endpoint.Path, "//") ||
		(endpoint.Path != "" && pathpkg.Clean(endpoint.Path) != endpoint.Path) || endpoint.String() != raw {
		return nil, fmt.Errorf("invalid configured algod HTTPS endpoint")
	}
	return endpoint, nil
}

func allowedRequests(endpoint *url.URL, transactionID string, round uint64) map[string]string {
	prefix := endpoint.EscapedPath()
	if round == 0 {
		return map[string]string{
			prefix + "/v2/transactions/pending/" + transactionID: "format=msgpack",
		}
	}
	return map[string]string{
		prefix + fmt.Sprintf("/v2/blocks/%d", round):                                      "format=msgpack",
		prefix + fmt.Sprintf("/v2/blocks/%d/transactions/%s/proof", round, transactionID): "hashtype=sha256",
	}
}

func productionTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 4 * time.Second, KeepAlive: -1}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxConnsPerHost:       2,
		IdleConnTimeout:       5 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 6 * time.Second,
		ExpectContinueTimeout: time.Second,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
}

func clientFor(endpoint *url.URL, transactionID string, round uint64, base http.RoundTripper) (*algod.Client, error) {
	transport := allowlistedTransport{
		base: base, scheme: endpoint.Scheme, host: endpoint.Host,
		allowed: allowedRequests(endpoint, transactionID, round), maximumBody: responseBodyLimit,
	}
	return algod.MakeClientWithTransport(endpoint.String(), "", nil, transport)
}

func observe(ctx context.Context, request observerRequest, base http.RoundTripper) (observation, error) {
	if request.Profile != requestProfile || request.Operator.ID == "" || request.Operator.Organization == "" ||
		request.Operator.Organization != strings.TrimSpace(request.Operator.Organization) ||
		!transactionIDPattern.MatchString(request.TransactionID) {
		return observation{}, fmt.Errorf("invalid observer request")
	}
	endpoint, err := exactEndpoint(request.Operator.Endpoint)
	if err != nil {
		return observation{}, err
	}

	// The pending endpoint determines the immutable round. Reconstruct a new
	// allowlist containing only the three reads that can prove this transaction.
	pendingClient, err := clientFor(endpoint, request.TransactionID, 0, base)
	if err != nil {
		return observation{}, err
	}
	pending, signed, err := pendingClient.PendingTransactionInformation(request.TransactionID).Do(ctx)
	if err != nil {
		return observation{}, fmt.Errorf("algod pending-transaction observation failed: %w", err)
	}
	if pending.PoolError != "" || pending.ConfirmedRound == 0 {
		return observation{}, fmt.Errorf("algod has not supplied an unambiguous confirmed round")
	}

	client, err := clientFor(endpoint, request.TransactionID, pending.ConfirmedRound, base)
	if err != nil {
		return observation{}, err
	}
	block, err := client.Block(pending.ConfirmedRound).Do(ctx)
	if err != nil {
		return observation{}, fmt.Errorf("algod block observation failed: %w", err)
	}
	transactionProof, err := client.GetTransactionProof(pending.ConfirmedRound, request.TransactionID).Hashtype("sha256").Do(ctx)
	if err != nil {
		return observation{}, fmt.Errorf("algod transaction-proof observation failed: %w", err)
	}
	if transactionProof.Idx >= uint64(len(block.Payset)) {
		return observation{}, fmt.Errorf("algod transaction index is outside the observed payset")
	}
	headerBytes := msgpack.Encode(block.BlockHeader)
	headerHash := proof.HeaderHash(headerBytes)
	genesis := base64.StdEncoding.EncodeToString(block.GenesisHash[:])
	if block.Round == 0 || block.TimeStamp <= 0 || block.GenesisID == "" || genesis == "" || block.CurrentProtocol == "" {
		return observation{}, fmt.Errorf("algod block identity is incomplete")
	}
	return observation{
		Profile: proof.FastProfile, Network: block.GenesisID, Genesis: genesis,
		Consensus: string(block.CurrentProtocol), TransactionID: request.TransactionID,
		ConfirmedRound: pending.ConfirmedRound, BlockHeaderHash: headerHash[:],
		SourceClaimedTime: time.Unix(block.TimeStamp, 0).UTC().Format(time.RFC3339Nano),
		PoolError:         pending.PoolError, Error: "", Expired: false,
		Transaction: msgpack.Encode(signed.Txn), SignedTxnInBlock: msgpack.Encode(block.Payset[transactionProof.Idx]),
		FullHeader: headerBytes, TransactionProof: models.TransactionProof(transactionProof),
	}, nil
}

func run(input io.Reader, output io.Writer, base http.RoundTripper) error {
	encoded, err := io.ReadAll(io.LimitReader(input, requestLimit+1))
	if err != nil || len(encoded) > requestLimit {
		return fmt.Errorf("observer request exceeded the byte limit")
	}
	var request observerRequest
	if err = proof.DecodeJSON(encoded, &request); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), observationBudget)
	defer cancel()
	result, err := observe(ctx, request, base)
	if err != nil {
		return err
	}
	_, err = output.Write(append(proof.Encode(result), '\n'))
	return err
}

func main() {
	if err := run(os.Stdin, os.Stdout, productionTransport()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
