import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UserGrant } from '../permissions'

/** Prefer the container path when it exists, else a per-user cache dir. Keeps
 *  the CLI working identically inside Docker and on a developer's machine. */
function containerPathOrLocal(containerPath: string, localName: string): string {
  if (existsSync(containerPath)) return containerPath
  return join(process.env.HOME || process.env.USERPROFILE || '/root', '.cache', localName)
}

export const DEFAULT_CACHE_DIR = containerPathOrLocal('/data/cache', 'broker')
export const DEFAULT_BACKUP_DIR = containerPathOrLocal('/data/backups', 'broker-backups')

/** Cold archives live apart from backups on purpose: /data/backups rotates and
 *  is pruned, /data/archives is immutable and is never pruned. */
export const DEFAULT_ARCHIVE_DIR = containerPathOrLocal('/data/archives', 'broker-archives')

const KNOWN_ROLES = new Set(['admin'])

export function notifyServer(cacheDir: string): void {
  const pidFile = join(cacheDir, 'broker.pid')
  try {
    if (!existsSync(pidFile)) {
      console.log('Note: No running server found - changes saved to disk.')
      return
    }
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
    process.kill(pid, 'SIGHUP')
    console.log(`Server notified (SIGHUP -> PID ${pid})`)
  } catch {
    console.log('Note: Could not signal server - changes saved to disk, server will pick them up on restart.')
  }
}

export function parseGrants(grantStrs: string[], notBeforeArg: string, notAfterArg: string): UserGrant[] {
  return grantStrs.map(s => {
    const colonIdx = s.indexOf(':')
    if (colonIdx <= 0) {
      console.error(`Invalid grant format: "${s}" (expected "scope:permission,permission")`)
      process.exit(1)
    }
    const scope = s.slice(0, colonIdx)
    // Same split-and-classify as the standalone parser; share it rather than
    // keeping two copies that can drift as KNOWN_ROLES grows.
    const { roles, permissions } = parsePermissionItems(s.slice(colonIdx + 1))
    return {
      scope,
      ...(roles && roles.length > 0 && { roles }),
      ...(permissions && permissions.length > 0 && { permissions }),
      ...(notBeforeArg && { notBefore: new Date(notBeforeArg).getTime() }),
      ...(notAfterArg && { notAfter: new Date(notAfterArg).getTime() }),
    }
  })
}

export function parsePermissionItems(permissionsArg: string): {
  roles: UserGrant['roles']
  permissions: UserGrant['permissions']
} {
  const items = permissionsArg.split(',').map(p => p.trim())
  const roles = items.filter(i => KNOWN_ROLES.has(i)) as UserGrant['roles']
  const permissions = items.filter(i => !KNOWN_ROLES.has(i)) as UserGrant['permissions']
  return { roles, permissions }
}

export function printUsage(): void {
  console.log(`
broker-cli - User & passkey management for Claudwerk Broker

COMMANDS:
  create-invite --name <name> [--grant "scope:perm,perm"]  Create invite with grants
  list-users                                                List all users with grants
  revoke --name <name>                                     Revoke a user's access
  unrevoke --name <name>                                   Restore a revoked user
  grant --name <name> --scope <scope> --permissions <p,p>  Add grant to user
  revoke-grant --name <name> --scope <scope>               Remove grant from user
  set-role --name <name> --role <role>                     Add a server role
  remove-role --name <name> --role <role>                  Remove a server role
  list-passkeys --name <name>                               List passkeys for a user
  delete-passkey --name <name> --credential-id <id>        Delete a passkey (kills sessions)
  migrate [--cache-dir <dir>] [--data-dir <dir>] [--dry-run]  Migrate legacy JSON to SQLite
  query [--db <name>] [--json] "SQL"                        Read-only SQL against store/analytics/projects
  exec  [--db <name>] [--json] "SQL"                        Read-write SQL (admin tool, use with care)
  resolve-path <path>                                       Debug: test path jail resolution

SENTINEL COMMANDS:
  sentinel create --alias <alias> [--color <hex>]          Create sentinel with per-host secret
  sentinel list                                             List all registered sentinels
  sentinel set-default --alias <alias>                      Set default sentinel
  sentinel revoke --alias <alias>                           Revoke sentinel secret

DEV-HARNESS COMMANDS (require DEV_HARNESS_ENABLED=1 on the broker):
  mint-dev-key --as <user> [--ttl <sec>]                   Mint a dev impersonation key (default 1h)
    Stateless HMAC-signed token; mount one component against the real broker
    via /dev/harness?mount=<id>&key=<token>. Never available on a prod broker.

GATEWAY COMMANDS:
  gateway create --alias <alias> [--type <type>]           Create gateway with dedicated secret
  gateway list                                              List all registered gateways
  gateway revoke --alias <alias>                            Revoke gateway secret

REPORTER COMMANDS (rpt_ keys -- node vitals ONLY, no spawn authority):
  reporter create --alias <alias> [--color <c>]            Create a reporter key. WebSocket only,
                                                             one connection per key, one capability
                                                             (can_report_node_stats). Never a spawn target.
  reporter list                                             List registered reporters
  reporter revoke --alias <alias>                           Revoke a reporter key

  There is no HTTP route that mints these -- minting lives here, on the box
  that holds the registry file.

BACKUP COMMANDS:
  backup create [--dest <dir>] [--include-blobs]           Create backup (VACUUM INTO + tar.zst)
    [--retain-hours N] [--retain-days N]                     Tiered retention (default: 24h + 7d)
    [--compressor zstd|gzip]                                 Default: zstd when available, else gzip
  backup list [--dest <dir>]                                List available backups (.tar.gz and .tar.zst)
  backup prune [--dest <dir>] [--dry-run]                   Apply retention WITHOUT taking a new backup
    [--retain-hours N] [--retain-days N]
  backup restore <archive> [--cache-dir <dir>]             Restore from backup (broker must be stopped)
  backup gate [--dest <dir>] [--max-backup-age N]           Check the maintenance gate (verifies last archive)

ARCHIVE COMMANDS (cold transcript storage, one immutable file per UTC month):
  archive list [--archive-dir <dir>] [--json]               Hot-vs-cold coverage map + gaps
  archive export <YYYY-MM> [--force] [--level N]            Export a month to NDJSON.zst + meta sidecar
  archive verify <YYYY-MM> [--against-db]                   Check integrity; --against-db also proves it
                                                              still matches the rows in store.db
  archive import <YYYY-MM> [--target-db <path>]             Rehydrate a month (INSERT OR IGNORE, idempotent)
  archive prune <YYYY-MM> [--confirm]                       DELETE archived rows from the hot database.
                                                              Dry run unless --confirm. Re-verifies against
                                                              the DB and rolls back on any row-count drift.
  archive search <query> [--month YYYY-MM] [--regex]        SLOW grep over the cold months. No index:
    [--case-sensitive] [--conversation <id>] [--limit 50]     every byte is decompressed and scanned.
    [--type user,assistant] [--max-seconds 120]               Newest month first. Exits 2 when the answer
    [--context 160] [--json]                                  is incomplete. Use --plan to cost it first,
  archive search --plan [--month YYYY-MM]                     and --type to skip the JSON-blob rows.

MAINTENANCE COMMAND (intended for cron at 05:00 local, AFTER the hourly backup):
  maintain [--hot-days 90] [--dry-run] [--confirm-delete]   Gate on a verified backup, then
    [--max-backup-age 90] [--skip-vacuum]                     archive -> verify -> delete -> checkpoint
    [--health-url <url>] [--json]                             -> vacuum -> smoketest -> report.
                                                              Aborts before any delete if the gate fails.

TERMINATION COMMANDS (NDJSON log: {cacheDir}/terminations/YYYY-MM-DD.ndjson):
  termination list [--days N] [--limit N] [--source S]      Recent terminations, newest-first
    [--initiator I] [--grep TEXT] [--json]                    (default: 7 days, 50 rows)
  termination show --conv <conversationId> [--json]         All terminations for one conversation
  termination grep <text> [--days N] [--json]               Substring search across NDJSON

  Source enum values:
    dashboard-context-menu, dashboard-terminate-dialog,
    dashboard-lineage, dashboard-terminate-project,
    dashboard-launch-toast, dashboard-fork-close-original,
    dashboard-other,
    inter-conversation-restart,
    mcp-exit-session, headless-input,
    cc-exit-normal, cc-exit-crash,
    ws-close, reaper-phantom,
    sentinel-kill, unknown

  Inside Docker: docker exec broker broker-cli termination list
  Retention: 30 days (auto-rotated daily)

GRANT FORMAT:
  --grant "scope:permission,permission"   (repeatable)
  --grant "/Users/jonas/projects/foo:chat"
  --grant "*:admin"                        (admin for all projects)

  Omit --grant for admin access (default).

  Time bounds (optional, for grant command):
  --not-before "2026-04-01"                Grant active from this date
  --not-after "2026-06-30"                 Grant expires after this date

PERMISSIONS:
  admin, chat, chat:read, terminal, terminal:read,
  files, files:read, spawn, settings, voice

SERVER ROLES:
  user-editor                              Can manage users via API/dashboard

OPTIONS:
  --cache-dir <dir>    Auth storage directory (default: ~/.cache/broker)
  --url <url>          Broker URL for invite links (default: http://localhost:9999)
  -h, --help           Show this help
`)
}
