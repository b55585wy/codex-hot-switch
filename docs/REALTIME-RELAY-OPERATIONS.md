# Realtime relay operations

This runbook covers the opt-in Phase A cloud relay. It is intentionally
standalone: the cloud only authenticates worker sockets, stores the signed
fleet directory/queue, and (optionally) receives Feishu events. It never runs
Codex, a model provider, a shell task, or a project tool.

The frozen protocol/security contract remains
[REALTIME-RELAY-DESIGN.md](./REALTIME-RELAY-DESIGN.md). Do not change the
endpoint, token location, row format, or activation rules without a new
engineering review.

## What ships

- `dist/relay-server.cjs` — one portable CommonJS bundle for Node 24. It needs
  no `npm install`, build tool, model SDK, or project checkout.
- Durable state in `CODEX_RELAY_DATA_DIR` (`relay-state.json` plus a
  single-writer `relay-state.lock`). State is validated, atomically replaced
  after fsync, and never addressed by user keys as file paths.
- `/relay/v1` WebSocket intake behind `Authorization: Bearer <relay token>`.
  Every durable command commit (including direct gateway writes to
  `server.storage`) pushes a targeted notice to the activated target worker.
- `GET /healthz`, bounded to `{ ok, version, gateway }`.

## Configuration (environment or protected files only)

| Variable | Meaning |
| --- | --- |
| `CODEX_RELAY_APP_ID` | Feishu application id / relay namespace (one per server) |
| `CODEX_RELAY_TOKEN_FILE` | file containing the high-entropy relay token |
| `CODEX_RELAY_APP_SECRET_FILE` | file containing the Feishu app secret (gateway only) |
| `CODEX_RELAY_OWNER_OPEN_ID` | gateway owner/admin open_id |
| `CODEX_RELAY_ADMINS` | optional comma-separated additional admins |
| `CODEX_RELAY_TENANT` | `feishu` (default) or `lark` |
| `CODEX_RELAY_GATEWAY_ENABLED` | `true`/`false`; defaults to enabled only when full credentials exist |
| `CODEX_RELAY_HOST` | bind address, default `127.0.0.1` |
| `CODEX_RELAY_PORT` | default `8787` |
| `CODEX_RELAY_DATA_DIR` | durable state directory |

The relay token is **never** accepted in argv, a URL query, logs, or Git.
It must be at least 32 bytes of high-entropy data; shorter values are rejected
before the listener starts. Keep token/secret files readable only by the
service user (for example mode `0600`) and outside the repository. Secret-file
reads are size-bounded, and unknown CLI arguments are reported without echoing
their value. `--help` and `--storage-only` are the only supported CLI flags;
`--storage-only` forces the Feishu gateway off.

Production defaults are loopback bind plus gateway enabled only when
`CODEX_RELAY_APP_SECRET_FILE`, `CODEX_RELAY_OWNER_OPEN_ID`, and the token file
are all present. An incomplete gateway configuration is a startup error.

## TLS reverse proxy

Plain `ws://` is accepted only on loopback (tests, or an explicitly managed
encrypted SSH tunnel). Public traffic must terminate TLS at a reverse proxy.
Caddy example; replace the host and upstream port, and keep the relay bound to
loopback:

```caddyfile
relay.example.invalid {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy forwards WebSocket upgrades. Preserve the `Authorization` header (Caddy
does by default), do not add token query parameters, and do not enable request
body logging. If the proxy is remote, bind the relay only to the private
interface/firewall allowlist. Never expose `/relay/v1` directly to the public
internet over plain HTTP/WS.

## Least-privilege systemd unit

Run as a dedicated unprivileged user. Only the data directory and credential
files need to be readable; the bundle can live in a read-only directory.

```ini
[Unit]
Description=Feishu Codex relay server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codex-relay
Group=codex-relay
WorkingDirectory=/opt/feishu-codex-relay
ExecStart=/usr/bin/node /opt/feishu-codex-relay/dist/relay-server.cjs
Environment=CODEX_RELAY_APP_ID=cli_xxxxxxxxxxxxxxxx
Environment=CODEX_RELAY_TOKEN_FILE=/etc/feishu-codex-relay/relay-token
Environment=CODEX_RELAY_APP_SECRET_FILE=/etc/feishu-codex-relay/app-secret
Environment=CODEX_RELAY_OWNER_OPEN_ID=ou_xxxxxxxxxxxxxxxx
Environment=CODEX_RELAY_TENANT=feishu
Environment=CODEX_RELAY_HOST=127.0.0.1
Environment=CODEX_RELAY_PORT=8787
Environment=CODEX_RELAY_DATA_DIR=/var/lib/feishu-codex-relay
Environment=CODEX_RELAY_GATEWAY_ENABLED=true
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/feishu-codex-relay
UMask=0077

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` is required so a transient cloud/Feishu outage does not
leave the unit permanently down. Local workers reconnect with backoff; the
daemon does not switch transports or replay unacknowledged mutations.

Health check: `curl -fsS http://127.0.0.1:8787/healthz`. It never includes
secrets, app ids, node contents, or message data. A fail-closed persistence
failure reports `ok: false` with HTTP 503, so a process that can no longer
acknowledge durable writes must not be treated as healthy.

## Staging: storage-only first

1. Confirm the intended server/hostname and credential ownership. Do not invent
   or reuse an unknown live cloud target.
2. Back up the existing worker configuration, native keystore references,
   routes, and local inbox. Keep the old Bitable/legacy mode available for
   rollback.
3. Install `dist/relay-server.cjs`, credential files, data directory, and TLS
   proxy. Start with:
   `CODEX_RELAY_GATEWAY_ENABLED=false node dist/relay-server.cjs --storage-only`
4. Verify `--help` runs without credentials, `/healthz` reports
   `gateway: "disabled"`, an unauthenticated upgrade is rejected, and no
   Feishu long-connection is opened by the cloud process.
5. Point one prepared worker at the relay URL through its native setup and
   confirm hello, activation, heartbeat/presence, CRUD/CAS, restart retention,
   and pending-command wake. Keep the old receiver running during this local
   validation only if it is not receiving the same events.

## Coordinated cutover

Feishu delivers an event to one connected receiver; two receivers for the same
app are not deterministic. Therefore:

1. Prepare updated workers and confirm the old Mac receiver is stopped.
2. Stop the old Windows receiver.
3. Import only signed nodes/routes into relay storage (Phase B tooling). Never
   import command queues or inbox receipts.
4. Start the API-only relay worker on Windows and verify activation.
5. Enable the cloud Feishu gateway (`CODEX_RELAY_GATEWAY_ENABLED=true`) and
   confirm `gateway: "connected"` plus fresh worker heartbeats.
6. Verify a fresh message, card callback, thread/reply IDs, and document
   comment ownership.
7. Only then join the Mac worker in API-only mode.

**Never run the cloud gateway at the same time as the old Mac or Windows
receivers.** The cloud gateway must be the only Feishu event WebSocket for the
application.

## Rollback

Rollback order matters:

1. Disable/stop the cloud gateway **before** restoring any old receiver.
2. Stop API-only relay workers.
3. Restore the previous worker configuration and native token/route state.
4. Restart the old receiver mode and verify Feishu delivery.

The relay data directory is retained for diagnosis/retry. Do not "fix" a
rejected startup by deleting a corrupt snapshot; restore a verified backup.
The store fails closed on malformed/mismatched state and on a second writer.

## Operational limits

- 256 KiB frame, 128 KiB raw row value, 256-character key/target.
- Escape expansion is supported: one row's escaped JSON may grow up to the hard
  frame budget minus a 4 KiB envelope headroom. Only a row that cannot fit a
  frame after escaping is rejected (`too_large`); nothing is silently skipped.
- 32 worker sockets plus a bounded observer pool, bounded pending RPCs/send
  buffers; disabled compression.
- 10,000 rows per table and a 16 MiB persistent data budget.
- List pages cap at 100 rows / about 128 KiB soft target. A single accepted
  row larger than the soft target is returned alone on its page; every page
  stays within the 256 KiB frame.
- Commands expire and are cleaned up; restart keeps pending commands.
- A different-host duplicate identity is rejected without displacing the
  current owner; same-host reconnect safely replaces the old socket.
- Activation is always explicit. A handshake, reconnect, or fresh same-host
  setup is **offline** and absent from `ready`/presence until it sends the
  `activate` operation. A disconnect is immediately offline. Reconnecting
  clients must activate again; the server never autoactivates from history.
- Observers/setup connections are read-only and cannot activate.

## Storage lock recovery

The state directory lock is advisory and single-writer. A same-host lock is
reclaimed only when its recorded PID is definitively dead; `startedAt` and file
age are never used to evict a live owner. Foreign-host, malformed, or
unreadable locks fail closed with an actionable error. Dead-owner removal is
serialized by a recovery guard (`relay-state.lock.recovery`) so two processes
recovering the same dead owner produce exactly one writer.

The recovery guard itself is **never auto-reclaimed**: a pre-existing guard
means a reclaimer crashed at this rare point, and reading then unlinking
someone else's guard would reintroduce a TOCTOU race. Startup fails closed with
an explicit error instead. Manual recovery: stop every relay process, confirm
no owner process is running, inspect `relay-state.lock` and
`relay-state.lock.recovery`, then remove the guard (and the lock only when its
recorded PID is definitively dead). Never delete a live lock; restore from
backup if the snapshot itself is corrupt.

## Phase B worker and migration commands

Phase B adds the opt-in local WebSocket client, API-only worker lifecycle and
transactional CLI setup/import/status. Nothing below authorizes a live change
by itself; stop the old receiver only at the documented deployment step.

### Worker setup (reuses the existing bot)

```sh
# Stop this bot's foreground `run` and background `start` first. Setup also
# takes the existing per-bot single-instance lock and refuses while either runs.
printf '%s' "$CODEX_RELAY_TOKEN" | node bin/feishu-codex-bridge.mjs fleet relay setup \
  --url wss://relay.example.com \
  --token-stdin \
  --name windows-office \
  --app-id cli_xxxxxxxxxxxx

# Optional, only for an explicitly managed local proxy:
#   --proxy-url http://127.0.0.1:7897

# Explicit one-time metadata import from the previous Bitable directory:
printf '%s' "$CODEX_RELAY_TOKEN" | node bin/feishu-codex-bridge.mjs fleet relay setup \
  --url wss://relay.example.com --token-stdin --import-from-bitable
```

`--url` accepts `wss://host` or the fixed `wss://host/relay/v1`; public plain
`ws://` is rejected (loopback only). `--app-id` is validated before any bot
directory is selected. The relay token is read from stdin (bound to 1024 bytes
of input), must be at least 32 bytes/high entropy and at most 512 characters,
and is stored only in the native encrypted keystore under a **new versioned**
`relay.tokenSecretId`. It is not the Feishu App Secret, is never in
argv/URLs/logs/JSON output, and never replaces the existing App Secret.

Setup reuses the selected complete bot directory and preserves owner/admin
preferences, project/session/inbox state, legacy Bitable fields and the stable
node ID. The existing per-bot single-instance lock is acquired before any
configuration write, secret change or import. A pending identity file
(`fleet/relay-setup-pending.json`) preserves the new identity across
interruption; the previous working config is not rewritten to disabled. The
token/config are committed only after an inactive worker connection validates
the namespace/shared metadata and any requested import is ready.

Each commit writes a new token secret and then atomically saves the config. The
old token key/value is never overwritten, so a failed save (`ENOSPC`, `EACCES`)
or interrupted commit leaves the previous usable config and token intact; the
new token is at worst an orphan. A postcommit failure to remove the pending
identity file is reported as committed success, not as a rolled-back
transaction. Rollback therefore only needs the previous config (whose
`tokenSecretId` still points at the untouched old key); no raw-secret backup
file exists.

### Import behavior and quiescence

`--import-from-bitable` validates the original Bitable identifiers and verifies
**every** signed `nodes`/`routes` row before changing the relay destination. It
copies only those two tables. Commands, inbox receipts, sessions and projects
are never copied, no dual-write occurs, and there is no implicit migration or
fallback. Conflicting destination values are refused before any import write;
identical valid values are accepted and gateway metadata is not an import
conflict. If import commits and a later local config commit fails, the copied
equal metadata is retained so a retry is idempotent and never overwrites the
current owner.

Quiesce the old receiver before import: pending commands in the old queue are
not copied, remain in the old transport and expire there. Complete or
explicitly abandon them before switching; do not run old and new receivers for
the same bot.

### Status, start and disable safety

```sh
node bin/feishu-codex-bridge.mjs fleet relay status
node bin/feishu-codex-bridge.mjs start  # foreground: node bin/feishu-codex-bridge.mjs run
```

General `fleet status` prints `transport` plus the sanitized relay URL for a
relay config (and no fictitious Bitable poll interval); `fleet relay status`
prints enabled/name/node ID/config path. Neither prints the token value or
secret reference, and an invalid URL is shown as a fixed marker rather than an
arbitrary path that could contain a token.

A relay worker opens **no Feishu event WebSocket**. The SDK is constructed with
the supported webhook lifecycle only to fetch bot identity/register handlers;
outbound replies and the native CLI/orchestrator/API sender remain available.

At login a transient relay outage leaves the daemon reconnect-pending instead
of exiting. The true startup order is:

1. connect the relay socket and receive `ready` (inactive);
2. validate home, migrate local ownership, publish the signed node and sync
   project bindings;
3. invoke the runtime readiness callback exactly once, which activates the
   worker;
4. only then drain pending commands and schedule heartbeats.

On reconnect the client emits `reconnected` while still inactive; the retained
runtime callback republishes/syncs, activates, and only then drains. A
`quit`/stop during any of these awaits cancels the chain; no later activation,
command claim or timer resurrection occurs. Auth, protocol-version and
different-host identity failures are terminal and are surfaced without falling
back to Bitable or a local Feishu WS. Mutations whose response was lost are
unknown and are never replayed automatically; reads may be retried safely.

```sh
node bin/feishu-codex-bridge.mjs fleet relay disable
```

Disabling in relay mode refuses unsafe local-WS restoration: it stops routing
immediately, and a later `start` fails closed with a clear error rather than
opening a local Feishu event socket while a cloud gateway may own the events.
`fleet relay disable` refuses to mutate a Bitable/no-fleet configuration; the
ordinary `fleet disable` remains the Bitable command. The relay command never
disables the cloud gateway remotely. To roll back after the gateway is
explicitly disabled, restore the prior config (the untouched old token key is
still valid) or re-run the legacy Bitable setup, and only then start the old
receiver.

## Reproducible process acceptance

From the built source checkout, run `npm run test:relay-process`. It starts the
standalone bundle and production receiver in separate local Node processes,
checks original message/card fields, server reconnect and durable inbox replay
suppression, then removes only its own temporary data. CI runs it on Windows,
macOS and Linux. This verifies local loopback WS, not public WSS/TLS or real
Feishu delivery. Use `node bin/feishu-codex-bridge.mjs` from this checkout for
worker maintenance; an older global CLI may point at another installation.
