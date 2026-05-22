# Recovery Runbook

Operational recovery + rollback for the CLAUDEWERK broker/sentinel stack.
The **Current Deploy Status** section at the top is a live snapshot; the
procedures below it are durable.

---

## Current Deploy Status -- 2026-05-22 14:30 UTC

**State: LIVE and HEALTHY. Deploy succeeded and is verified.**

| Item | Value |
|---|---|
| Broker commit (live) | `901cd03a` (was `f31f249c`, 2026-05-20) |
| Broker container | `broker` -- Up, healthy, port 9999 |
| Health check | `curl -sf http://localhost:9999/health` -> `ok` |
| Sentinel | `studio` -- PID **89135**, reconnected; profiles default/work, pool=work, defaultSelection=balanced |
| Migration (profile-url-strip) | RAN: rewrote **23** conversation scope rows + **8** turns.project_uri rows -> canonical form, backfilled `resolvedProfile`. **0** `work@` URIs remain. |
| Usage telemetry | reporting (default 5%, work 9%) |

**What shipped (31 commits, `f31f249c..901cd03a`):**
- Sentinel profiles **7b** (weighted selection: `weight` field, weighted Random, capacity-based Balanced, `weight:0` soft-drain, `sentinel profile add/set --weight`)
- **8** (broker-tunable config screen: `POST /api/sentinels/:id/config` -> `sentinel_patch_config` -> sentinel atomic-write + ack; web sentinel-config-editor)
- **9** (MCP `spawn_conversation` advertises `profile`/`pool` + schema tests)
- profile-url-strip (`c8704b8d`, `42773a93`, `15036bb8` -- profile out of URI -> `resolvedProfile`; web lookup normalization via `projectIdentityKey`; broker write-boundary normalizer)
- termination-log `resolvedProfile` (`f46ee473`)
- `.dockerignore` fix (build context 7.5GB -> 49MB, `12bb0bf4`)
- palette search rerank, transcript-switch perf Phase 2

**Note on the deploy task exit code:** the background deploy reported "exit 144".
That was a FALSE failure -- the broker container recreate (`docker compose up -d`)
dropped this agent host's WebSocket and SIGTERM'd the bash wrapper *after* all
three steps had completed (step 1 exit 0, step 2 exit 0, sentinel restarted).
Verified live state confirms success.

**Outstanding (non-blocking):**
- Origin branches to delete (merged): `worktree-profile-8-config-screen`, `worktree-profile-9-mcp-audit`, `reference/project-identity-key`.
- `transcript-perf Phase 3` is BLOCKED on a post-deploy Safari-timeline re-measurement (needs a browser profiling pass). See `.claude/docs/plan-transcript-switch-perf.md`.
- Deferred bug: ACP safe-tier permission test hangs -- see `.rclaude/project/open/acp-safe-tier-permission-hang.md`.

---

## Quick Health Verification

```bash
docker compose ps                      # broker should be Up (healthy)
curl -sf http://localhost:9999/health  # -> ok
docker exec broker printenv GIT_COMMIT_SHORT   # -> 901cd03a
docker compose logs --tail=100 broker  # startup + migration lines
ps -p 89135 -o pid,command             # sentinel alive (PID from .sentinel.pid)
cat .sentinel.pid                       # current sentinel PID
tail -f .sentinel.log                   # sentinel log
```

Remote (via Caddy on Synology @ 172.20.7.12): `https://concentrator.frst.dev`.
If remote 502s but local `:9999` is healthy, the Caddy upstream IP is stale --
see NETWORK ARCHITECTURE in `.claude/CLAUDE.md` (this machine = 172.20.7.74).

---

## Rollback -- Broker Code

Use if the new broker (`901cd03a`) misbehaves in production.

```bash
cd /Users/jonas/projects/remote-claude
git stash list                                  # ensure nothing precious uncommitted
git checkout f31f249c                            # the previous deployed broker commit
bun run build:broker:docker && docker compose up -d
curl -sf http://localhost:9999/health
git checkout main                                # return working tree to main afterwards
```

**IMPORTANT -- the profile-url-strip migration is FORWARD-ONLY.** It already
rewrote conversation `scope` rows (profile stripped from the URI, moved to the
`resolvedProfile` column). Rolling the broker back to a pre-`c8704b8d` commit is
**NOT data-destructive** (the `resolvedProfile` column persists and is ignored
by old code), but the old broker derives profile from the URI -- so profiled
conversations will display as the `default` profile until you roll forward again.
Prefer fixing forward over rolling back unless the broker is hard-down.

---

## Data Recovery (broker store / SQLite)

Broker data lives in the Docker volume `remote-claude_concentrator-data`
(mounted at `/data/cache`, holds `store.db` + WAL + blobs + terminations NDJSON).

**Hourly backups:** `backups/backup-YYYYMMDD-HHMMSS.tar.gz` (31 retained, ~200MB each).

```bash
# Inspect newest backup
ls -1t backups/*.tar.gz | head

# Restore (DESTRUCTIVE -- overwrites live data; stop broker first):
docker compose down
docker run --rm -v remote-claude_concentrator-data:/data -v "$PWD/backups":/b \
  alpine sh -c 'cd /data && rm -rf ./* && tar xzf /b/<BACKUP_FILE>.tar.gz'
docker compose up -d
curl -sf http://localhost:9999/health
```

Confirm the exact tar layout before restoring (`tar tzf backups/<file>.tar.gz | head`).
NEVER restore without stopping the broker -- a live WAL + overwrite corrupts the DB.

---

## Sentinel Recovery

The sentinel is a host process (not Docker). Current: PID in `.sentinel.pid`.

```bash
# Restart (sanctioned script -- kills the running PID by the pidfile, never pkill):
scripts/start-sentinel.sh --kill-if-running
cat .sentinel.pid && tail -20 .sentinel.log

# Manual stop (use the EXACT pid from the pidfile, never pkill/killall):
kill "$(cat .sentinel.pid)"
```

Restarting the sentinel does NOT kill running agent hosts (conversations are
independent processes holding their own broker WS); it only blips spawn/revive
capability for a moment.

Profile config lives sentinel-local at `~/.config/rclaude/sentinel.json`. The
broker can patch `weight`/`pool`/`label`/`color`/`defaultSelection`/`defaultPool`
via the Phase 8 config screen, but NEVER `configDir`/`env`/`spawnRoot` (those are
host secrets -- edit the JSON or use `sentinel profile add/set` on the host).

---

## If You Lose Connection (to the broker or to this session)

1. The work is SAFE: everything is committed + pushed to `origin/main` at `901cd03a`.
   Nothing lives only in a session.
2. Local config/plans/tasks are versioned via `git-side` (separate local repo).
3. To resume: open the control panel at `https://concentrator.frst.dev`, or check
   broker health locally (`docker compose ps` + `/health`).
4. If the broker is down: `docker compose up -d` from the repo root, then verify
   `/health`. If it crash-loops, read `docker compose logs broker` and roll back
   per the section above.
5. Branch cleanup + transcript-perf Phase 3 are the only open follow-ups; neither
   affects a running system.
