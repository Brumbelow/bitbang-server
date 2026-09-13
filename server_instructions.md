# Server-side setup (Go signaling)

How to wire a freshly-uploaded Go signaling binary up to a public TLS hostname behind nginx. Covers both deploy targets — `production` (`bitba.ng`) and `test` (`test.bitba.ng`) — which differ only in paths, ports, and unit names.

The `upload_production` / `upload_test` scripts push the binary and restart the service. **This doc covers the one-time host setup they don't touch**: DNS, the directory, the systemd user unit, nginx, and TLS.

## The two targets

Everything below is parameterized by which target you're setting up:

| | production | test |
|---|---|---|
| Hostname | `bitba.ng` | `test.bitba.ng` |
| Directory | `/opt/bitbang` | `/opt/bitbang-test` |
| Port | `8081` | `8082` |
| systemd unit | `signaling.service` | `signaling-test.service` |
| Deploy script | `deploy/upload_production` | `deploy/upload_test` |
| Local config | `deploy/production.{deploy,env}` | `deploy/test.{deploy,env}` |

Ports come from `BITBANG_SERVER_PORT` in the respective `.env` — if you change it there, change the nginx `proxy_pass` to match.

## Prerequisites

- A Linux host with systemd and nginx
- Ports 80/443 open; the signaling port (8081/8082) must **not** be publicly reachable — only nginx talks to it
- `certbot` or another ACME client
- SSH access as the deploy user, with write access to the target directory

You do **not** need Go on the server — the binary is cross-compiled locally and shipped as a static ELF. You do **not** need root for the service itself; it runs as a systemd *user* unit.

## 1. DNS

Point the hostname at the server:

```
test.bitba.ng.    A    <server-public-ip>
```

Verify with `dig test.bitba.ng +short` before requesting a certificate.

## 2. Directory

```bash
sudo mkdir -p /opt/bitbang-test
sudo chown -R $USER:$USER /opt/bitbang-test
```

The deploy user needs write access — the upload script `scp`s a tarball here and extracts in place.

## 3. systemd user unit

**These are user units, not system units.** The upload scripts run `systemctl --user restart`, so nothing here needs root, and `sudo systemctl` will not find the service.

The upload script ships `signaling-test.service` into `/opt/bitbang-test/` but does **not** install it — systemd only reads units from `~/.config/systemd/user/`. Link it once:

```bash
mkdir -p ~/.config/systemd/user
ln -sf /opt/bitbang-test/signaling-test.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now signaling-test.service
```

A symlink means later deploys — which overwrite the file in `/opt` — take effect on the next restart without re-linking.

**Enable lingering, or the server dies when you log out:**

```bash
sudo loginctl enable-linger $USER
```

Without this, the systemd user manager stops when your last session ends, taking the service with it, and it will not come back after a reboot. This is the single most common way a user-unit deployment silently fails.

## 4. nginx vhost

`/etc/nginx/sites-available/test.bitba.ng`:

```nginx
# Required once in the http {} context (likely already present from the
# main bitba.ng setup). If not, add it to /etc/nginx/nginx.conf or
# /etc/nginx/conf.d/websocket-map.conf:
#
#   map $http_upgrade $connection_upgrade {
#       default upgrade;
#       ''      close;
#   }

server {
    listen 80;
    listen [::]:80;
    server_name test.bitba.ng;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name test.bitba.ng;

    # certbot fills these in — see section 5.
    ssl_certificate     /etc/letsencrypt/live/test.bitba.ng/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/test.bitba.ng/privkey.pem;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    client_max_body_size 2m;

    location / {
        proxy_pass         http://127.0.0.1:8082;   # test; production is 8081
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade for /ws/device, /ws/client, /ws/pair.
        # Without these two headers, signaling fails outright.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Long-lived signaling sockets. The 60s default would kill idle
        # WebSockets between messages.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        proxy_buffering off;
    }
}
```

Note there is deliberately **no `X-Forwarded-For`** header here. The server reads `X-Real-IP` only (see `handler.clientIP`), and setting `TRUST_PROXY_HEADERS=true` while also passing a client-controllable `X-Forwarded-For` invites spoofed client IPs. `X-Real-IP` is set from `$remote_addr`, which nginx derives from the TCP peer and a client cannot forge.

Enable:

```bash
sudo ln -s /etc/nginx/sites-available/test.bitba.ng /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

If `nginx -t` reports `$connection_upgrade` unknown, the `map` block is missing from the `http {}` context.

## 5. TLS certificate

```bash
sudo certbot --nginx -d test.bitba.ng
```

Certbot detects the vhost, issues the cert, and rewrites the port-80 block for the ACME challenge. Renewal is automatic if your certbot timer is enabled.

## 6. Deploy

From your dev machine, one-time:

```bash
cd ~/bitbang-server/bitbang-server/deploy
cp test.deploy.example test.deploy   # SERVER_SSH, SERVER_SSH_KEY, SERVER_SSH_DIR
cp test.env.example    test.env      # runtime env, including COTURN_SECRET
```

Both concrete files are gitignored; only the `.example` templates are tracked.

Then, every deploy:

```bash
cd ~/bitbang-server/bitbang-server
./deploy/upload_test          # or ./deploy/upload_production
```

What it actually does:

1. Cross-compiles `signaling-go` (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`). Production also builds `bitbang-metrics-dump`.
2. Tars the binary, `test.env`, `test.front.html`, the unit file, and `web/`.
3. `scp`s to `$SERVER_SSH_DIR` and extracts.
4. Copies `deploy/test.env` → `.env` and `deploy/test.front.html` → `front.html`.
5. `systemctl --user restart signaling-test.service`, then prints `systemctl --user status`.
6. Curls `/status` on the remote's localhost port and prints it. This
   works without a token: `STATUS_TOKEN` exempts loopback, so a caller
   that already has a shell on the host is not asked for one.

It does **not** run `daemon-reload` — if you edited the unit file itself, run `systemctl --user daemon-reload` on the host afterward.

## 7. Verify

`/status` reports live device counts and connection totals, so it is
gated by `STATUS_TOKEN` (set in `deploy/test.env`). From anywhere but
loopback it needs the bearer token, and returns 404 without it -- a
prober learns nothing about whether the endpoint exists.

```bash
deploy/status              # test
deploy/status production
```

It reads `STATUS_TOKEN` from `deploy/<env>.env` and sends it, or omits
the header when the value is empty.

Leaving `STATUS_TOKEN` empty keeps `/status` public, which is how it
behaved before the setting existed.

```json
{"version":"0.1.0","protocol":3,"min_protocol":3,"devices":0,"clients":0,"active_codes":0,
 "connection_requests_total":0,"connections_direct_total":0,"connections_relay_total":0,
 "connections_tcp_relay_total":0,"connections_failed_total":0}
```

Then point a real device at it:

```bash
bitbang serve shell --server test.bitba.ng
```

The printed URL looks like `https://test.bitba.ng/<UID>#<code>` — the fragment is the access code and never reaches the server. Opening it should load the BitBang bootstrap page and connect. `/status` should now show `"devices":1` (with the token header above, or
from the host over loopback).

## Troubleshooting

**`502 Bad Gateway`** — service down, or listening on a different port than nginx proxies to.
```bash
systemctl --user status signaling-test.service
journalctl --user -u signaling-test.service -n 50
ss -tlnp | grep 8082
```

**Service vanished after logout, or didn't survive reboot** — lingering isn't enabled (`sudo loginctl enable-linger $USER`).

**`sudo systemctl status signaling-test` says "not found"** — expected. It's a user unit: drop the `sudo`, add `--user`.

**WebSocket fails immediately (400 / 426)** — missing `Upgrade`/`Connection` headers, or the `map` block isn't in the `http {}` context.

**WebSocket drops after ~60s idle** — `proxy_read_timeout` left at nginx's default.

**Service starts then exits immediately** — check `journalctl --user -u signaling-test.service -n 50`. Common causes:
- `.env` missing or unreadable at `EnvironmentFile=`
- `STATIC_DIR` points somewhere that doesn't exist — it should be `/opt/bitbang-test/web`
- `METRICS_PATH` in an unwritable directory. This is a deliberate hard failure: the server refuses to boot rather than silently discard metrics.
- Port already in use — `ss -tlnp | grep 8082`

**Client IPs all show as `127.0.0.1`** — `TRUST_PROXY_HEADERS` isn't `true` in `.env`, or nginx isn't setting `X-Real-IP`.

**TURN credentials rejected** — `COTURN_SECRET` must match `static-auth-secret` in `turnserver.conf` exactly. Confirm the startup log reads `TURN: using coturn host=…` rather than `no TURN server configured`.

## What the upload scripts do NOT do

- Touch nginx config or reload nginx
- Provision or renew TLS certificates
- Open firewall ports
- Create the target directory (section 2)
- Install or link the systemd unit (section 3)
- Run `systemctl --user daemon-reload`
- Enable lingering

Rolling back means redeploying from an earlier commit; there's no versioned artifact store on the host.
