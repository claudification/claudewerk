/**
 * Sentinel-side git-fabric scan (SOTU Phase 2). The broker asks (via the
 * `git_fabric_request` RPC) for the integration + mergeability state of every
 * worktree/branch in a project; the sentinel owns the host filesystem, runs the
 * proven ladder, and returns a structured `GitFabric` snapshot.
 *
 * THE LADDER (one `merge-tree` answers integrated? / merge-risk? / which files?):
 *   for each branch B vs base (origin/main, or local main when origin is absent):
 *     ahead  = rev-list --count base..B
 *     behind = rev-list --count B..base
 *     ahead == 0   -> INTEGRATED  (work absorbed; decays)
 *     behind == 0  -> FF-CLEAN    (trivial fast-forward, zero risk)
 *     else         -> merge-tree --write-tree --name-only base B
 *                       rc == 0   -> MERGE-CLEAN
 *                       rc != 0   -> CONFLICTS, files = parse(stdout)
 *   ahead/behind are ALSO reported vs local main (the BOTH requirement).
 *
 * RELIABILITY: this is a hot multi-worktree repo -- refs MUTATE mid-scan (a ref
 * listed by for-each-ref can vanish from rev-parse seconds later). EVERY ref is
 * guarded with `rev-parse --verify` before use; a vanished ref is skipped, never
 * fatal. NEVER `git cherry` (patch-id lies on squash/rebase merges). The scan is
 * a timestamped snapshot: `scannedAt` + `fetchedAt` ("origin/main as of <t>").
 *
 * The pure helpers (parse + derive) are exported for unit testing without a repo.
 */

import { statSync } from 'node:fs'
import type { BranchFabric, GitAlert, GitFabric, IntegrationStatus } from '../shared/protocol'

/** A branch that drifts this far behind origin/main while still carrying its own
 *  unmerged commits is "rotting" -- the STALLED alert. The design's example was a
 *  branch "165 behind". Liveness (idle conv) sharpens this in the Phase-4 decay. */
const STALE_BEHIND_THRESHOLD = 50
/** Pathological-repo guard: cap how many local heads one scan walks. */
const MAX_BRANCHES = 200

export interface GitFabricOutcome {
  fabric?: GitFabric
  error?: string
}

// ─── Pure parsers / derivations (unit-tested, no git required) ──────

export interface WorktreeEntry {
  path: string
  head?: string
  /** Short branch name (refs/heads/X -> X). Absent when detached. */
  branch?: string
  detached?: boolean
}

/** Parse `git worktree list --porcelain` into entries. Records are blank-line
 *  separated; each line is `<key> <value>` (or the bare word `detached`). */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of porcelain.split('\n\n')) {
    const entry = parseWorktreeBlock(block)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Parse one blank-line-delimited porcelain record into an entry (null when the
 *  block has no `worktree` line, e.g. a trailing empty split). */
function parseWorktreeBlock(block: string): WorktreeEntry | null {
  let entry: WorktreeEntry | null = null
  for (const raw of block.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('worktree ')) entry = { path: line.slice('worktree '.length) }
    else if (!entry) continue
    else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) entry.branch = shortRef(line.slice('branch '.length))
    else if (line === 'detached') entry.detached = true
  }
  return entry
}

/** `refs/heads/foo` -> `foo`; anything else returned verbatim. */
export function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/** Parse `git merge-tree --write-tree --name-only` stdout into the conflicting
 *  paths. The output is SECTIONED: line 1 is the tree OID; lines 2..first-blank
 *  are the conflicting paths (THE list); everything after the blank is
 *  Auto-merging/CONFLICT narration (ignored). Equivalent to the proven
 *  `awk 'NR>1{if($0=="")exit;print}'`. */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const lines = stdout.split('\n')
  const files: string[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') break
    if (line.trim()) files.push(line)
  }
  return files
}

/** Classify a branch's integration vs the base. `mergeTreeRc` is consulted ONLY
 *  in the diverged case (ahead>0 && behind>0); pass null when merge-tree was not
 *  run (it never needs to be for integrated/ff-clean). */
export function deriveIntegration(ahead: number, behind: number, mergeTreeRc: number | null): IntegrationStatus {
  if (ahead === 0) return 'integrated'
  if (behind === 0) return 'ff-clean'
  return mergeTreeRc === 0 ? 'merge-clean' : 'conflicts'
}

export interface AlertInputs {
  integration: IntegrationStatus
  /** Worktree has uncommitted changes. */
  dirty: boolean
  /** This branch IS local main/master (the unpushed check targets it). */
  isMain: boolean
  /** Commits on local main not yet on origin/main (the unpushed signal). */
  aheadOrigin: number
  /** Commits on origin/main missing from this branch (the staleness signal). */
  behindOrigin: number
}

/** Derive the escalation alerts from git truth alone. The sentinel never sees
 *  conversation liveness, so the "dead/idle conv" sharpening of at-risk/stalled
 *  is layered later by the Phase-4 decay pass -- here we emit the git-observable
 *  floor: dirty=>at-risk, local-main-ahead=>unpushed, far-behind-unmerged=>stalled. */
export function deriveAlerts({ integration, dirty, isMain, aheadOrigin, behindOrigin }: AlertInputs): GitAlert[] {
  const alerts: GitAlert[] = []
  if (dirty) alerts.push('at-risk')
  if (isMain && aheadOrigin > 0) alerts.push('unpushed')
  if (!isMain && integration !== 'integrated' && behindOrigin >= STALE_BEHIND_THRESHOLD) alerts.push('stalled')
  return alerts
}

// ─── Git I/O orchestrator ───────────────────────────────────────────

interface RunResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

/** One `git -C cwd <args>` invocation. Never throws -- returns a structured
 *  result so the ladder can guard each ref and treat a vanished ref as a skip. */
function git(cwd: string, args: string[]): RunResult {
  try {
    const proc = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
    return {
      ok: proc.exitCode === 0,
      exitCode: proc.exitCode ?? -1,
      stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : '',
      stderr: proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : '',
    }
  } catch (err) {
    return { ok: false, exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

/** Verify a ref exists RIGHT NOW and return its OID, or undefined if it vanished
 *  / never existed. The mid-scan mutation guard -- called before every ref use. */
function verifyRef(cwd: string, ref: string): string | undefined {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.ok ? r.stdout.trim() || undefined : undefined
}

/** `git rev-list --count A..B`, 0 on any failure (a vanished endpoint = skip). */
function revListCount(cwd: string, range: string): number {
  const r = git(cwd, ['rev-list', '--count', range])
  if (!r.ok) return 0
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/** FETCH_HEAD mtime in the common git dir -- "origin/main as of <t>". Undefined
 *  when the repo was never fetched (no integration-freshness claim possible). */
function readFetchedAt(cwd: string): number | undefined {
  const r = git(cwd, ['rev-parse', '--git-common-dir'])
  if (!r.ok) return undefined
  const dir = r.stdout.trim()
  if (!dir) return undefined
  const abs = dir.startsWith('/') ? dir : `${cwd}/${dir}`
  try {
    return statSync(`${abs}/FETCH_HEAD`).mtimeMs
  } catch {
    return undefined
  }
}

/** The integration base preference: origin/main, falling back to the local
 *  default branch when origin is absent (local-only repo). `viaOrigin` records
 *  whether the fetch-freshness stamp is meaningful. */
function resolveBase(cwd: string): { base: string; oid: string; viaOrigin: boolean; mainBranch?: string } | null {
  const originMain = verifyRef(cwd, 'origin/main')
  const localMainBranch = verifyRef(cwd, 'main') ? 'main' : verifyRef(cwd, 'master') ? 'master' : undefined
  if (originMain) return { base: 'origin/main', oid: originMain, viaOrigin: true, mainBranch: localMainBranch }
  if (localMainBranch) {
    const oid = verifyRef(cwd, localMainBranch)
    if (oid) return { base: localMainBranch, oid, viaOrigin: false, mainBranch: localMainBranch }
  }
  return null
}

/** List local branch names (short), capped, newest-committed first. */
function listBranches(cwd: string): string[] {
  const r = git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'])
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, MAX_BRANCHES)
}

/** Whether a worktree path has uncommitted changes. Failure (path gone) = clean. */
function isDirty(worktreePath: string): boolean {
  const r = git(worktreePath, ['status', '--porcelain'])
  return r.ok && r.stdout.trim().length > 0
}

/** Dry-run the merge in memory for a diverged branch. NO 2>&1 (stderr stays
 *  separate); merge-tree never touches the working tree or index, always safe.
 *  Returns the rc (for deriveIntegration) + the conflict files (empty when clean). */
function probeMerge(cwd: string, base: string, branch: string): { rc: number; conflictFiles: string[] } {
  const mt = git(cwd, ['merge-tree', '--write-tree', '--name-only', base, branch])
  return { rc: mt.exitCode, conflictFiles: mt.ok ? [] : parseMergeTreeConflicts(mt.stdout) }
}

interface BranchCounts {
  aheadOrigin: number
  behindOrigin: number
  aheadLocal: number
  behindLocal: number
}

/** ahead/behind vs the integration base (origin/main) AND local main -- the BOTH
 *  requirement. Local counts are 0 when there is no local main or it IS this branch. */
function gatherCounts(cwd: string, branch: string, base: { base: string; mainBranch?: string }): BranchCounts {
  const aheadOrigin = revListCount(cwd, `${base.base}..${branch}`)
  const behindOrigin = revListCount(cwd, `${branch}..${base.base}`)
  const m = base.mainBranch
  if (!m || m === branch) return { aheadOrigin, behindOrigin, aheadLocal: 0, behindLocal: 0 }
  return {
    aheadOrigin,
    behindOrigin,
    aheadLocal: revListCount(cwd, `${m}..${branch}`),
    behindLocal: revListCount(cwd, `${branch}..${m}`),
  }
}

/** Build the BranchFabric for one branch, or null if the ref vanished mid-scan. */
function scanBranch(
  cwd: string,
  branch: string,
  base: { base: string; oid: string; mainBranch?: string },
  worktree: WorktreeEntry | undefined,
): BranchFabric | null {
  // Guard: the ref may have moved/vanished since for-each-ref listed it.
  if (!verifyRef(cwd, `refs/heads/${branch}`)) return null

  const c = gatherCounts(cwd, branch, base)
  // The ladder only needs merge-tree in the diverged case (ahead>0 && behind>0).
  const diverged = c.aheadOrigin > 0 && c.behindOrigin > 0
  const merge = diverged ? probeMerge(cwd, base.base, branch) : null
  const integration = deriveIntegration(c.aheadOrigin, c.behindOrigin, merge ? merge.rc : null)
  const dirty = worktree ? isDirty(worktree.path) : false
  const alerts = deriveAlerts({
    integration,
    dirty,
    isMain: branch === base.mainBranch,
    aheadOrigin: c.aheadOrigin,
    behindOrigin: c.behindOrigin,
  })

  const bf: BranchFabric = { branch, ...c, integration, alerts }
  if (worktree) {
    bf.worktree = worktree.path
    bf.dirty = dirty
  }
  if (merge && merge.conflictFiles.length) bf.conflictFiles = merge.conflictFiles
  return bf
}

/** Run the full git-fabric ladder in `cwd`. Never throws -- returns
 *  `{ error }` when `cwd` is not a git repo or the base ref is missing. */
// fallow-ignore-next-line complexity
export function runGitFabric(cwd: string, now: number = Date.now()): GitFabricOutcome {
  if (!cwd) return { error: 'no cwd' }
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) return { error: inside.stderr || 'not a git repository' }

  const base = resolveBase(cwd)
  if (!base) return { error: 'no integration base (origin/main, main or master not found)' }

  const worktrees = parseWorktreeList(git(cwd, ['worktree', 'list', '--porcelain']).stdout)
  const byBranch = new Map<string, WorktreeEntry>()
  for (const w of worktrees) if (w.branch) byBranch.set(w.branch, w)

  const branches: BranchFabric[] = []
  for (const branch of listBranches(cwd)) {
    const bf = scanBranch(cwd, branch, base, byBranch.get(branch))
    if (bf) branches.push(bf)
  }

  return {
    fabric: {
      branches,
      scannedAt: now,
      ...(base.viaOrigin ? { fetchedAt: readFetchedAt(cwd) } : {}),
    },
  }
}
