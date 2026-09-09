package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"github.com/algorand/go-algorand-sdk/v2/client/v2/algod"
	"github.com/algorand/go-algorand-sdk/v2/client/v2/common/models"
	sdkcrypto "github.com/algorand/go-algorand-sdk/v2/crypto"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"github.com/algorand/go-algorand-sdk/v2/transaction"
	"github.com/algorand/go-algorand-sdk/v2/types"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"provenance.local/algorand/proof"
	"strings"
	"time"
)

const endpoint = "https://testnet-api.algonode.cloud"

func outsideRepository(dir string) error {
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	if resolved != dir {
		return fmt.Errorf("dedicated directory cannot use symlink aliases")
	}
	for parent := dir; ; parent = filepath.Dir(parent) {
		if _, err := os.Stat(filepath.Join(parent, ".git")); err == nil {
			return fmt.Errorf("signing material must remain outside repositories")
		}
		if filepath.Dir(parent) == parent {
			break
		}
	}
	return nil
}

type boundedTransport struct{ base *http.Transport }

func (t boundedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" || r.URL.Host != "testnet-api.algonode.cloud" {
		return nil, fmt.Errorf("TestNet-only endpoint guard")
	}
	if r.Method != http.MethodGet && !(r.Method == http.MethodPost && r.URL.Path == "/v2/transactions") {
		return nil, fmt.Errorf("unsupported live operation")
	}
	if strings.Contains(r.URL.Path, "mainnet") {
		return nil, fmt.Errorf("TestNet-only path guard")
	}
	return t.base.RoundTrip(r)
}
func client() *algod.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.ResponseHeaderTimeout = 15 * time.Second
	c, e := algod.MakeClientWithTransport(endpoint, "", nil, boundedTransport{transport})
	must(e)
	return c
}
func must(e error) {
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func read(path string, out any) {
	f, e := os.Open(path)
	must(e)
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, proof.MaxArchive+1))
	must(e)
	must(proof.DecodeJSON(b, out))
}
func save(path string, v any) {
	b := proof.Encode(v)
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	must(e)
	_, e = f.Write(b)
	must(e)
	must(f.Sync())
	must(f.Close())
	d, e := os.Open(filepath.Dir(path))
	must(e)
	must(d.Sync())
	must(d.Close())
}
func message(m models.StateProofMessage) types.Message {
	return types.Message{BlockHeadersCommitment: m.Blockheaderscommitment, VotersCommitment: m.Voterscommitment, LnProvenWeight: m.Lnprovenweight, FirstAttestedRound: m.Firstattestedround, LastAttestedRound: m.Lastattestedround}
}

type Submission struct {
	TransactionID string `json:"transactionId"`
	Transaction   []byte `json:"transaction"`
	Payload       []byte `json:"payload"`
	Started       string `json:"started"`
	SubmittedMs   int64  `json:"submittedMs"`
}
type Confirmation struct {
	Round                 uint64 `json:"round"`
	ConfirmedAt           string `json:"confirmedAt"`
	ConfirmationLatencyMs int64  `json:"confirmationLatencyMs"`
	FeeMicroAlgos         uint64 `json:"feeMicroAlgos"`
}

func main() {
	if len(os.Args) < 3 {
		must(fmt.Errorf("Usage: live checkpoint|submit|collect <dedicated-directory> [expected-account]"))
	}
	action := os.Args[1]
	dir, e := filepath.Abs(os.Args[2])
	must(e)
	info, e := os.Stat(dir)
	must(e)
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		must(fmt.Errorf("dedicated directory must be owner-only"))
	}
	must(outsideRepository(dir))
	c := client()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	params, e := c.SuggestedParams().Do(ctx)
	must(e)
	if params.GenesisID != proof.Network || base64.StdEncoding.EncodeToString(params.GenesisHash) != proof.Genesis || params.ConsensusVersion != proof.Consensus {
		must(fmt.Errorf("UNSUPPORTED: live TestNet network/consensus mismatch"))
	}
	switch action {
	case "checkpoint":
		var source models.StateProof
		read(filepath.Join(dir, "checkpoint-source.json"), &source)
		m := message(source.Message)
		t := proof.Trust{Profile: proof.Profile, Network: proof.Network, Genesis: proof.Genesis, Consensus: proof.Consensus, LastAttestedRound: m.LastAttestedRound, VotersCommitment: m.VotersCommitment, LnProvenWeight: m.LnProvenWeight, Source: fmt.Sprintf("%s/v2/stateproofs/%d (separately selected source-trusted checkpoint)", endpoint, m.LastAttestedRound), SelectedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		save(filepath.Join(dir, "trust.json"), t)
		fmt.Printf("Pinned separate checkpoint ending at round %d\n", t.LastAttestedRound)
	case "submit":
		if len(os.Args) != 4 {
			must(fmt.Errorf("expected dedicated public account required"))
		}
		var trust proof.Trust
		read(filepath.Join(dir, "trust.json"), &trust)
		seedPath := filepath.Join(dir, "account.seed")
		st, e := os.Lstat(seedPath)
		must(e)
		if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 {
			must(fmt.Errorf("seed must be an owner-only regular file"))
		}
		seed, e := os.ReadFile(seedPath)
		must(e)
		if len(seed) != 32 {
			must(fmt.Errorf("seed length"))
		}
		private := ed25519.NewKeyFromSeed(seed)
		clear(seed)
		defer clear(private)
		account, e := sdkcrypto.AccountFromPrivateKey(private)
		must(e)
		if account.Address.String() != os.Args[3] {
			must(fmt.Errorf("dedicated account mismatch"))
		}
		balance, e := c.AccountInformation(account.Address.String()).Do(ctx)
		must(e)
		if balance.Amount < 101000 {
			must(fmt.Errorf("fresh TestNet account not funded"))
		}
		var root struct {
			Payload []byte `json:"payload"`
		}
		read(filepath.Join(dir, "anchor-payload.json"), &root)
		if len(root.Payload) != 36 || !bytes.Equal(root.Payload[:4], []byte{'P', 'A', 'P', 1}) {
			must(fmt.Errorf("anchor payload must be 36 blinded bytes"))
		}
		params.FlatFee = true
		params.Fee = 1000
		params.LastRoundValid = params.FirstRoundValid + 20
		txn, e := transaction.MakePaymentTxn(account.Address.String(), account.Address.String(), 0, root.Payload, "", params)
		must(e)
		txid, signed, e := sdkcrypto.SignTransaction(private, txn)
		must(e)
		start := time.Now()
		sub := Submission{TransactionID: txid, Transaction: msgpack.Encode(txn), Payload: root.Payload, Started: start.UTC().Format(time.RFC3339Nano), SubmittedMs: start.UnixMilli()}
		// Exclusive durable intent prevents accidental duplicate live submissions on rerun.
		save(filepath.Join(dir, "submission.json"), sub)
		sent, e := c.SendRawTransaction(signed).Do(ctx)
		must(e)
		if sent != txid {
			must(fmt.Errorf("RPC returned wrong transaction ID"))
		}
		fmt.Printf("Submitted TestNet self-payment %s; fee 1000 microALGO\n", txid)
		for i := 0; i < 40; i++ {
			p, stxn, err := c.PendingTransactionInformation(txid).Do(ctx)
			if err == nil && p.ConfirmedRound > 0 {
				if !bytes.Equal(msgpack.Encode(stxn.Txn), msgpack.Encode(txn)) {
					must(fmt.Errorf("RPC confirmation exact transaction mismatch"))
				}
				conf := Confirmation{Round: p.ConfirmedRound, ConfirmedAt: time.Now().UTC().Format(time.RFC3339Nano), ConfirmationLatencyMs: time.Since(start).Milliseconds(), FeeMicroAlgos: 1000}
				save(filepath.Join(dir, "confirmation.json"), conf)
				fmt.Printf("RPC_CONFIRMED round %d latency %d ms\n", conf.Round, conf.ConfirmationLatencyMs)
				return
			}
			if err == nil && p.PoolError != "" {
				must(fmt.Errorf("TestNet pool rejected transaction"))
			}
			time.Sleep(500 * time.Millisecond)
		}
		must(fmt.Errorf("confirmation unknown; do not resubmit automatically"))
	case "collect":
		var sub Submission
		var conf Confirmation
		var trust proof.Trust
		read(filepath.Join(dir, "submission.json"), &sub)
		read(filepath.Join(dir, "confirmation.json"), &conf)
		read(filepath.Join(dir, "trust.json"), &trust)
		started := time.Now()
		pollCtx, stop := context.WithTimeout(context.Background(), 35*time.Minute)
		defer stop()
		attempts := 0
		firstAbsent := time.Now().UTC().Format(time.RFC3339Nano)
		intervalEnd := ((conf.Round + proof.Interval - 1) / proof.Interval) * proof.Interval
		// Preserve already published links before waiting: public RPC history may roll off.
		if intervalEnd <= trust.LastAttestedRound || (intervalEnd-trust.LastAttestedRound)/proof.Interval > 32 {
			must(fmt.Errorf("checkpoint outside bounded collection window"))
		}
		for round := trust.LastAttestedRound + proof.Interval; round < intervalEnd; round += proof.Interval {
			cache := filepath.Join(dir, fmt.Sprintf("stateproof-%d.json", round))
			if _, err := os.Stat(cache); err == nil {
				continue
			}
			link, err := c.GetStateProof(round).Do(pollCtx)
			if err != nil {
				break
			}
			save(cache, link)
		}
		for {
			attempts++
			sp, err := c.GetStateProof(intervalEnd).Do(pollCtx)
			if err == nil {
				target := message(sp.Message)
				lp, e := c.GetLightBlockHeaderProof(conf.Round).Do(pollCtx)
				must(e)
				tp, e := c.GetTransactionProof(conf.Round, sub.TransactionID).Hashtype("sha256").Do(pollCtx)
				must(e)
				block, e := c.Block(conf.Round).Do(pollCtx)
				must(e)
				if tp.Idx >= uint64(len(block.Payset)) {
					must(fmt.Errorf("transaction index outside payset"))
				}
				a := proof.Archive{Format: "algorand-archive/1", Network: proof.Network, Genesis: proof.Genesis, Consensus: proof.Consensus, Round: conf.Round, TransactionID: sub.TransactionID, Transaction: sub.Transaction, SignedTxnInBlock: msgpack.Encode(block.Payset[tp.Idx]), FullHeader: msgpack.Encode(block.BlockHeader), LightHeader: msgpack.Encode(proof.Light(block.BlockHeader)), TransactionProof: tp, LightProof: lp}
				for last := trust.LastAttestedRound; last < target.LastAttestedRound; last += proof.Interval {
					cache := filepath.Join(dir, fmt.Sprintf("stateproof-%d.json", last+proof.Interval))
					var link models.StateProof
					if _, err := os.Stat(cache); err == nil {
						read(cache, &link)
					} else {
						link, e = c.GetStateProof(last + proof.Interval).Do(pollCtx)
						must(e)
						save(cache, link)
					}
					m := message(link.Message)
					a.Chain = append(a.Chain, proof.Link{Message: msgpack.Encode(m), StateProof: link.Stateproof})
					if len(a.Chain) > 32 {
						must(fmt.Errorf("checkpoint too old"))
					}
				}
				save(filepath.Join(dir, "archive.json"), a)
				confirmed, e := time.Parse(time.RFC3339Nano, conf.ConfirmedAt)
				must(e)
				save(filepath.Join(dir, "measurements.json"), map[string]any{"source": "DEDICATED_ALGORAND_TEST", "transactionId": sub.TransactionID, "round": conf.Round, "confirmationLatencyMs": conf.ConfirmationLatencyMs, "archivalProofObservedLagMs": time.Since(confirmed).Milliseconds(), "collectorElapsedMs": time.Since(started).Milliseconds(), "pollIntervalMs": 5000, "pollAttempts": attempts, "firstPollAt": firstAbsent, "observedAt": time.Now().UTC().Format(time.RFC3339Nano), "archiveBytes": len(proof.Encode(a)), "stateProofChainLinks": len(a.Chain), "feeMicroAlgos": "1000"})
				fmt.Printf("Archived public proof: round %d, %d bytes, %d State-Proof links\n", conf.Round, len(proof.Encode(a)), len(a.Chain))
				return
			}
			if pollCtx.Err() != nil {
				must(fmt.Errorf("bounded archive wait expired: %w", err))
			}
			if attempts == 1 || attempts%12 == 0 {
				fmt.Printf("PENDING_ARCHIVE round %d; elapsed %s\n", conf.Round, time.Since(started).Round(time.Second))
			}
			time.Sleep(5 * time.Second)
		}
	default:
		must(fmt.Errorf("unsupported live operation"))
	}
}
