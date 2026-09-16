# Resume — context for the next Claude session

Last touched: **2026-05-12**.

## State of play

Two parallel work streams, both paused at clean hand-off points:

### 1. Go signaling-server port (HOT — pre-announcement deploy window)
- v1 parity port complete at `bitbang-server/signaling-go/` (~1380 LOC, builds clean, vet clean, identity tests pass)
- Locally smoke-tested: all 3 key types (RSA / ECDSA P-256 / Ed25519) register cleanly, full client→device relay works, 3-sec UID-enum delay works, device preemption + client booting works
- `upload_test` rewritten to deploy Go binary to `test.bitba.ng` (`/opt/bitbang-test/`, port 8081, replaces `signaling-test.service` in place)
- Production deploy (`upload_production`) is **unchanged** — still ships Python. Rollout is conservative: test first, validate ~1 week, then cut over

### 2. OctoPrint-BitBang plugin distribution (in `~/Octoprint-BitBang`)
- Plugin code at v0.1.1, full metadata, softwareupdate hook, README dual-install + privacy section
- Fresh wheel + sdist in `~/Octoprint-BitBang/dist/`
- Submission draft at `~/Octoprint-BitBang/octoprint-plugin-submission.md`
- Paused — user wants to do the PyPI upload manually; PR to `OctoPrint/plugins.octoprint.org` not yet filed

## Where the canonical info lives

| For | Read |
|---|---|
| Go port design (architecture, seams, future features) | `~/bitbang-server/go_port.md` |
| Server-side setup (nginx, TLS, systemd) | `~/bitbang-server/server_instructions.md` |
| OctoPrint plugin submission (Jekyll YAML to PR) | `~/Octoprint-BitBang/octoprint-plugin-submission.md` |
| Plan working artifact (overlaps with go_port.md) | `~/.claude/plans/what-version-of-go-golden-pancake.md` |

## User context

Rich LeGrand, solo maintainer. Working in spare time. Not a Go programmer self-identified, but has shipped Go via AI collaboration. Conservative deploy discipline (test-first, validate-then-promote). Prefers:
- **Honest takes** over optimistic agreement (don't oversell speed/ease)
- **Honest phrasing critique** when asking "is this phrased well?"
- **Interface-based seams** for future-feature designed-for work (not feature flags, not full v1 impls)
- **Tight responses** — no preambles, no recap at end

## Most likely next steps

If user resumes here:

1. **Deploy to test.bitba.ng** — follow `server_instructions.md` for one-time nginx + TLS setup, then run `./upload_test` from `~/bitbang-server/bitbang-server/`. Should land Go on the existing test infra.
2. **Validate** — point real clients (OctoPrint plugin in dev, a local `bitbangproxy`) at `test.bitba.ng`. Watch logs (`journalctl -u signaling-test.service -f`). Check `/status` periodically.
3. **Parity test (optional but valuable)** — modify `~/bitbang-server/bitbang-server/signaling/loadtest.py` to take a `--ws-scheme` flag, run against both Python (8081 prod) and Go (test.bitba.ng), diff timings + error strings.
4. **After ~1 week of clean operation:** rewrite `upload_production` analogously to `upload_test` to deploy Go to prod. Keep Python on disk for rollback.

## Future features designed-for but not implemented in v1

(All are interface seams in the Go server — adding them is additive, not a rewrite.)

- **Rate limiting** (`internal/ratelimit/`) — currently `NoOp{}`. v1.1: swap in token-bucket-per-IP via `golang.org/x/time/rate`.
- **Multi-server signaling** (`internal/registry/`) — currently in-memory. v2: consistent-hash by UID at the load balancer keeps both peers on the same backend → registry stays in-memory per box.
- **Multi-host TURN** (`internal/turn/`) — currently single coturn. v2: multiple TURN URLs in `ice_servers`, or geo-aware selection.
- **Persistent storage + network UIDs** (no code yet) — `Store` interface alongside `DeviceRegistry`. v1.5: `modernc.org/sqlite` (pure Go, embedded). v2: `pgx` + Postgres for multi-node. Schema sketch in `go_port.md`.

## Recent loose ends to be aware of

- **`bitbang-python` TLS verification fix** — committed (no, just edited, not committed) at `~/bitbang-python/bitbang/adapter.py`. The two lines that disabled cert verification on `wss://bitba.ng` were removed; verified the live cert works with default `ssl.create_default_context()`. **User has not committed this** — bring it up if relevant.
- **`upload_test_go` was deleted** — the Go deploy is folded into the standard `upload_test` script. The `upload` top-level script (which runs `upload_production && upload_test`) now mixes Python-to-prod with Go-to-test, which is intentional but worth noting.

## To resume cleanly

Best first move: skim `~/bitbang-server/go_port.md` (5 min read) for full context, then ask the user what they want to focus on. Don't assume which thread they're on.
