/**
 * Nightshift Store -- path-jailed, project-scoped reader/writer for the
 * `.nightshift/` artifact tree (plan §3). Mirrors src/shared/project-store.ts:
 * pure filesystem + string work, no wire/broker/conversation concepts. Runs
 * wherever the project's files live -- today the SENTINEL (lease-watcher host),
 * so the morning report works with zero live agent hosts.
 *
 * THE ARTIFACT IS THE API: the sentinel writes these files on task report;
 * the Result screen reads them; act-on-results agents get pointed at the folder.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter'
import {
  DEFAULT_NIGHTSHIFT_CONFIG,
  type NightshiftBlocked,
  type NightshiftConfig,
  type NightshiftFeasibility,
  type NightshiftRun,
  type NightshiftRunMeta,
  type NightshiftRunSnapshot,
  type NightshiftRunTotals,
  type NightshiftSkipped,
  type NightshiftTaskMeta,
  type NightshiftTaskPatchInput,
  type NightshiftTaskReport,
  type NightshiftTaskStatus,
  type NightshiftTests,
  type NightshiftVerdict,
} from './nightshift-types'
import { resolveInRoot } from './project-store'

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function nsRoot(root: string): string {
  return join(root, '.nightshift')
}
function runsDir(root: string): string {
  return join(nsRoot(root), 'runs')
}
function runDir(root: string, runId: string): string {
  return join(runsDir(root), safeSegment(runId))
}
function tasksDir(root: string, runId: string): string {
  return join(runDir(root, runId), 'tasks')
}
function blockedDir(root: string, runId: string): string {
  return join(runDir(root, runId), 'blocked')
}

/** Reject path-control characters in an id/slug used as a filesystem segment. */
function safeSegment(seg: string): string {
  const cleaned = (seg || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.]+/, '')
  if (!cleaned) throw new Error('empty path segment')
  return cleaned
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'task'
  )
}

function pad3(id: string | number): string {
  const n = String(id).replace(/[^0-9]/g, '')
  return n.padStart(3, '0').slice(-3) || '000'
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString()
}

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

export function readNightshiftConfig(root: string): NightshiftConfig {
  const file = join(nsRoot(root), 'config.json')
  try {
    if (!existsSync(file)) return { ...DEFAULT_NIGHTSHIFT_CONFIG }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<NightshiftConfig>
    return { ...DEFAULT_NIGHTSHIFT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_NIGHTSHIFT_CONFIG }
  }
}

export function writeNightshiftConfig(root: string, config: NightshiftConfig): void {
  mkdirSync(nsRoot(root), { recursive: true })
  writeFileSync(join(nsRoot(root), 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// Coercion: frontmatter strings -> typed meta
// ---------------------------------------------------------------------------

const TASK_STATUS_VALUES: NightshiftTaskStatus[] = [
  'queued',
  'running',
  'done',
  'blocked',
  'errored',
  'skipped',
  'spinning',
  'integrated',
  'discarded',
]
const VERDICT_VALUES: NightshiftVerdict[] = ['ready-to-review', 'needs-you', 'declined']
const FEASIBILITY_VALUES: NightshiftFeasibility[] = ['feasible', 'uncertain', 'infeasible']
const TESTS_VALUES: NightshiftTests[] = ['pass', 'fail', 'none']

function asEnum<T extends string>(val: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(val as T) ? (val as T) : fallback
}
function asNum(val: unknown): number | undefined {
  if (val === undefined || val === null || val === '') return undefined
  const n = Number(val)
  return Number.isFinite(n) ? n : undefined
}
function asStr(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined
  const s = String(val).trim()
  return s.length ? s : undefined
}
function asArr(val: unknown): string[] | undefined {
  if (Array.isArray(val)) return val.map(String).filter(Boolean)
  const s = asStr(val)
  return s ? [s] : undefined
}

function coerceTaskMeta(meta: Record<string, unknown>, fallbackId: string): NightshiftTaskMeta {
  return {
    id: asStr(meta.id) ?? fallbackId,
    title: asStr(meta.title) ?? fallbackId,
    project: asStr(meta.project) ?? '',
    status: asEnum(meta.status, TASK_STATUS_VALUES, 'done'),
    verdict: asEnum(meta.verdict, VERDICT_VALUES, 'needs-you'),
    feasibility: asEnum(meta.feasibility, FEASIBILITY_VALUES, 'feasible'),
    branch: asStr(meta.branch),
    base: asStr(meta.base),
    commits: asNum(meta.commits),
    diffstat: asStr(meta.diffstat),
    files: asArr(meta.files),
    acceptance: asStr(meta.acceptance),
    tests: meta.tests === undefined ? undefined : asEnum(meta.tests, TESTS_VALUES, 'none'),
    risk: asStr(meta.risk) as NightshiftTaskMeta['risk'],
    profile: asStr(meta.profile),
    reroutes: asNum(meta.reroutes),
    attempts: asNum(meta.attempts),
    tokens: asNum(meta.tokens),
    cost_usd: asNum(meta.cost_usd),
    duration_min: asNum(meta.duration_min),
    created: asStr(meta.created) ?? '',
  }
}

// ---------------------------------------------------------------------------
// Task files (runs/<runId>/tasks/NNN-slug.md)
// ---------------------------------------------------------------------------

function taskBody(report: NightshiftTaskReport): string {
  const openLoops = report.openLoops?.length ? report.openLoops.map(l => `- ${l}`).join('\n') : '- none'
  return [
    '## What it did',
    report.recap?.trim() || '_no recap_',
    '',
    '## How to verify',
    report.howToVerify?.trim() || '_n/a_',
    '',
    '## Notes / decisions',
    report.notes?.trim() || '_none_',
    '',
    '## Open loops',
    openLoops,
  ].join('\n')
}

/** Frontmatter in the canonical §3 field order (undefined fields drop out). */
function taskFrontmatter(meta: NightshiftTaskMeta): Record<string, unknown> {
  return {
    id: meta.id,
    title: meta.title,
    project: meta.project,
    status: meta.status,
    verdict: meta.verdict,
    feasibility: meta.feasibility,
    branch: meta.branch,
    base: meta.base,
    commits: meta.commits,
    diffstat: meta.diffstat,
    files: meta.files,
    acceptance: meta.acceptance,
    tests: meta.tests,
    risk: meta.risk,
    profile: meta.profile,
    reroutes: meta.reroutes,
    attempts: meta.attempts,
    tokens: meta.tokens,
    cost_usd: meta.cost_usd,
    duration_min: meta.duration_min,
    created: meta.created,
  }
}

export interface WriteTaskInput extends Omit<NightshiftTaskMeta, 'created'> {
  created?: string
  report?: NightshiftTaskReport
}

/**
 * Write (create/overwrite) a task artifact. File name is `NNN-<slug>.md` where
 * the slug is derived from the title. Returns the persisted meta.
 */
export function writeTask(root: string, runId: string, input: WriteTaskInput, nowMs: number): NightshiftTaskMeta {
  const dir = tasksDir(root, runId)
  mkdirSync(dir, { recursive: true })
  const meta: NightshiftTaskMeta = { ...input, created: input.created ?? nowIso(nowMs) }
  const file = join(dir, `${pad3(meta.id)}-${slugify(meta.title)}.md`)
  const content = serializeFrontmatter(taskFrontmatter(meta), taskBody(input.report ?? {}))
  // Path-jail belt-and-suspenders: confirm the resolved file stays under root.
  resolveInRoot(root, file.slice(root.length))
  writeFileSync(file, content, 'utf8')
  return meta
}

function readTaskFile(dir: string, filename: string): NightshiftTaskMeta | null {
  try {
    const content = readFileSync(join(dir, filename), 'utf8')
    const { meta } = parseFrontmatter(content)
    const fallbackId = filename.replace(/\.md$/, '').split('-')[0] || filename
    return coerceTaskMeta(meta, fallbackId)
  } catch {
    return null
  }
}

export function listRunTasks(root: string, runId: string): NightshiftTaskMeta[] {
  const dir = tasksDir(root, runId)
  const out: NightshiftTaskMeta[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const t = readTaskFile(dir, f)
      if (t) out.push(t)
    }
  } catch {
    /* no tasks dir yet */
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** Locate the task file for an id (matches the `NNN-` prefix). */
function findTaskFile(root: string, runId: string, id: string): string | null {
  const dir = tasksDir(root, runId)
  const prefix = `${pad3(id)}-`
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.md') && f.startsWith(prefix)) return join(dir, f)
    }
  } catch {
    /* no tasks dir */
  }
  return null
}

/**
 * Append a one-line audit note to the body's "Notes / decisions" section,
 * replacing the `_none_` placeholder if that's all that's there.
 */
function appendNote(body: string, note: string): string {
  const heading = '## Notes / decisions'
  const idx = body.indexOf(heading)
  const line = `- ${note.replace(/\n+/g, ' ').trim()}`
  if (idx === -1) return `${body.trimEnd()}\n\n${heading}\n${line}\n`
  const after = idx + heading.length
  const rest = body.slice(after)
  // The next section heading (if any) bounds this section.
  const nextIdx = rest.indexOf('\n## ')
  const section = nextIdx === -1 ? rest : rest.slice(0, nextIdx)
  const tail = nextIdx === -1 ? '' : rest.slice(nextIdx)
  const cleaned = section.replace(/^\s*_none_\s*$/m, '').trimEnd()
  const rebuilt = `${cleaned ? `${cleaned}\n${line}` : `\n${line}`}\n`
  return `${body.slice(0, after)}${rebuilt}${tail}`
}

/**
 * Patch an existing task artifact in place (ACT-ON-RESULTS, plan §4). Reads the
 * file, merges only the provided frontmatter scalars, optionally appends an audit
 * note to "Notes / decisions", and rewrites. Returns the updated meta, or null
 * when no task file matches the id. `nowMs` is accepted for signature symmetry
 * with the other writers (the patch never resets `created`).
 */
export function patchTask(
  root: string,
  runId: string,
  patch: NightshiftTaskPatchInput,
  _nowMs: number,
): NightshiftTaskMeta | null {
  const file = findTaskFile(root, runId, patch.id)
  if (!file) return null
  let parsed: { meta: Record<string, unknown>; body: string }
  try {
    parsed = parseFrontmatter(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const current = coerceTaskMeta(parsed.meta, patch.id)
  const merged: NightshiftTaskMeta = {
    ...current,
    status: patch.status ?? current.status,
    verdict: patch.verdict ?? current.verdict,
    tests: patch.tests ?? current.tests,
    diffstat: patch.diffstat ?? current.diffstat,
    commits: patch.commits ?? current.commits,
    reroutes: patch.reroutes ?? current.reroutes,
    attempts: patch.attempts ?? current.attempts,
  }
  const body = patch.note ? appendNote(parsed.body, patch.note) : parsed.body
  writeFileSync(file, serializeFrontmatter(taskFrontmatter(merged), body.trimEnd()), 'utf8')
  return merged
}

// ---------------------------------------------------------------------------
// Blocked lane (runs/<runId>/blocked/NNN-slug.md)
// ---------------------------------------------------------------------------

export interface WriteBlockedInput extends Omit<NightshiftBlocked, 'created' | 'body'> {
  created?: string
  body?: string
}

export function writeBlocked(root: string, runId: string, input: WriteBlockedInput, nowMs: number): NightshiftBlocked {
  const dir = blockedDir(root, runId)
  mkdirSync(dir, { recursive: true })
  const created = input.created ?? nowIso(nowMs)
  const body = input.body?.trim() || input.question
  const fm = {
    id: input.id,
    title: input.title,
    project: input.project,
    question: input.question,
    options: input.options,
    created,
  }
  const file = join(dir, `${pad3(input.id)}-${slugify(input.title)}.md`)
  writeFileSync(file, serializeFrontmatter(fm, body), 'utf8')
  return { ...input, created, body }
}

function readBlockedFile(dir: string, filename: string): NightshiftBlocked | null {
  try {
    const content = readFileSync(join(dir, filename), 'utf8')
    const { meta, body } = parseFrontmatter(content)
    const fallbackId = filename.replace(/\.md$/, '').split('-')[0] || filename
    return {
      id: asStr(meta.id) ?? fallbackId,
      title: asStr(meta.title) ?? fallbackId,
      project: asStr(meta.project) ?? '',
      question: asStr(meta.question) ?? body,
      options: asArr(meta.options),
      created: asStr(meta.created) ?? '',
      body,
    }
  } catch {
    return null
  }
}

export function listRunBlocked(root: string, runId: string): NightshiftBlocked[] {
  const dir = blockedDir(root, runId)
  const out: NightshiftBlocked[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const b = readBlockedFile(dir, f)
      if (b) out.push(b)
    }
  } catch {
    /* no blocked dir */
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// Skipped lane (runs/<runId>/skipped.md -- single append-only file)
// ---------------------------------------------------------------------------

function skippedFile(root: string, runId: string): string {
  return join(runDir(root, runId), 'skipped.md')
}

function renderSkippedEntry(s: NightshiftSkipped): string {
  return [
    `### ${pad3(s.id)} ${s.title}`,
    `- project: ${s.project}`,
    `- feasibility: ${s.feasibility}`,
    `- reason: ${s.reason.replace(/\n+/g, ' ').trim()}`,
    '',
  ].join('\n')
}

/** Append a declined task to skipped.md (creating it with a header if needed). */
export function appendSkipped(
  root: string,
  runId: string,
  input: Omit<NightshiftSkipped, 'created'> & { created?: string },
  nowMs: number,
): NightshiftSkipped {
  mkdirSync(runDir(root, runId), { recursive: true })
  const file = skippedFile(root, runId)
  const entry: NightshiftSkipped = { ...input, created: input.created ?? nowIso(nowMs) }
  const header = '# Skipped\n\nTasks the nightshift declined and why (trust isn’t eroded by silent drops).\n\n'
  const prefix = existsSync(file) ? readFileSync(file, 'utf8') : header
  writeFileSync(file, `${prefix}${renderSkippedEntry(entry)}\n`, 'utf8')
  return entry
}

export function listRunSkipped(root: string, runId: string): NightshiftSkipped[] {
  const file = skippedFile(root, runId)
  if (!existsSync(file)) return []
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: NightshiftSkipped[] = []
  const sections = content.split(/^### /m).slice(1)
  for (const sec of sections) {
    const lines = sec.split('\n')
    const head = lines[0]?.match(/^(\S+)\s+(.*)$/)
    if (!head) continue
    const bullets: Record<string, string> = {}
    for (const line of lines.slice(1)) {
      const m = line.match(/^-\s+([a-z]+):\s*(.*)$/)
      if (m) bullets[m[1]] = m[2].trim()
    }
    out.push({
      id: head[1],
      title: head[2].trim(),
      project: bullets.project ?? '',
      reason: bullets.reason ?? '',
      feasibility: asEnum(bullets.feasibility, FEASIBILITY_VALUES, 'infeasible'),
      created: '',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// run.md (run-level frontmatter + digest body) + latest symlink
// ---------------------------------------------------------------------------

function runFile(root: string, runId: string): string {
  return join(runDir(root, runId), 'run.md')
}

function runFrontmatter(meta: NightshiftRunMeta): Record<string, unknown> {
  return {
    runId: meta.runId,
    date: meta.date,
    status: meta.status,
    ready: meta.totals.ready,
    blocked: meta.totals.blocked,
    skipped: meta.totals.skipped,
    errored: meta.totals.errored,
    taskCount: meta.taskCount,
    runtime_min: meta.runtime_min,
    cost_usd: meta.cost_usd,
    profiles: meta.profiles,
    window: meta.window,
    created: meta.created,
    finished: meta.finished,
  }
}

function coerceRun(meta: Record<string, unknown>, body: string, fallbackRunId: string): NightshiftRun {
  const totals: NightshiftRunTotals = {
    ready: asNum(meta.ready) ?? 0,
    blocked: asNum(meta.blocked) ?? 0,
    skipped: asNum(meta.skipped) ?? 0,
    errored: asNum(meta.errored) ?? 0,
  }
  return {
    runId: asStr(meta.runId) ?? fallbackRunId,
    date: asStr(meta.date) ?? fallbackRunId,
    status: meta.status === 'done' ? 'done' : 'running',
    totals,
    taskCount: asNum(meta.taskCount) ?? 0,
    runtime_min: asNum(meta.runtime_min),
    cost_usd: asNum(meta.cost_usd),
    profiles: asArr(meta.profiles),
    window: asStr(meta.window),
    created: asStr(meta.created) ?? '',
    finished: asStr(meta.finished),
    digest: body.trim(),
  }
}

/** Point `latest` at runs/<runId> (relative symlink, replacing any prior). */
function updateLatest(root: string, runId: string): void {
  const link = join(nsRoot(root), 'latest')
  const target = join('runs', safeSegment(runId))
  try {
    if (existsSync(link) || isSymlink(link)) rmSync(link, { force: true })
    symlinkSync(target, link)
  } catch {
    /* symlink unsupported (rare) -- readers fall back to newest dir */
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export interface StartRunInput {
  runId: string
  date?: string
  taskCount?: number
  window?: string
  digest?: string
}

/**
 * Create (or no-op return) a run dir, its tasks/blocked subdirs, run.md
 * (status=running), and repoint `latest`. Idempotent: a second call for the
 * same runId returns the existing run unchanged.
 */
export function startRun(root: string, input: StartRunInput, nowMs: number): NightshiftRun {
  const runId = input.runId
  const existing = readNightshiftRun(root, runId)
  if (existing) return existing
  mkdirSync(tasksDir(root, runId), { recursive: true })
  mkdirSync(blockedDir(root, runId), { recursive: true })
  const meta: NightshiftRunMeta = {
    runId,
    date: input.date ?? runId,
    status: 'running',
    totals: { ready: 0, blocked: 0, skipped: 0, errored: 0 },
    taskCount: input.taskCount ?? 0,
    window: input.window,
    created: nowIso(nowMs),
  }
  const digest = input.digest?.trim() || '_run in progress_'
  writeFileSync(runFile(root, runId), serializeFrontmatter(runFrontmatter(meta), digest), 'utf8')
  updateLatest(root, runId)
  return { ...meta, digest }
}

export interface FinalizeRunPatch {
  digest?: string
  runtime_min?: number
  cost_usd?: number
  profiles?: string[]
  taskCount?: number
}

/**
 * Recompute totals from the on-disk task/blocked/skipped files, flip run.md to
 * status=done, and apply the digest/runtime/cost patch. Returns the final run.
 */
export function finalizeRun(root: string, runId: string, patch: FinalizeRunPatch, nowMs: number): NightshiftRun | null {
  const run = readNightshiftRun(root, runId)
  if (!run) return null
  const tasks = listRunTasks(root, runId)
  const totals: NightshiftRunTotals = {
    ready: tasks.filter(t => t.verdict === 'ready-to-review').length,
    blocked: listRunBlocked(root, runId).length,
    skipped: listRunSkipped(root, runId).length,
    errored: tasks.filter(t => t.status === 'errored').length,
  }
  const meta: NightshiftRunMeta = {
    ...run,
    status: 'done',
    totals,
    taskCount: patch.taskCount ?? run.taskCount,
    runtime_min: patch.runtime_min ?? run.runtime_min,
    cost_usd: patch.cost_usd ?? run.cost_usd,
    profiles: patch.profiles ?? run.profiles,
    finished: nowIso(nowMs),
  }
  const digest = patch.digest?.trim() || run.digest
  writeFileSync(runFile(root, runId), serializeFrontmatter(runFrontmatter(meta), digest), 'utf8')
  return { ...meta, digest }
}

export function readNightshiftRun(root: string, runId: string): NightshiftRun | null {
  const file = runFile(root, runId)
  if (!existsSync(file)) return null
  try {
    const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'))
    return coerceRun(meta, body, runId)
  } catch {
    return null
  }
}

/** All run ids (dir names under runs/), newest first by name (dates sort lexically). */
export function listRunIds(root: string): string[] {
  try {
    return readdirSync(runsDir(root), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** Resolve the latest runId: follow the `latest` symlink, else newest run dir. */
export function resolveLatestRunId(root: string): string | null {
  const link = join(nsRoot(root), 'latest')
  if (isSymlink(link)) {
    try {
      const target = readlinkSync(link)
      const id = target.replace(/^runs[/\\]/, '').replace(/[/\\]$/, '')
      if (id && existsSync(runFile(root, id))) return id
    } catch {
      /* dangling symlink -- fall through */
    }
  }
  const ids = listRunIds(root)
  return ids.find(id => existsSync(runFile(root, id))) ?? null
}

export function readRunSnapshot(root: string, runId: string): NightshiftRunSnapshot | null {
  const run = readNightshiftRun(root, runId)
  if (!run) return null
  return {
    run,
    tasks: listRunTasks(root, runId),
    blocked: listRunBlocked(root, runId),
    skipped: listRunSkipped(root, runId),
  }
}

/** The Result screen's payload: the latest run only (older runs stay folders). */
export function readLatestSnapshot(root: string): NightshiftRunSnapshot | null {
  const runId = resolveLatestRunId(root)
  return runId ? readRunSnapshot(root, runId) : null
}
