package proof

import (
	"bytes"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"github.com/algorand/go-algorand-sdk/v2/types"
	"strings"
	"testing"
)

func TestHostileDecoders(t *testing.T) {
	for _, s := range []string{`{"x":1,"x":2}`, `{"x":1} {"x":2}`, strings.Repeat("[", 34) + "0" + strings.Repeat("]", 34), `{"unknown":1}`} {
		var req Request
		if DecodeJSON([]byte(s), &req) == nil {
			t.Fatalf("accepted hostile JSON %q", s)
		}
	}
	for _, b := range [][]byte{{0xdd, 0xff, 0xff, 0xff, 0xff}, {0xc6, 0xff, 0xff, 0xff, 0xff}, {0x81, 0xa1, 'x', 0x01}, bytes.Repeat([]byte{0x91}, 34), {0x80, 0x80}} {
		var h types.BlockHeader
		if DecodeMessagePack(b, &h) == nil {
			t.Fatalf("accepted hostile msgpack %x", b)
		}
	}
	h := types.BlockHeader{Round: 1}
	b := msgpack.Encode(h)
	var out types.BlockHeader
	if e := DecodeMessagePack(b, &out); e != nil {
		t.Fatal(e)
	}
}

func TestNoMalformedRequestVerifies(t *testing.T) {
	for _, req := range []Request{{}, {Archive: Archive{Format: "algorand-archive/1", Network: Network, Genesis: Genesis, Consensus: Consensus}, ExpectedPayload: append([]byte{'P', 'A', 'P', 1}, make([]byte, 32)...)}} {
		if Verify(req).IndependentlyVerified {
			t.Fatal("incomplete request verified")
		}
	}
}
