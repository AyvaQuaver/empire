# Empire deployment playbook (playempire.uk) — Windows target

Server: the user's existing **Windows Server 2025** at `135.181.142.142`
(SSH via OpenSSH for Windows). It already hosts **Collectz** with an established
structure that this deployment deliberately mirrors under `C:\Empire`
(`releases\<sha>` + `shared` env/Caddyfile/logs + scheduled-task runner +
node-based backups). Nothing under `C:\Collectz` is modified except the shared
`Caddyfile`, which gains three appended site blocks (validated + hot-reloaded
through Caddy's admin API — no other application is disrupted).

An earlier Linux-oriented kit (systemd + nginx) is kept in the repository for
reference but does **not** apply to this server.

## Architecture

| Layer | Choice |
| --- | --- |
| App runtime | Node v22.23.2 (`C:\Collectz\tools\node\node.exe`, satisfies `node:sqlite`), running the repo's own `tsx` runner |
| Process supervision | Scheduled Task `EmpireStaging` / `EmpireProduction`, principal `LOCAL SERVICE`, boot-triggered, restart-on-failure (crash recovery), unbounded execution |
| Reverse proxy / TLS | The existing **Caddy** service (`CollectzHttps`) — Empire adds site blocks: `playempire.uk` → 127.0.0.1:8891, `staging.playempire.uk` → 8892, `www` → 308 redirect. Certificates: Caddy ACME (Let's Encrypt) with storage at `C:\Collectz\shared\caddy`, renewals automatic |
| Data | SQLite `C:\Empire\data\<instance>\empire.db` (WAL, single instance) |
| Secrets | `C:\Empire\shared\<instance>.env` (`--env-file`), ACL: only Administrators full + LocalService read; generated on the server via `crypto.randomBytes(32)` |
| Isolation staging/production | Separate ports/tasks/env files/DB files; no shared account DB; no copied data |

## Cloudflare DNS (create these; nothing else in the zone changes)

Apex/`www`/`staging` currently have no records. Create, proxied (orange cloud):

| Type | Name | Content |
| --- | --- | --- |
| A | `playempire.uk` | `135.181.142.142` |
| A | `www` | `135.181.142.142` |
| A | `staging` | `135.181.142.142` |

Zone SSL/TLS mode: **Full (strict)**. No AAAA records (IPv6 unverified). No
"Cache Everything" rule — the app answers `no-store` for private data and only
content-hashed `/assets/*` may be cached.

## Commands (on the server, elevated PowerShell)

```powershell
# --- one-time per instance ---
powershell -ExecutionPolicy Bypass -File C:\Empire\repo\deploy\windows\setup.ps1 -Instance staging
powershell -ExecutionPolicy Bypass -File C:\Empire\repo\deploy\windows\setup.ps1 -Instance production

# --- deploy (run full suite, build, swap release, restart, healthcheck) ---
powershell -File C:\Empire\repo\deploy\windows\deploy.ps1 -Instance staging
powershell -File C:\Empire\repo\deploy\windows\deploy.ps1 -Instance production -Ref origin/codex/empire-mvp

# --- wire domains into the shared Caddy (validate -> backup -> reload) ---
powershell -File C:\Empire\repo\deploy\windows\caddy-reload.ps1

# --- backups (online-consistent) + restore verification ---
powershell -File C:\Empire\repo\deploy\windows\backup.ps1 -Instance production
powershell -File C:\Empire\repo\deploy\windows\backup.ps1 -Instance production -RestoreVerify <file.db>
# schedule: schtasks /tn EmpireBackup /tr "powershell -File C:\Empire\repo\deploy\windows\backup.ps1 -Instance production" /sc daily /st 03:17 /ru SYSTEM

# --- inspect / restart / logs ---
Get-ScheduledTask EmpireStaging, EmpireProduction | Get-ScheduledTaskInfo
Get-Content C:\Empire\shared\logs\staging.log -Tail 50
Stop-ScheduledTask -TaskName EmpireStaging; Start-ScheduledTask -TaskName EmpireStaging
& 'C:\Collectz\tools\caddy\caddy.exe' validate --config C:\Collectz\shared\Caddyfile
```

Rollback: previous releases remain in `C:\Empire\releases`; set
`C:\Empire\shared\active-release-<instance>.txt` to the previous 40-char SHA and
restart the task. **Rollbacks cannot undo database migrations** — restore the
pre-deploy `backup.ps1` snapshot when a migration changed the schema.

## Verify before declaring success

1. `Invoke-WebRequest http://127.0.0.1:<port>/api/health` locally.
2. Through the public hostnames: HTTPS valid (no redirect loop), homepage +
   hashed assets, `/api/capabilities` shows guest-preview, `/api/dev/outbox`
   → 404, `no-store` on private/API responses.
3. Guest flow across independent sessions: join via invite (name entry, no code
   field), share link + decoded QR use the current hostname, words → three
   readings → starter → result → next round; restart the task and confirm data
   persists; result-reveal retention behaves.
4. `data\empire.db` survives `Stop-ScheduledTask`/`Start-ScheduledTask`.

## After verified production

Retire the Mac-side temporary processes (tunnel `cloudflared` and the local tsx
server); the site must keep working with the Mac powered off.
