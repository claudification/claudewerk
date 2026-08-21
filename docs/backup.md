# Broker Backup & Restore

## Overview

`broker-cli backup` provides atomic SQLite snapshots of the broker's data volume
using `VACUUM INTO` (WAL-safe, zero writer blocking). Backups are compressed
tar.zst archives with SHA-256 checksums and version metadata, verified end to
end before they are recorded as successful.

Transcript history beyond the hot window lives in immutable per-month cold
archives -- see **Cold Transcript Archives** below.

## Commands

```bash
# Create a backup (inside container)
docker exec broker broker-cli backup create --dest /data/backups

# With tiered retention (default: 24h hourly + 7d daily)
docker exec broker broker-cli backup create --dest /data/backups --retain-hours 24 --retain-days 7

# Include ephemeral blobs (7-day TTL, usually not worth backing up)
docker exec broker broker-cli backup create --dest /data/backups --include-blobs

# List available backups (recognises .tar.gz and .tar.zst)
docker exec broker broker-cli backup list --dest /data/backups

# Apply retention WITHOUT taking a new backup (use when the disk is the problem)
docker exec broker broker-cli backup prune --dest /data/backups --dry-run

# Is there a verified, recent backup? (what the maintenance job gates on)
docker exec broker broker-cli backup gate --dest /data/backups

# Restore (broker must be STOPPED first)
docker compose stop broker
docker exec broker broker-cli backup restore /data/backups/backup-20260506-120000.tar.zst
docker compose start broker
```

## What Gets Backed Up

| File | Type | Criticality |
|------|------|-------------|
| `store.db` | SQLite (VACUUM INTO) | HIGH - all conversations, transcripts, settings, shares, cost data |
| `analytics.db` | SQLite (VACUUM INTO) | LOW - tool-use analytics, non-critical |
| `projects.db` | SQLite (VACUUM INTO) | LOW - project URI registry |
| `auth.json` | File copy | CRITICAL - passkeys, users, sessions |
| `auth.secret` | File copy | CRITICAL - HMAC signing key |
| `sentinel-registry.json` | File copy | MEDIUM - sentinel host records |
| `blobs/` | File copy (opt-in) | OPTIONAL - 7-day TTL reaper |

That table is exhaustive. Everything in it lives in the broker's own cache
directory; nothing outside that directory is in any archive.

## Project boards are NOT here -- git covers them

`.rclaude/project/` (the kanban board: cards, epics, priority) is **outside every
backup on this page, by design and permanently.**

The broker never reads or writes a project tree. CWD IS INFORMATIONAL is a
covenant with `lint:boundary` Rule 4 enforcing it, so `src/broker/backup/`
structurally cannot reach a board, and teaching it to would be the wrong
component. **Do not add `.rclaude/` to the broker backup.** If a second copy is
ever wanted beyond git, it belongs to the sentinel, which already owns board file
I/O.

So the board's durability is git, and only git:

```
.rclaude/*                          # contents, NOT the directory
!.rclaude/project/                  # the board -- tracked
!.rclaude/rclaude.json              # project config -- tracked
```

Excluding the **directory** (`.rclaude/`) instead of its **contents**
(`.rclaude/*`) is the trap. Git never descends into an excluded directory, so a
nested `!project/` negation is not merely overridden, it is never read. That is
how the board sat in no backup and no git at once until 2026-08-21: 604 cards,
7.1 MB, zero copies, with a `.rclaude/.gitignore` claiming otherwise.

`src/shared/board-gitignore.test.ts` asserts both directions -- the board is
offered to `git add`, and `settings/` (687 MB of session logs and secrets) is
not. Both, because over-correcting fails just as silently as under-correcting.

## How It Works

1. **VACUUM INTO** each SQLite database to a temp directory. This creates a
   consistent, defragmented snapshot without blocking concurrent writers. The
   output is a single `.db` file (DELETE journal mode, no WAL/SHM sidecars).
2. **Strip derived artifacts** from the snapshot (currently: the
   `transcript_fts` FTS5 index over `transcript_entries.content` and its
   sync triggers). These are fully rebuildable from base tables, so backing
   them up wastes space. On next broker startup after restore, `createSchema()`
   recreates the FTS table + triggers and detects an empty index against
   non-empty source rows -- it then backfills with a single
   `INSERT INTO transcript_fts(rowid, content) SELECT id, content FROM transcript_entries`.
3. **Copy** flat config files alongside the database snapshots.
4. **Write manifest.json** with SHA-256 checksums, broker git hash, branch,
   build time, and hostname.
5. **tar + compress** everything into `backup-YYYYMMDD-HHMMSS.tar.zst`
   (`.tar.gz` when zstd is absent -- see Compression below).
6. **Verify the archive is complete** by streaming it back through `tar -t` and
   asserting every manifest member is present.
7. **Write `.last-success.json`** -- the sentinel the maintenance job gates on.
8. **Prune** old backups per the tiered retention policy.

### Step 6 is not optional

A truncated archive lists cleanly up to the cut and yields a `SQLITE_CORRUPT`
database, so file size and existence prove nothing. On 2026-08-07 an in-process
stream chain (`Bun.spawn(compressor, { stdin: tar.stdout })` draining into a
FileSink) passed at 200 MB and silently truncated a 9.3 GB archive; the run
reported success. The pipeline now runs under `sh -c` with `set -o pipefail` so
the kernel owns the pipe, AND every archive is read end to end before the
sentinel is written. Nothing downstream may trust an archive that has not been
read back.

## Compression

zstd (`-T0 -10 --long=27`) is the default; gzip is the fallback when the binary
is missing, so an older image keeps working. Both extensions stay readable
forever -- an archive written last month is the only copy of last month, so
`list` and `restore` dispatch on the extension, never on the current default.

Override the level with `CLAUDWERK_ZSTD_LEVEL`, or the compressor per-run with
`--compressor zstd|gzip`.

Measured on the real 8.7 GB `store.db` (1.22M transcript rows, 5.66 GB of
content), same source, both including the read-back verification:

| Compressor | Archive | Wall |
|---|---|---|
| gzip | 1.48 GB | 167 s |
| **zstd** | **0.75 GB** | **82 s** |

Exactly 2x smaller and 2x faster. The wall-clock half is the one that matters
for RAM: the shorter the run, the smaller the window in which the guest page
cache is full of database pages.

### The pipeline shell is not `sh`

`tar | zstd > archive` is handed to a shell so the kernel owns the pipe, and
`set -o pipefail` is what turns "tar died halfway" into a non-zero exit instead
of a quietly short archive. **dash does not have `pipefail`.** `/bin/sh` in
`debian:bookworm-slim` *is* dash, so `sh -c 'set -o pipefail; ...'` exits 2 with
`Illegal option -o pipefail` before a single byte moves -- every backup fails at
the compress step. It stayed invisible in tests because macOS ships bash as
`/bin/sh`.

`resolvePipeShell()` therefore probes `bash`, `ksh`, `zsh` and uses the first
that honours the option, and **throws when none does** rather than running
without it. Refusing to back up is loud and recoverable; a truncated archive
that exits 0 is neither.

The FTS strip separately switched from a second full-file `VACUUM` (which
rewrote all 8.8 GB a second time on every run) to `PRAGMA secure_delete` before
the drop, so the freed pages are zero-filled in place. Measured size-neutral --
gzip lands on the same 1.48 GB either way -- but it removes a full write and a
full read per run. Set `CLAUDWERK_BACKUP_RECLAIM=vacuum` to restore the old
behaviour.

## Tiered Retention

Retention is controlled by `--retain-hours N` (default 24) and `--retain-days N`
(default 7):

- **Hourly tier**: All backups within the last N hours are kept.
- **Daily tier**: Beyond the hourly window, only the newest backup per calendar
  day is kept, for N days.
- Everything older is deleted.

With hourly backups, the defaults produce:
- Up to 24 hourly backups from the last day
- 1 daily backup for each of the preceding 7 days
- Maximum ~31 archives on disk

## Manifest

Every archive contains `manifest.json`:

```json
{
  "timestamp": "2026-05-06T05:50:21.339Z",
  "hostname": "studio",
  "version": {
    "gitHash": "8248a443ec12ab...",
    "gitHashShort": "8248a44",
    "branch": "main",
    "buildTime": "2026-05-06T05:18:54.281Z",
    "dirty": false
  },
  "files": [
    { "path": "store.db", "size": 121921536, "sha256": "abc123..." },
    ...
  ],
  "durationMs": 12130
}
```

Restore verifies every file's SHA-256 before overwriting.

## Restore Safety

- `broker-cli backup restore` **refuses** if the broker is running (checks
  `broker.pid` and sends signal 0 to verify the process is alive).
- Stop the broker first: `docker compose stop broker`.
- After restore, start the broker: `docker compose start broker`.

## Docker Volume Layout

```yaml
# docker-compose.yml
volumes:
  - concentrator-data:/data/cache        # live data (read-write)
  - ${BACKUP_DIR:-./backups}:/data/backups  # backup archives (bind-mount)
```

The bind-mount means backup archives are directly accessible on the host
filesystem for rsync, rclone, or any off-site replication.

## Automated Hourly Backup (Cron)

`scripts/backup-cron.sh` is a host-side wrapper:

```bash
# Add to crontab (host machine, not inside container)
0 * * * * /path/to/scripts/backup-cron.sh
```

The script self-logs to `~/Library/Logs/claudewerk/backup.log` (override with
`CLAUDEWERK_LOG_DIR`), so a crontab redirect is optional. It resolves `docker`
robustly regardless of cron's minimal PATH -- the 2026-06 incident: cron could
not find `docker` (it lives in `/usr/local/bin`, off cron's PATH) and every run
died for a month, the failure masked as "container not running" and logged only
to `/tmp` (wiped on reboot). Override `BROKER_CONTAINER` / `DOCKER_BIN` if needed.

## Monitoring (staleness + disk watchdog)

`scripts/backup-monitor.sh` is a **docker-free** watchdog -- it reads the real
backup archives on the host bind-mount and the host filesystem directly, so it
still reports correctly when the broker (or docker itself) is down, which is
exactly when backups tend to stop.

```bash
# 30 min after the backup, so it reads a settled state
30 * * * * /path/to/scripts/backup-monitor.sh
```

It writes a machine-readable health file and a human log (no push channel by
design -- grep/tail them, or wire an alert onto the non-zero exit):

- `~/Library/Logs/claudewerk/backup-health.json` -- `overall`, `backup_status`
  (`OK`/`STALE`/`MISSING`), newest archive + age, `disk_status`, `disk_used_pct`.
- `~/Library/Logs/claudewerk/backup-monitor.log` -- one line per run.

Thresholds via env: `STALE_HOURS` (default 3), `DISK_WARN_PCT` (default 90),
`BACKUP_DIR` (default repo `./backups`). Exit is non-zero on any ATTENTION state.

## Disk hygiene

Two things keep the broker from filling the disk:

- **Deploy prune.** `scripts/docker-build-broker.sh` prunes old
  `remote-claude-broker:<sha>` image tags after each build (keep `:latest` +
  `KEEP_IMAGES` newest, default 5) then sweeps dangling layers. Without this,
  every deploy left a ~2GB image behind -- they had reached 271GB reclaimable.
- **Temp sweep.** `createBackup` removes any orphaned `_tmp_backup_*` working
  dir at the start of each run. A backup OOM-killed mid-VACUUM leaks its temp
  (a full uncompressed db snapshot; one leak was 9.2GB) because SIGKILL bypasses
  the cleanup -- the sweep reclaims it on the next run.

## Sizing

| Database | Typical size | Compressed | Notes |
|----------|-------------|------------|-------|
| store.db | 50-500 MB | ~5-60 MB | Grows with conversation history |
| analytics.db | 50-500 MB | ~5-60 MB | Grows with tool-use tracking |
| projects.db | < 1 MB | < 100 KB | One row per project path |
| Flat files | < 100 KB | Negligible | auth, sentinel config |

Text-heavy SQLite data compresses ~89-96% with gzip. A 576 MB dataset
compresses to ~65 MB.

## Source

- Core logic: `src/broker/backup.ts`
- CLI handler: `src/broker/cli/backup-commands.ts`
- Cron script: `scripts/backup-cron.sh`

---

# Cold Transcript Archives

`store.db` grows monotonically with transcript history (~1 GB/month at current
rates), and every hourly backup pays for all of it. Cold archives bound the hot
database while keeping history **indefinitely**.

```
HOT   store.db                              last N days, queryable + FTS-indexed
COLD  /data/archives/transcripts-YYYY-MM.ndjson.zst   everything older, forever
```

## Commands

```bash
# What is hot, what is cold, and where the holes are
docker exec broker broker-cli archive list

# Which months are fully older than the hot window
docker exec broker broker-cli archive candidates --hot-days 90

# Export one UTC month (writes .ndjson.zst + .meta.json)
docker exec broker broker-cli archive export 2026-06

# Integrity only, or integrity + "does it still match the live database"
docker exec broker broker-cli archive verify 2026-06
docker exec broker broker-cli archive verify 2026-06 --against-db

# Read a month back (idempotent; --target-db for a scratch database)
docker exec broker broker-cli archive import 2026-06

# Delete the archived rows from the hot database (dry run without --confirm)
docker exec broker broker-cli archive prune 2026-06 --confirm

# Cost a cold search before paying for it (reads the metas, decompresses nothing)
docker exec broker broker-cli archive search --plan

# Grep the cold months. SLOW -- see "Searching cold archives" below
docker exec broker broker-cli archive search "the phrase" --type user,assistant
docker exec broker broker-cli archive search "the phrase" 2026-04 --limit 20
```

## Searching cold archives

The hot database has an FTS5 index. Cold archives have **nothing** -- they are
immutable compressed text, and searching one means decompressing every byte and
testing every line. There is no index to add without giving back the property
that makes archives worth having: one flat file per month, no companion state to
keep in sync. So the search is shaped like `grep`, and every surface says so.

**Measured on this box** (2026-08-07, the real 2026-04 archive):

| | |
|---|---|
| Throughput | **~326 MB/s** of plaintext, end to end (decompress + split + match) |
| One real month (~2.5 GB) | **~8 s** |
| A full year (~25 GB) | **~80 s** |
| 2026-04 (97.9 MB, 33,352 rows) | **0.3 s** |

`--plan` estimates at a deliberately conservative 220 MB/s, so it reads a little
over rather than under.

Three surfaces, same engine:

| Surface | Entry point |
|---|---|
| CLI | `broker-cli archive search <query>` (exits **2** when the answer is incomplete) |
| REST | `GET /api/archives/search?q=` and `/api/archives/search/plan` (admin only) |
| MCP | `search_archives` + `archive_search_plan` |

**Semantics worth knowing before you trust a result:**

- Literal substring by default, case-insensitive. **No stemming, no ranking** --
  `run` will not find `running`.
- The needle is escaped the way JSON escaped it on the way in, so a query
  containing a quote, a backslash or a newline matches. **`--regex` gets no such
  translation**: it runs against the raw JSON-escaped line, where a newline in
  the content is the two characters `\` and `n`.
- Newest month first, so a capped search returns the most recent matches.
- **Use `--type user,assistant`.** Cold months are mostly `attachment` and
  `tool_result` rows carrying huge JSON blobs; unfiltered, they drown the result.
- A hit cap (`--limit`, default 50) and a wall-clock budget (`--max-seconds`,
  default 120) both stop the scan early. When either fires, the result reports
  `truncated` plus `skippedMonths`, the CLI prints `INCOMPLETE:` and exits 2, and
  the MCP tool is instructed to say so. **A cold search that shows hits without
  showing what it skipped is lying about coverage.**
- `conversationId` and `--type` filter *results*; they do not reduce the bytes
  scanned. Only `--month` makes the job smaller.

## The archive dir must be a mount

`/data/archives` is bind-mounted from the host (`ARCHIVE_DIR`, default
`./archives`) and that is **load-bearing, not tidiness**. A cold archive is the
only copy of its month once retention deletes those rows from `store.db`, and
cold archives are **not** inside the hourly backup tar -- that covers the hot
databases and the auth files, nothing else.

It shipped without the mount. `/data/archives` was the container's writable
layer, which `docker compose up -d` throws away, so any redeploy after a delete
would have destroyed history nothing else held. Caught before the delete step
was ever enabled, and now `exportMonth` calls `assertDurableArchiveDir()` and
refuses to write a single row to a directory whose nearest mount point is `/`.
Override with `CLAUDWERK_ALLOW_EPHEMERAL_ARCHIVES=1` on a throwaway broker.

Back the archive directory up off-box like any other primary data. It is small
(~2-4 GB/year) and never rewritten once a month closes.

## Why NDJSON and not CSV

`transcript_entries.content` is arbitrary text carrying newlines, quotes and
embedded JSON. CSV quoting would be a correctness minefield and lossy at the
edges. NDJSON is one row per line, survives schema drift (a new column simply
appears in later months), stays greppable through `zstdgrep`, and re-imports
with a trivial loader.

Months are keyed in **UTC**, deliberately: the host timezone can change and an
archive that silently re-partitions because someone moved timezone is not an
archive.

## Measured

| Month | Rows | Plain | Archive | Ratio |
|---|---|---|---|---|
| 2026-04 | 33,352 | 98 MB | 14 MB | 7.2x |
| 2026-06 | 565,792 | 2,808 MB | 286 MB | 9.8x |

A full year costs roughly 2-4 GB. Five years, ~15 GB.

## Integrity

Each archive carries a `.meta.json` sidecar with row count, id/timestamp span,
the exported range, and a sha256 **over the uncompressed NDJSON stream** -- an
anchor independent of the compressor and its level.

`verify` makes two distinct claims, and only the second licenses a delete:

1. **against the meta** -- the file is intact and complete.
2. **`--against-db`** -- every row it contains still hash-matches the database
   rows it covers.

"The file is valid" and "the file contains what I am about to destroy" are
different claims. Retention requires both.

> A decoder bug once satisfied (1) while failing (2): the reader called
> `buf.toString('utf-8')` per chunk, so multi-byte characters straddling a
> 4 MiB boundary decoded as U+FFFD. The bytes were perfect and the sha256
> matched; only the row-level comparison caught it. A hash-only verify would
> have blessed those archives.

## Deleting archived rows

`archive prune` is the only irreversible operation in this system. It is gated
four deep:

1. the archive must exist, be intact, and hash-match its meta
2. every row must still hash-match the live database
3. the delete runs in a transaction that COUNTs the range before and after, and
   rolls back unless both numbers line up -- a late row landing in an
   already-archived month rolls back rather than being destroyed
4. nothing runs without an explicit `--confirm`

A rollback is not a failure to work around; it means "re-export, then retry",
and the data is untouched meanwhile.

Row counts are taken with `SELECT COUNT(*)`, never `run().changes` --
`transcript_entries` carries FTS shadow triggers whose writes are folded into
the reported change count (deleting 5 rows reports 15).

---

# Nightly Maintenance

`scripts/db-maintenance.sh` (host cron, `0 5 * * *`) drives
`broker-cli maintain`. Host-side on purpose: the container clock is UTC, and
05:00 is meant to be 05:00 where Jonas is.

```
GATE -> ARCHIVE -> VERIFY -> DELETE -> CHECKPOINT -> VACUUM -> SMOKETEST
```

| Step | What it does | Aborts the run? |
|---|---|---|
| `gate:backup` | `.last-success.json` newer than `--max-backup-age` AND its archive still hashes correctly | yes -- nothing else runs |
| `archive:<month>` | export + verify each month past `--hot-days` | that month only |
| `delete:<month>` | remove archived rows; off unless `--confirm` | that month only |
| `checkpoint` | `wal_checkpoint(TRUNCATE)` | yes |
| `vacuum` | reclaim freed pages; skipped when free space < 1.1x the database | no (skips) |
| `smoketest` | `quick_check`, `foreign_key_check`, an FTS query, row-count bounds, `/health` | marks the run failed |

The gate re-hashes the archive rather than trusting the sentinel's word. A
sentinel pointing at a truncated or missing archive is worse than no sentinel:
it would greenlight a delete with no rollback behind it, so a mismatch fails
closed.

Every run writes `.last-maintenance.json` next to the backups. Every step
records a line -- ok, skipped or failed, always with a reason. A report missing
a step cannot be told apart from a step that silently vanished, which is exactly
the ambiguity you do not want at 05:00 with rows already deleted.

**`CONFIRM_DELETE=0` is the default.** Set it to `1` only after a successful
export+verify round-trip is visible in the log.

---

# Dedup bake-off (measured 2026-08-07) -- restic LOSES

The plan assumed a content-defined-chunking repo would cut hourly storage
dramatically, since consecutive snapshots are ~99% identical data. **Measured,
it does not.** Recording the numbers so nobody re-litigates it from intuition.

Method: two `VACUUM INTO` snapshots of the real 8.66 GB `store.db`, the second
after ~1 hour of simulated drift (1,200 new transcript rows), both fed to a
restic 0.19.1 repo.

| | Repo size | Wall |
|---|---|---|
| after snapshot A | 2.30 GB | 11.8 s |
| after snapshot B (1 h later) | 3.23 GB | 7.4 s |
| **incremental cost of one hour** | **~0.93 GB** | |

restic reports 17.33 GiB logical across the two snapshots compressed and
deduped down to 3.23 GiB (3.28x).

Against the shipped pipeline at **0.75 GB per complete archive**, restic's
*incremental* is larger than our *full*. Over a 24-hour window: ~23.7 GB for
restic versus 18 GB for plain hourly zstd archives.

**Why.** Dedup wants a stable byte layout. `VACUUM INTO` guarantees the
opposite -- it rewrites the entire database with a fresh, defragmented page
layout, so inserting a handful of rows shifts content throughout the file and
the rolling-hash chunker finds little to reuse. The very property that makes
`VACUUM INTO` a safe snapshot (a clean, self-consistent rewrite) is what defeats
the dedup.

Two caveats stated plainly:
- restic's absolute numbers are inflated here because its snapshots included the
  `transcript_fts` index, which our pipeline strips. That does not change the
  verdict: its per-hour increment still exceeds our per-hour total.
- **Untested hypothesis:** dedup would likely work far better against the *raw*
  database file, since page layout is then stable between hours. That trades
  away the consistent-snapshot property `VACUUM INTO` buys, and was not
  measured.

**Verdict: keep hourly zstd archives.** Litestream remains the only candidate
that could beat this (it ships WAL frames, so it never re-reads the whole
database), but it is a sidecar with a different restore story and does not cover
`auth.json` / `auth.secret` / `sentinel-registry.json` -- the tar path survives
either way. Not pursued.
