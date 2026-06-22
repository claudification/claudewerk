/**
 * NIGHTSHIFT agent tools -- how a spawned night-run worker (or the night
 * manager) writes the morning report. Every action POSTs one op-envelope to the
 * broker `/api/nightshift` route (Bearer secret), which relays it to the sentinel
 * that owns the project's `.nightshift/` tree. The artifact IS the API.
 *
 * THE SAFE-TO-DO GATE (the whole point): before doing ANY task, decide whether
 * it is safe + plausibly achievable. If not, do NOT bulldoze -- report
 * action=report kind=skipped feasibility=infeasible with a reason, and move on.
 */

import { wsToHttpUrl } from '../../../shared/ws-url'
import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

type Params = Record<string, string>

function splitList(v: string | undefined): string[] | undefined {
  if (!v) return undefined
  const out = v
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean)
  return out.length ? out : undefined
}
function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function buildBody(p: Params): Record<string, unknown> | { error: string } {
  const project = p.project
  if (!project) return { error: 'project (URI) is required' }
  const action = p.action || 'report'
  if (action === 'snapshot') return { project, op: 'snapshot', runId: p.run_id || undefined }
  if (action === 'run_start') {
    if (!p.run_id) return { error: 'run_id is required for run_start' }
    return {
      project,
      op: 'run_start',
      runId: p.run_id,
      runStart: {
        runId: p.run_id,
        taskCount: num(p.task_count),
        window: p.window || undefined,
        digest: p.digest || undefined,
      },
    }
  }
  if (action === 'run_finalize') {
    if (!p.run_id) return { error: 'run_id is required for run_finalize' }
    return {
      project,
      op: 'run_finalize',
      runId: p.run_id,
      finalize: { digest: p.digest || undefined, cost_usd: num(p.cost_usd), runtime_min: num(p.runtime_min) },
    }
  }
  if (action === 'patch') {
    // ACT-ON-RESULTS: patch an existing task's frontmatter in place (no clobber).
    if (!p.run_id) return { error: 'run_id is required for patch' }
    if (!p.id) return { error: 'id is required for patch' }
    return {
      project,
      op: 'task_patch',
      runId: p.run_id,
      taskPatch: {
        id: p.id,
        status: p.status || undefined,
        verdict: p.verdict || undefined,
        tests: p.tests || undefined,
        diffstat: p.diffstat || undefined,
        commits: num(p.commits),
        note: p.note || undefined,
      },
    }
  }
  // action === 'report'
  if (!p.run_id) return { error: 'run_id is required for report' }
  if (!p.id || !p.title) return { error: 'id + title are required for report' }
  const kind = (p.kind || 'task') as 'task' | 'blocked' | 'skipped'
  return {
    project,
    op: 'report',
    runId: p.run_id,
    report: {
      kind,
      id: p.id,
      title: p.title,
      project,
      status: p.status || undefined,
      verdict: p.verdict || undefined,
      feasibility: p.feasibility || undefined,
      branch: p.branch || undefined,
      base: p.base || undefined,
      diffstat: p.diffstat || undefined,
      files: splitList(p.files),
      acceptance: p.acceptance || undefined,
      tests: p.tests || undefined,
      risk: p.risk || undefined,
      profile: p.profile || undefined,
      cost_usd: num(p.cost_usd),
      duration_min: num(p.duration_min),
      taskReport:
        kind === 'task'
          ? {
              recap: p.recap || undefined,
              howToVerify: p.how_to_verify || undefined,
              notes: p.notes || undefined,
              openLoops: splitList(p.open_loops),
            }
          : undefined,
      question: p.question || undefined,
      options: splitList(p.options),
      reason: p.reason || undefined,
    },
  }
}

export function registerNightshiftTools(ctx: McpToolContext): Record<string, ToolDef> {
  async function post(body: Record<string, unknown>) {
    if (ctx.noBroker || !ctx.brokerUrl)
      return { content: [{ type: 'text', text: 'Error: no broker connection' }], isError: true }
    const url = `${wsToHttpUrl(ctx.brokerUrl)}/api/nightshift`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ctx.brokerSecret) headers.Authorization = `Bearer ${ctx.brokerSecret}`
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!json.ok)
        return { content: [{ type: 'text', text: `nightshift error: ${json.error || res.status}` }], isError: true }
      debug(`[channel] nightshift ${String(body.op)} ok`)
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `nightshift request failed: ${(e as Error).message}` }], isError: true }
    }
  }

  return {
    nightshift: {
      description:
        'Write the NIGHTSHIFT morning report for an unattended night run. The artifact (.nightshift/) is the API -- ' +
        'the control panel Result screen renders whatever you report here.\n\n' +
        'THE SAFE-TO-DO GATE: before running any order, judge whether it is safe AND plausibly achievable. If NOT, do ' +
        'not guess or bulldoze -- report it as skipped (kind=skipped, feasibility=infeasible, reason=...) and move on.\n\n' +
        'actions:\n' +
        '- run_start: open a run. run_id=YYYY-MM-DD (required), task_count, window, digest.\n' +
        '- report: write ONE task outcome. run_id + id + title required. kind=task|blocked|skipped (default task).\n' +
        '    task: status (done|errored|spinning|running), verdict (ready-to-review|needs-you|declined), feasibility, ' +
        'branch, diffstat ("+31 -6"), files (comma-sep), tests (pass|fail|none), risk, recap, how_to_verify, notes, open_loops.\n' +
        '    blocked: question (the crisp async question for Jonas), options (comma-sep A/B).\n' +
        '    skipped: reason, feasibility (usually infeasible).\n' +
        '- patch: ACT-ON-RESULTS -- update an EXISTING task in place without re-supplying its other fields. ' +
        'run_id + id required. Set status (integrated|discarded|...), tests, verdict, diffstat, commits, and/or note ' +
        '(a one-line audit line appended to the task body). Use after integrating/testing/discarding a task.\n' +
        '- run_finalize: close the run. run_id required. digest (the night in one glance), cost_usd, runtime_min.\n' +
        '- snapshot: read back the latest (or run_id) report.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: { type: 'string', description: 'Canonical project URI the run belongs to (required).' },
          action: {
            type: 'string',
            enum: ['run_start', 'report', 'patch', 'run_finalize', 'snapshot'],
            description: 'Default: report.',
          },
          run_id: { type: 'string', description: 'Run id, YYYY-MM-DD.' },
          kind: { type: 'string', enum: ['task', 'blocked', 'skipped'], description: 'report lane (default task).' },
          id: { type: 'string', description: 'Task ordinal, e.g. "002".' },
          title: { type: 'string' },
          status: {
            type: 'string',
            enum: ['queued', 'running', 'done', 'blocked', 'errored', 'skipped', 'spinning', 'integrated', 'discarded'],
          },
          verdict: { type: 'string', enum: ['ready-to-review', 'needs-you', 'declined'] },
          feasibility: { type: 'string', enum: ['feasible', 'uncertain', 'infeasible'] },
          branch: { type: 'string' },
          base: { type: 'string' },
          diffstat: { type: 'string', description: 'e.g. "+31 -6".' },
          files: { type: 'string', description: 'Comma-separated changed files.' },
          acceptance: { type: 'string' },
          tests: { type: 'string', enum: ['pass', 'fail', 'none'] },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          profile: { type: 'string', description: 'resolvedProfile the task ran under.' },
          cost_usd: { type: 'string' },
          duration_min: { type: 'string' },
          commits: { type: 'string', description: 'patch: commit count after an integrate.' },
          note: { type: 'string', description: 'patch: one-line audit note appended to the task body.' },
          recap: { type: 'string', description: 'task body: one-paragraph what-it-did.' },
          how_to_verify: { type: 'string', description: 'task body: verify command(s).' },
          notes: { type: 'string', description: 'task body: non-obvious decisions.' },
          open_loops: { type: 'string', description: 'task body: comma/newline-separated follow-ups.' },
          question: { type: 'string', description: 'blocked: the async question for Jonas.' },
          options: { type: 'string', description: 'blocked: comma-separated choices.' },
          reason: { type: 'string', description: 'skipped: why it was declined.' },
          task_count: { type: 'string', description: 'run_start: number of tasks dispatched.' },
          window: { type: 'string', description: 'run_start: scheduling window, e.g. "01:00-07:00".' },
          digest: { type: 'string', description: 'run_start/run_finalize: the night in one glance.' },
          runtime_min: { type: 'string', description: 'run_finalize: wall-clock minutes.' },
        },
        required: ['project'],
      },
      async handle(params: Params) {
        const body = buildBody(params)
        if ('error' in body) return { content: [{ type: 'text', text: `Error: ${body.error}` }], isError: true }
        return post(body)
      },
    },
  }
}
