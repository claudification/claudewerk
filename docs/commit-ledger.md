# Commit ledger

Every git commit, recorded on the broker: which conversation made it, on which
machine, touching which files -- and a link from any hash back to the transcript
that produced it.

## Install

```bash
scripts/install-git-hooks.sh              # this repo
scripts/install-git-hooks.sh ~/some/repo  # any repo
scripts/install-git-hooks.sh --status
scripts/install-git-hooks.sh --uninstall
```

Hooks live in the git **common** dir, so one install covers the main checkout
and every linked worktree under `.claude/worktrees/`.

Any post-commit hook that was already there is preserved as
`post-commit.pre-claudewerk` and still runs, first, **as its own process** --
its shebang, its early `exit`s, and its failures cannot reach the ledger.
Appending instead of dispatching is what broke the first version of this: the
repo's existing git-notes hook ends in `exit 0`, so an appended block never ran.

## Guarantees

| | |
|---|---|
| Never blocks a commit | Guards, then a fully detached subshell; `curl --max-time 3`. A post-commit hook's exit code is already ignored by git, so the only real risk was latency. |
| Never carries a secret | `RCLAUDE_SECRET` + `RCLAUDE_BROKER` come from the environment. Missing either = silent no-op, not an error. |
| Never mandatory | `RCLAUDE_COMMIT_LEDGER=0` disables it with no uninstall. |
| Never truncates silently | A clamped file list (>500) keeps the true `fileCount` and sets `filesTruncated`. |

## Attribution

The hook is a child of whatever ran `git commit`, so an agent's commit inherits
`RCLAUDE_CONVERSATION_ID` from the agent host's environment for free. A commit
made by a human at a terminal has none, and is recorded as `origin=human`.

The broker then enriches from its OWN registry -- profile and conversation name
come from the conversation record, not from whatever the hook's env happened to
carry.

## API

| Route | Answers |
|---|---|
| `POST /api/commits` | ingest (Bearer `RCLAUDE_SECRET`; 202 recorded, 200 duplicate, 401 unauthorized) |
| `GET /api/commits?conversation=<id>` | every commit this conversation made |
| `GET /api/commits?project=<uri>` | every commit in this project -- all worktrees, conversations, machines |
| `GET /api/commits?q=<text>` | FTS5 over message + touched paths |
| `GET /api/commits?path=<substring>` | which commits touched this file |
| `GET /api/commits?origin=agent\|human` | split agent work from human work |
| `GET /api/commits/:hash` | one commit (full hash or >=4-char prefix) |
| `GET /api/commits/:hash/transcript` | **the join** -- conversation + nearest transcript entry at commit time |
| `GET /api/commits/stats` | ledger rollup (admin) |

Reads are permission-filtered per row on the commit's own project URI; a
share-scoped viewer only ever sees their own conversation's commits.

Example -- `git blame` gave you a hash, now get the reasoning:

```bash
curl -sH "Authorization: Bearer $RCLAUDE_SECRET" \
  https://concentrator.frst.dev/api/commits/a1b2c3d4/transcript | jq
```

## Control panel

- **Commits tab** on a conversation, with a live count pill -- what this agent
  actually landed.
- **Recent commits** on the project action panel -- the whole project, every
  worktree, live (no polling).
- **The global browser** (`Cmd+P` -> "COMMITS") -- every commit across the
  fleet, newest first, decluttered by run-length group headers. Chronology is
  the spine; grouping only collapses ADJACENT repeats, so the same project
  appears again further down the timeline whenever time moved on. Each header
  carries the conversation's liveness and clicks through to the project or the
  conversation (ended ones included). A commit opens a detail surface. Both are
  parkable / detachable managed modals.

## Live tiers

Two broadcasts, two threat profiles:

| Frame | Payload | Who gets it |
|---|---|---|
| `commit_count` | `{conversationId, commitCount}` | anyone with `chat:read` on the project -- drives the pill |
| `commit_recorded` | the whole row | only sockets that sent `commit_subscribe {mode:'full'}`, and **never** a share-link guest |

A surface that renders commit rows opts in while mounted and drops back to
counts on unmount, so a phone watching fifteen conversations pays for integers
rather than file lists.

## For agents (MCP)

- `search_commits` -- text / path / project / conversation / origin.
- `commit_context` -- hash -> conversation + transcript position; chains into
  `get_transcript_context({conversationId, aroundSeq})`.

## Data model notes

- Storage is `{cacheDir}/commits.db`, its own WAL database, like `projects.db`.
- Both `repo_uri` (main repo root) and `cwd_uri` (the worktree) are stored, so a
  project query matches whichever URI a conversation happens to carry.
- The **hook** builds those URIs. Path-to-URI conversion is legal host-side; the
  broker only ever compares URIs and never extracts a path back out
  (CWD-IS-INFORMATIONAL, `lint:boundary` Rule 4).
- Amends are detected from `git reflog`, the only precise signal a post-commit
  hook has. Two commits off the same parent are otherwise indistinguishable from
  an amend, and under WORK MODE every worktree branches from main -- so guessing
  would corrupt the ledger. Superseded rows are kept and filtered, not deleted.

## What it is for

- **Forensics.** `git blame` -> hash -> the conversation, the prompt, the failed
  attempts before the fix.
- **Evidence.** An agent claims "shipped"; the commit list is the receipt.
- **Fleet accountability.** `host` + `container` + `profile` answer "which box
  did this land on" after the fact.
- **Regression archaeology.** Every commit that ever touched a file, agent or
  human, across all worktrees, each linked to its reasoning.
