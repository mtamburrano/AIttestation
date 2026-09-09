package main

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestLiveEndpointGuard(t *testing.T) {
	transport := boundedTransport{}
	for _, url := range []string{"https://mainnet-api.algonode.cloud/v2/status", "http://testnet-api.algonode.cloud/v2/status", "https://testnet-api.algonode.cloud.evil.example/v2/status", "https://testnet-api.algonode.cloud/v2/mainnet"} {
		req, _ := http.NewRequest("GET", url, nil)
		if _, e := transport.RoundTrip(req); e == nil {
			t.Fatal("network guard failed")
		}
	}
	req, _ := http.NewRequest("DELETE", endpoint+"/v2/accounts/test", nil)
	if _, e := transport.RoundTrip(req); e == nil {
		t.Fatal("write guard failed")
	}
}

func TestSigningDirectoryOutsideRepository(t *testing.T) {
	root := t.TempDir()
	resolved, e := filepath.EvalSymlinks(root)
	if e != nil {
		t.Fatal(e)
	}
	if e = outsideRepository(resolved); e != nil {
		t.Fatal(e)
	}
	if e = os.Mkdir(filepath.Join(root, ".git"), 0700); e != nil {
		t.Fatal(e)
	}
	if outsideRepository(resolved) == nil {
		t.Fatal("repository accepted for signing material")
	}
}
