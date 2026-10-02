# Local development

Start with `npm run bootstrap` and [CONTRIBUTING.md](../CONTRIBUTING.md). Node 22.13+
provides built-in SQLite. There are no runtime npm packages to fetch. Browser assets
are generated deterministically from the shared source with `npm run build:browsers`.

Go proof tools use pinned `go.mod`/`go.sum` inputs under `spikes/anchor/algorand/`.
Their [build guide](../spikes/anchor/algorand/README.md) describes the local compiler,
CGO and module-cache prerequisites. `npm run test:algorand` includes offline proof
validation; a first dependency download is an explicit developer setup action.
Use a dedicated test cache and `GOPROXY=off` for an offline rehearsal. Do not point
tests at owner caches, ledgers, keys or services. Full source tests can require these
prebuilt tools; the bootstrap smoke does not.

Unsigned/ad-hoc app builds require macOS Command Line Tools and the documented
local build inputs. Use a fresh output path with `npm run build:chatgpt -- NEW_PATH`;
consult the [browser build guide](../spikes/browser/chatgpt/README.md) for prerequisites.
This does not establish signed distribution or permission to launch against a
personal profile. Native fixtures in `npm run test:coding-acceptance` automate a
fresh synthetic app without Developer ID or Keychain credentials.

[Private development](../spikes/development/README.md) and
[distribution](../spikes/distribution/README.md) are maintainer references for
separately authorized installed/signing checks. They are outside contributor
bootstrap. Do not run live provider, sponsor, chain, signing-service or publication
commands merely to make an offline test pass.
