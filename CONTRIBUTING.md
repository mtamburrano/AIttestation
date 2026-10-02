# Contributing to Attestamp

Start with the [architecture](docs/ARCHITECTURE.md), [support matrix](docs/SUPPORT.md)
and [license policy](LICENSE.md). The repository is being prepared for publication;
it is not a signed public release. No provider account, signing credential, payment
or retained application state is needed for ordinary development.

## First checkout

Use Git and Node 22.13 or later on macOS. There are no npm dependencies to install.
The TOML parser is vendored with pinned hashes and its original license.

```sh
npm run bootstrap
npm run bootstrap:clean
```

`bootstrap` checks repository hygiene, generated browser files and a small core,
discovery and dashboard test set. `bootstrap:clean` exports the committed revision
to a fresh temporary checkout and runs the same checks with a fresh HOME. It tests
HEAD, so commit local edits before using it to validate a proposed change. Both
commands strip inherited app, proxy and credential settings, make no downloads
and remove only their own temporary directories. A missing prerequisite fails
with a named check. Linux/Windows product support is not implied by Node portability.

## Changes and tests

The [CI lanes and reports](docs/CI.md) have matching local commands and need no secrets.
Run the smallest relevant tests first, for example:

```sh
node --test test/coding-discovery.test.mjs test/coding-dashboard.test.mjs
npm run test:mac-integrations
npm run test:coding-acceptance
```

The last command adds the bundled native hook fixture and requires the macOS
Command Line Tools. See [coding acceptance](spikes/coding/SETUP.md). Unit/integration
tests use disposable directories, memory keys and synthetic inputs. Some need
local Unix sockets or loopback HTTP; restricted sandboxes must allow those.
Use `npm test` for a consolidated deterministic regression run, not after every edit.
Some native verifier tests need prebuilt Go helpers; see [development](docs/DEVELOPMENT.md).

For browser source changes, edit shared files in `spikes/browser/shared/extension/`
and regenerate with `npm run build:browsers`; test the changed boundary with
synthetic fixtures. Never use an ordinary browser profile or live provider as a
fallback for a deterministic test. Signing, installed vendor hooks and provider
checks are separate maintainer checkpoints.

Keep changes focused. Preserve ON/OFF consent, exact historical evidence bytes,
protocol identities, least-authority authentication and free offline export.
Describe the trigger, resulting behavior, tests and remaining limits in a change
request. Include a regression case for behavior or security changes. Do not include
real prompts, config files, account identifiers, screenshots of private sessions,
secrets, key material or generated local reports.

Report ordinary bugs using the issue template with a synthetic reproduction.
Use [SECURITY.md](SECURITY.md) for vulnerabilities and privacy reports. Contributions
must identify any third-party material and its license; the publication license
scope and ownership review must be completed before accepting public contributions.
