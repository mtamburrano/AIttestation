package main

import (
	"fmt"
	"io"
	"os"
	"provenance.local/algorand/proof"
)

func main() {
	b, e := io.ReadAll(io.LimitReader(os.Stdin, proof.MaxArchive+1))
	var req proof.Request
	if e == nil {
		e = proof.DecodeJSON(b, &req)
	}
	if e != nil {
		fmt.Println(string(proof.Encode(proof.Report{Anchor: "INVALID", Timestamp: "INDETERMINATE", Reason: e.Error()})))
		os.Exit(1)
	}
	r := proof.Verify(req)
	fmt.Println(string(proof.Encode(r)))
	if !r.IndependentlyVerified {
		os.Exit(1)
	}
}
