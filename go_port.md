# Port bitbang signaling server (Python → Go), with rate-limiting & scale readiness

## Context
`~/bitbang-server/bitbang-server/signaling/signaling.py` (595 lines, Quart + Hypercorn) is the production signaling server for `bitba.ng`. BitBang is publicly accessible but not yet announced, so this is the lowest-risk window to swap the runtime — once announced, every wire-format quirk becomes a backward-compatibility constraint. The Go signaling client (in `~/bitbangproxy/internal/`) is mature, so the port has a strong reference implementation.

The v1 architecture must be **friendly to three future asks**:
1. Per-IP / per-UID rate limiting and abuse protection
2. Horizontal scale across multiple signaling servers
3. Multi-host / load-shared TURN

The current Python server has **no rate limiting at all** (confirmed in inventory). It has a 3-second delay on "device not found" as a weak UID-enumeration mitigation, and a TURN-capacity gate (`TURN_MAX_ACTIVE`). That's it.

## Repo strategy — sibling subdirectory, same repo

The Go server lives at `~/bitbang-server/bitbang-server/signaling-go/`, sibling to the existing `signaling/`. **Not a branch, not a separate repo.** Reasoning:
- Migration week needs both servers running **on the same host simultaneously** — one working tree, one deploy artifact, one set of env/credentials.
- Static assets (`sw.js`, `bootstrap.js`, `bootstrap.html`, etc.) are served by both servers — shared repo means one source of truth.
- Cutover is trivial: stop deploying `signaling/`, point upload scripts at `signaling-go/`, eventually delete the Python directory.
- A branch would give side-by-side *source*, not *runtime* — wrong shape for this problem.
- A separate repo would duplicate static assets and add a fourth BitBang repo to maintain. Only worth it if `bitbang-server-go` later becomes public while `signaling.py` stays private; if that becomes a priority, `git subtree split` extracts cleanly later.

## v1 scope — parity port

Hit **functional parity** with `signaling.py`. No rate limiting, no multi-server in v1; just architect so adding them later doesn't require a rewrite.

**Code sharing:** Copy `~/bitbangproxy/internal/protocol/swsp.go` (~126 lines) and the reusable parts of `~/bitbangproxy/internal/identity/identity.go` (~151 lines) into the new module. The Go server will need NEW signature-verification code (current Go client only signs, not verifies), and must support **three key algorithms** (RSA ≥2048, ECDSA P-256, Ed25519) — the Go client currently only handles RSA.

### Endpoints (all behaviors per inventory)
| Path | Method | Notes |
|---|---|---|
| `/status` | GET | Returns version, protocol, device/client counts, TURN capacity |
| `/favicon.ico` | GET | Serve static PNG |
| `/__bitbang__/<file>` | GET | sw.js, bootstrap.js, ws-shim.js, xhr-shim.js — `Cache-Control: no-cache`; sw.js gets `Service-Worker-Allowed: /` |
| `/<uid>` and `/<uid>/<sub>` | GET | bootstrap.html with UID routing |
| `/ws/device/<uid>` | WS | Device registration + relay |
| `/ws/client/<uid>` | WS | Client connect + relay |

### Critical implementation-defined behaviors to preserve
- **UID format:** `^[a-f0-9]{32}$` (first 32 hex chars of SHA256(public_key_DER))
- **Challenge nonce:** always exactly 32 random bytes
- **Domain separation:** sign/verify input is `b"bitbang-auth-v1:" || nonce` — never the raw nonce
- **Signature schemes by key type:** RSA → RSASSA-PKCS1v15+SHA256; ECDSA P-256 → ECDSA+SHA256; Ed25519 → Ed25519 (no separate hash)
- **3-second sleep on "Device not found"** — keep as-is to slow UID enumeration
- **Preemption:** new device registration with existing UID closes old device WS (close code 1000, `error: "preempted"`) and boots all attached client WSs (`error: "device_preempted"`)
- **TURN cred caching:** generate once at client `request` time, reuse when forwarding `offer` to device — username = expiry epoch, password = base64(HMAC-SHA1(secret, username))
- **TURN capacity gate:** if `TURN_MAX_ACTIVE > 0` and at capacity, hand client STUN-only + `turn_unavailable: true` flag
- **Error format:** `{type: "error", message: "<string>"}` on the WS, never close mid-handshake without an error frame first
- **WS pings:** ping interval 60s, keep-alive timeout 300s
- **Graceful shutdown:** SIGINT/SIGTERM → 2s grace then hard exit

### Config (env vars, same names as Python)
`PORT`, `COTURN_HOST`, `COTURN_SECRET`, `COTURN_TTL` (default 86400), `TURN_MAX_ACTIVE` (default 0 = disabled), `LOG_LEVEL` (default INFO).

## Architectural decisions for v1 that pre-load future work

Three internal abstractions exist from day one so the future changes are additive, not rewrites. **No interfaces that aren't actually used in v1** — just the seams.

### 1. `DeviceRegistry` — supports future signaling load-sharing
Single Go interface for "where do devices live":
```go
type DeviceRegistry interface {
    Add(uid string, conn *DeviceConn) (preempted *DeviceConn)
    Remove(uid string, conn *DeviceConn)
    Get(uid string) (*DeviceConn, bool)
}
```
v1: in-memory `sync.Map`. Future: Redis-backed for multi-server. The relay code path never touches the raw map — only the interface. **This is the single most important seam.**

### 2. `TURNProvider` — supports future TURN load-sharing
```go
type TURNProvider interface {
    CredentialsFor(clientID, clientIP string) ([]ICEServer, bool /*at_capacity*/)
}
```
v1: single-host coturn REST + in-memory capacity counter. Future: multi-host with geo or round-robin, Redis-backed counter.

### 3. `RateLimiter` — supports future hardening
```go
type RateLimiter interface {
    Allow(key string) bool  // key = IP, UID, or whatever
}
```
v1: **no-op implementation** (`return true`). The handler code calls `limiter.Allow(ip)` at the right spots (new WS connection, registration attempt, per-message). Future v1.1: swap in `golang.org/x/time/rate` token-bucket-per-IP backed by a `sync.Map`. v2: Redis-backed for multi-server.

## How the three forward asks land

### (1) Hardening / rate limiting (v1.1, ~half-day add)
Once parity is verified, swap the no-op `RateLimiter` for a token-bucket implementation. Suggested limits (tunable):
- New WS connections: 10/min/IP
- Registration attempts (post-WS): 5/min/IP — slows challenge floods
- Per-connection message rate: 100/sec
- Max public-key payload size: 8 KB

Keep the existing 3-sec "device not found" sleep. Add explicit max body sizes on HTTP endpoints. No changes to handler signatures needed because the seams are already there.

### (2) Signaling load sharing (v2, ~1-2 days when needed)
**Recommended approach: consistent-hash routing by UID at the load balancer.** The URL contains the UID (`/ws/device/<uid>` and `/ws/client/<uid>`), so an NLB/HAProxy/Envoy can hash the path and pin both peers (device + client) to the same backend deterministically. No cross-server messaging needed; each server stays stateless w.r.t. the others. The `DeviceRegistry` interface stays in-memory per box.

Fallback if consistent hashing isn't viable: swap `DeviceRegistry` for a Redis pub/sub implementation. Relay-by-UID becomes a pub/sub publish to `device:<uid>` instead of an in-process map lookup. More complex, but the handler code doesn't change.

### (3) TURN load sharing (v2, mostly out-of-band)
TURN servers don't share state with signaling — they're independently scalable. Signaling's job is just to hand out the right URLs. Three options ordered by simplicity:
- **Anycast/LB in front of one TURN cluster** (operational responsibility on TURN side; signaling unchanged)
- **Multiple TURN URLs in the `ice_servers` array** (browser picks fastest; just expand `TURNProvider` to return multiple)
- **Geo-aware selection** based on client IP (add IP→region lookup in `TURNProvider`)

All three are implemented by changing only the `TURNProvider` impl. The relay code is untouched.

## Files to create

```
~/bitbang-server/bitbang-server/signaling-go/
├── go.mod                          module bitbang-server-go (Go 1.24)
├── cmd/signaling/main.go           entry point, config, graceful shutdown
├── internal/wire/
│   ├── frame.go                    (copied from bitbangproxy/internal/protocol/swsp.go)
│   └── messages.go                 JSON message types: Register, Challenge, Offer, ...
├── internal/identity/
│   ├── uid.go                      (adapted from bitbangproxy/internal/identity/identity.go)
│   └── verify.go                   NEW — signature verification for RSA/ECDSA-P256/Ed25519
├── internal/registry/
│   ├── registry.go                 DeviceRegistry interface + in-memory impl
│   └── connection.go               DeviceConn, ClientConn types + per-conn state
├── internal/turn/
│   └── coturn.go                   TURNProvider interface + coturn REST impl
├── internal/ratelimit/
│   └── noop.go                     RateLimiter interface + no-op impl (v1)
├── internal/handler/
│   ├── device_ws.go                /ws/device/<uid> handler (register → challenge → relay)
│   ├── client_ws.go                /ws/client/<uid> handler (request → relay)
│   ├── static.go                   /favicon.ico, /__bitbang__/<file>, /<uid>[/<sub>]
│   └── status.go                   /status
└── parity_test.go                  Cross-implementation test harness (see Verification)
```

Static assets (`sw.js`, `bootstrap.js`, `ws-shim.js`, `xhr-shim.js`, `bootstrap.html`, `favicon.png`) — symlink or copy from `~/bitbang-server/bitbang-server/signaling/`. Do NOT duplicate the source; the Python server is canonical for these until the Go server takes over.

## Time estimate (honest)
**~10-12 hours of focused work** end-to-end:
- Module scaffold + go.mod + main.go skeleton: 30 min
- Wire format (copy + tests pass): 30 min
- Identity verify (RSA + ECDSA + Ed25519 + tests): 2 hours
- Device WS handler (register → challenge → relay loop): 2 hours
- Client WS handler + message routing through registry: 1.5 hours
- TURN provider (coturn REST + capacity gate): 1 hour
- Static asset handlers + status endpoint: 1 hour
- Graceful shutdown, signal handlers, logging, env config: 1 hour
- Parity test harness (Python and Go server side-by-side, run loadtest.py against both, diff): 2-3 hours

Plan one week of testing after this. That's the right size — the parity test harness catches the gross stuff, but real bugs surface only when actual clients (OctoPrint plugin in dev, bitbangproxy across NATs, etc.) connect.

## Verification

1. **Unit tests** — copy `~/bitbangproxy/internal/protocol/swsp_test.go` and adapt. Add new tests for signature verification per key type.
2. **Parity test (cross-implementation)** — modify `~/bitbang-server/bitbang-server/signaling/loadtest.py` to take a `--server-url` flag, then run against both servers in turn and compare:
   - Registration timing distribution (should be similar; Go faster)
   - Error messages (must be byte-identical strings — listed in inventory under "Error Codes")
   - End-to-end request → offer latency
   - Preemption behavior with a deliberate duplicate-UID test
3. **Real-client smoke test** — point the OctoPrint plugin and a `bitbangproxy` instance at the Go server (override `--server` flag), exercise the full HTTP/video/PIN flow.
4. **TLS sanity** — confirm the Go server can sit behind the same `bitba.ng` Let's Encrypt cert (cert termination happens at the front-end LB / reverse proxy, not the signaling app itself — so no Go-side change).
5. **Failure modes** — kill bitba.ng coturn while Go server runs (TURN endpoint times out) — clients should gracefully fall back to STUN-only with `turn_unavailable: true`.

## Future features (post-v1, designed-for via the `Store` seam)

### Persistent device + network storage
The Python server treats device registrations as ephemeral — lost on restart. v1 preserves this for parity. v1.5+ adds a persistent layer:

**`devices` table** (per-UID records):
- `uid` (PK, 32 hex chars)
- `public_key_b64`, `key_type` (`rsa` | `ecdsa` | `ed25519`)
- `created_at`, `last_seen_at`, `last_ip`
- `metadata` (JSON — friendly name, owner, tags)
- `revoked_at` (nullable; non-null blocks future registration)

**Network UIDs** — grouping devices into networks (teams, families, fleets):
- `networks(network_uid, name, created_at, owner_device_uid?, ...)`
- `network_members(network_uid, device_uid, role, joined_at)` — many-to-many

Once stored, queries like "list devices in network X" or "list networks for device Y" are one indexed join each.

### Architecture seam
A new `Store` interface lives alongside the existing `DeviceRegistry`:
```go
type Store interface {
    PutDevice(ctx context.Context, d Device) error
    GetDevice(ctx context.Context, uid string) (Device, error)
    ListNetworkMembers(ctx context.Context, networkUID string) ([]string, error)
    // ...
}
```
`DeviceRegistry` stays in-memory (live connections); `Store` is durable. The register handler writes through to both: registry on connect, store on first-register and periodically for `last_seen`. Revocation check happens against `Store` at register time, before the challenge is issued.

### Tech choice by stage
- **v1.5 (single-node):** `modernc.org/sqlite` (pure Go, embedded, zero ops). Migrations via `goose`. Type-safe queries via `sqlc`.
- **v2 (multi-node):** swap to `pgx` + Postgres. Same `sqlc`-generated code (sqlc supports both dialects). No handler-code change beyond the connection string.

### Open questions to settle when this work starts
- Network ops auth: who can create or join a network? PIN-or-signature flow, probably.
- Revocation propagation latency: single-node SQLite = instant; multi-node Postgres = eventual.
- Whether to persist per-client TURN credential cache (probably not — short-lived, cheap to regenerate).

## Out of scope for v1
- Actual rate limiting (designed for, no-op'd in v1)
- Multi-server load sharing (designed for, single-server in v1)
- Multi-host TURN (designed for, single coturn in v1)
- Metrics / Prometheus endpoint (could add `/status` extensions later)
- Hot-reload of static assets (restart-only is fine)
- Identity revocation lists
