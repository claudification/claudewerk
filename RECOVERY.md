# Staging Deployment Recovery

Staging runs the `feat/project-uri` branch on port 19999 alongside prod on 9999.
Zero changes to prod. Everything is env-var driven.

## What's Running

| System | Port | Container | Volume | Branch |
|---|---|---|---|---|
| **Prod** | 9999 | `concentrator` | `concentrator-data` | `main` |
| **Staging** | 19999 | `concentrator-staging` | `concentrator-staging-data` | `feat/project-uri` |

## Staging Compose File

`docker-compose.staging.yml` in the worktree at `/Users/jonas/projects/remote-claude-project-uri/`.
Uses project name `rclaude-staging` to fully isolate from prod.

## Start Staging

```bash
cd /Users/jonas/projects/remote-claude-project-uri
bun run build
docker compose -f docker-compose.staging.yml up -d --build
```

## Connect to Staging

```bash
# Agent Host (interactive session)
RCLAUDE_CONCENTRATOR=ws://localhost:19999 rclaude

# Sentinel
RCLAUDE_CONCENTRATOR=ws://localhost:19999 scripts/start-sentinel.sh

# Dashboard
open http://localhost:19999
```

## Stop Staging (keep data)

```bash
cd /Users/jonas/projects/remote-claude-project-uri
docker compose -f docker-compose.staging.yml down
```

## Full Teardown (nuke everything)

```bash
cd /Users/jonas/projects/remote-claude-project-uri
docker compose -f docker-compose.staging.yml down -v   # -v removes the volume
docker rmi rclaude-staging-concentrator 2>/dev/null     # remove the image
```

## Verify Prod Is Untouched

```bash
docker ps --format '{{.Names}} {{.Ports}}' | grep concentrator
# Should show:
#   concentrator        0.0.0.0:9999->9999/tcp
#   concentrator-staging 0.0.0.0:19999->9999/tcp

# Prod health check
curl -s http://localhost:9999/health | jq

# Staging health check
curl -s http://localhost:19999/health | jq
```

## If Something Goes Wrong

### Staging won't start
```bash
docker compose -f docker-compose.staging.yml logs
```

### Staging interfered with prod (should not happen)
```bash
# Nuke staging
docker compose -f docker-compose.staging.yml down -v

# Verify prod is still running
docker ps | grep concentrator
# If not, restart prod from the main repo:
cd /Users/jonas/projects/remote-claude
docker compose up -d
```

### Need to rebuild staging after code changes
```bash
cd /Users/jonas/projects/remote-claude-project-uri
bun run build
docker compose -f docker-compose.staging.yml up -d --build
```

### Rollback to pre-URI state
The git tag `pre-project-uri` marks the last commit before the URI migration.
The Docker image `remote-claude-concentrator:pre-project-uri` is the matching container image.
```bash
git checkout pre-project-uri
```

## Worktree Location

`/Users/jonas/projects/remote-claude-project-uri` on branch `feat/project-uri`.
Do NOT delete this worktree while staging is running -- the Docker build context points here.

## Key Differences from Prod

- Wire protocol: `cwd` removed, `project` (URI) is sole identity
- Wire messages: `agent_*` renamed to `sentinel_*`
- API routes: `/agent/*` renamed to `/sentinel/*`
- Binary: `bin/rclaude-agent` renamed to `bin/sentinel`
- DB schema: `cwd` columns dropped on startup (migration runs automatically)
- Fresh SQLite DBs in staging volume (no session history from prod)
