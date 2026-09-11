package main

import (
	"fmt"
	"io"
	"os"

	"provenance.local/algorand/proof"
)

func main() {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, proof.MaxArchive+1))
	var request proof.FastRequest
	if err == nil {
		err = proof.DecodeJSON(input, &request)
	}
	if err != nil {
		fmt.Println(string(proof.Encode(proof.FastReport{
			Profile: proof.FastProfile, Anchor: "INVALID", Timestamp: "INDETERMINATE", Assurance: "NONE", Reason: err.Error(),
		})))
		os.Exit(1)
	}
	report := proof.VerifyFast(request)
	fmt.Println(string(proof.Encode(report)))
	if !report.Authorized {
		os.Exit(1)
	}
}
