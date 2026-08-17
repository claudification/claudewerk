/**
 * `epic_run` -- start, inspect, pause or abort an EPIC RUN.
 *
 * Deliberately has NO spawn verb. The engine owns dispatch: a tool that could
 * spawn an epic worker directly would bypass the DAG gate, the concurrency
 * ceiling and the overseer lease -- every safety property of the run, in one
 * call. If you want work to start, arm the run and let the beat decide.
 *
 * Mirrors the quest/nightshift MCP idiom: one POST to a broker route, because
 * the agent host has no sentinel of its own to ask.
 */

import { wsToHttpUrl } from '../../../shared/ws-url'
import { debug } from '../debug'
import type { McpToolContext, ToolDef, ToolResult } from './types'

const DESCRIPTION = [
  'Start / inspect / pause / abort an EPIC RUN: the engine plans AND executes a whole epic unattended.',
  'It dispatches one implementer per ready card (ordered by depends_on), sends an independent VERIFIER',
  'over every finished card, and wakes a single OVERSEER between beats -- the only seat that may ask a human.',
  '',
  'action=start   arm (or resume) the run. `cadence` "now" ignores the clock; "window" defers dispatch to',
  '               the project night window. `concurrency` defaults to 3 -- that is a REVIEW ceiling, not a',
  '               machine one; raising it means choosing to stop reviewing per-change.',
  'action=get     run state + digest + the baton tail (what the run remembers about itself).',
  'action=pause   stop dispatching, release the overseer lease. A later start RESUMES; it never resets the',
  '               generation counter.',
  'action=abort   terminal, with `reason` recorded in the append-only baton.',
].join('\n')

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

interface EpicRunPayload {
  ok?: boolean
  error?: string
  run?: {
    epicId: string
    status: string
    gen: number
    maxGens: number
    cadence: string
    target: string
    concurrency: number
    dryGens: number
    abortReason?: string
    digest: string
  } | null
  baton?: Array<{ ts: string; kind: string; cardId?: string; body: string }>
}

/** Human-readable, because this is read by an agent deciding what to do next --
 *  a JSON dump would make it re-derive the same summary every time. */
function render(json: EpicRunPayload): string {
  const run = json.run
  if (!run) return 'No run for this epic yet. Use action=start to arm one.'
  const lines = [
    `epic ${run.epicId}: ${run.status} (generation ${run.gen}/${run.maxGens})`,
    `cadence ${run.cadence} . target ${run.target} . concurrency ${run.concurrency} . dry generations ${run.dryGens}`,
    run.abortReason ? `aborted: ${run.abortReason}` : '',
    '',
    '## Digest',
    run.digest,
  ]
  if (json.baton?.length) {
    lines.push('', '## Baton (tail)')
    for (const e of json.baton) {
      lines.push(`- ${e.ts} ${e.kind}${e.cardId ? ` [${e.cardId}]` : ''}: ${e.body.slice(0, 200)}`)
    }
  }
  return lines.filter(Boolean).join('\n')
}

/** Tool args -> request body, or the error message. Separate from `handle` so
 *  the argument shaping is testable and the handler stays two lines. */
export function toBody(p: Record<string, string | number>): Record<string, unknown> | string {
  const project = String(p.project ?? '')
  const epicId = String(p.epic_id ?? '')
  const action = String(p.action ?? '')
  if (!project || !epicId || !action) return 'project + epic_id + action are required'

  const start =
    action === 'start'
      ? { cadence: p.cadence, target: p.target, concurrency: p.concurrency, maxGens: p.max_gens }
      : undefined
  return {
    project,
    op: action,
    epicId,
    ...(start ? { start } : {}),
    ...(p.reason ? { reason: String(p.reason) } : {}),
  }
}

export function registerEpicTools(ctx: McpToolContext): Record<string, ToolDef> {
  const post = async (body: Record<string, unknown>): Promise<ToolResult> => {
    if (ctx.noBroker || !ctx.brokerUrl) return err('Error: no broker connection')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ctx.brokerSecret) headers.Authorization = `Bearer ${ctx.brokerSecret}`
    try {
      const res = await fetch(`${wsToHttpUrl(ctx.brokerUrl)}/api/epic`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as EpicRunPayload
      if (!json.ok) return err(`epic error: ${json.error || res.status}`)
      debug(`[channel] epic ${String(body.op)} ok`)
      return { content: [{ type: 'text', text: render(json) }] }
    } catch (e) {
      return err(`epic request failed: ${(e as Error).message}`)
    }
  }

  return {
    epic_run: {
      description: DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: { type: 'string', description: 'Canonical project URI the epic belongs to (required).' },
          epic_id: { type: 'string', description: 'The epic CARD id -- its file name without .md (required).' },
          action: { type: 'string', enum: ['start', 'get', 'pause', 'abort'], description: 'What to do.' },
          cadence: { type: 'string', enum: ['now', 'window'], description: 'start: when ready cards may dispatch.' },
          target: { type: 'string', enum: ['pr', 'merged', 'shipped'], description: 'start: delivery rung.' },
          concurrency: { type: 'number', description: 'start: max implementers in flight (default 3).' },
          max_gens: { type: 'number', description: 'start: overseer generation ceiling (default 40).' },
          reason: { type: 'string', description: 'abort: why, recorded in the baton.' },
        },
        required: ['project', 'epic_id', 'action'],
      },
      async handle(p: Record<string, string | number>) {
        const body = toBody(p)
        return typeof body === 'string' ? err(body) : post(body)
      },
    },
  }
}
