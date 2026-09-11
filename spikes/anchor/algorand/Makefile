.PHONY: build test
build:
	go build -o bin/verify ./cmd/verify
	go build -o bin/fast-verify ./cmd/fastverify
	go build -o bin/fast-observe ./cmd/fastobserve
	go build -o bin/live ./cmd/live
	go build -o bin/sponsor ./cmd/sponsor
test:
	go test ./...
