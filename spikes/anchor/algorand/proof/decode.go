package proof

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"github.com/algorand/go-algorand-sdk/v2/encoding/msgpack"
	"io"
)

// Bound structure before typed decoders can allocate from hostile lengths.
func scanMessagePack(b []byte) error {
	if len(b) > 2<<20 {
		return fmt.Errorf("LIMIT_EXCEEDED: msgpack bytes")
	}
	p := 0
	nodes := 0
	var walk func(int) error
	walk = func(depth int) error {
		nodes++
		if depth > 32 || nodes > 100000 || p >= len(b) {
			return fmt.Errorf("INVALID: msgpack bounds")
		}
		c := b[p]
		p++
		var count uint64
		container := false
		scalar := false
		width := 0
		switch {
		case c <= 0x7f || c >= 0xe0 || c == 0xc0 || c == 0xc2 || c == 0xc3:
			return nil
		case c >= 0xa0 && c <= 0xbf:
			count = uint64(c & 31)
			scalar = true
		case c >= 0x90 && c <= 0x9f:
			count = uint64(c & 15)
			container = true
		case c >= 0x80 && c <= 0x8f:
			count = uint64(c&15) * 2
			container = true
		default:
			switch c {
			case 0xc4, 0xd9:
				width = 1
				scalar = true
			case 0xc5, 0xda:
				width = 2
				scalar = true
			case 0xc6, 0xdb:
				width = 4
				scalar = true
			case 0xdc, 0xde:
				width = 2
				container = true
			case 0xdd, 0xdf:
				width = 4
				container = true
			case 0xcc, 0xd0:
				count = 1
				scalar = true
			case 0xcd, 0xd1:
				count = 2
				scalar = true
			case 0xce, 0xd2:
				count = 4
				scalar = true
			case 0xcf, 0xd3:
				count = 8
				scalar = true
			default:
				return fmt.Errorf("UNSUPPORTED: msgpack type")
			}
		}
		if width > 0 {
			if p+width > len(b) {
				return io.ErrUnexpectedEOF
			}
			switch width {
			case 1:
				count = uint64(b[p])
			case 2:
				count = uint64(binary.BigEndian.Uint16(b[p:]))
			case 4:
				count = uint64(binary.BigEndian.Uint32(b[p:]))
			}
			p += width
			if c == 0xde || c == 0xdf {
				count *= 2
			}
		}
		if scalar {
			if count > 256<<10 || count > uint64(len(b)-p) {
				return fmt.Errorf("LIMIT_EXCEEDED: msgpack field")
			}
			p += int(count)
		}
		if container {
			if count > 65536 {
				return fmt.Errorf("LIMIT_EXCEEDED: msgpack collection")
			}
			for i := uint64(0); i < count; i++ {
				if err := walk(depth + 1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(0); err != nil {
		return err
	}
	if p != len(b) {
		return fmt.Errorf("INVALID: trailing msgpack")
	}
	return nil
}

func DecodeMessagePack(b []byte, out any) error {
	if err := scanMessagePack(b); err != nil {
		return err
	}
	if err := msgpack.Decode(b, out); err != nil {
		return fmt.Errorf("INVALID: msgpack schema: %w", err)
	}
	if !bytes.Equal(b, msgpack.Encode(out)) {
		return fmt.Errorf("INVALID: noncanonical msgpack")
	}
	return nil
}

func DecodeJSON(b []byte, out any) error {
	if len(b) > MaxArchive {
		return fmt.Errorf("LIMIT_EXCEEDED: archive")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	nodes := 0
	var walk func(int) error
	walk = func(depth int) error {
		nodes++
		if depth > 32 || nodes > 100000 {
			return fmt.Errorf("LIMIT_EXCEEDED: JSON structure")
		}
		t, err := d.Token()
		if err != nil {
			return err
		}
		if s, ok := t.(string); ok && len(s) > 256<<10 {
			return fmt.Errorf("LIMIT_EXCEEDED: JSON field")
		}
		if delim, ok := t.(json.Delim); ok {
			if delim == '{' {
				seen := map[string]bool{}
				for d.More() {
					k, e := d.Token()
					if e != nil {
						return e
					}
					s, ok := k.(string)
					if !ok || seen[s] {
						return fmt.Errorf("INVALID: duplicate JSON name")
					}
					seen[s] = true
					if e = walk(depth + 1); e != nil {
						return e
					}
				}
			} else if delim == '[' {
				for d.More() {
					if e := walk(depth + 1); e != nil {
						return e
					}
				}
			} else {
				return fmt.Errorf("INVALID: JSON delimiter")
			}
			_, err = d.Token()
			return err
		}
		return nil
	}
	if err := walk(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return fmt.Errorf("INVALID: trailing JSON")
	}
	d = json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	return d.Decode(out)
}
