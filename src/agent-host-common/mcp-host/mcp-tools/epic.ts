/**
 * `epic_run` -- drive, inspect and debug an EPIC RUN.
 *
 * Deliberately has NO spawn verb. The engine owns dispatch: a tool that could
 * spawn an epic worker directly would bypass the DAG gate, the concurrency
 * ceiling and the overseer lease -- every safety property of the run, in one
 * call. If you want work to start, arm the run and let the beat decide.
 *
 * `beat` is not a hole in that rule. It runs ONE beat of the engine, taking the
 * same reentrancy guard and the same plan the 45s sweep would take; all it
 * changes is WHEN, never WHETHER or WHAT.
 *
 * Mirrors the quest/nightshift MCP idiom: one POST to a broker route, because
 * the agent host has no sentinel of its own to ask.
 */

import { wsToHttpUrl } from '../../../shared/ws-url'
import { debug } from '../debug'
import { type EpicRunPayload, renderEpic } from './epic-render'
import type { McpToolContext, ToolDef, ToolResult } from './types'

const DESCRIPTION = [
  'Drive / inspect / debug an EPIC RUN: the engine plans AND executes a whole epic unattended.',
  'It dispatches one implementer per ready card (ordered by depends_on), sends an independent VERIFIER',
  'over every finished card, and wakes a single OVERSEER between beats -- the only seat that may ask a human.',
  '',
  'DRIVE',
  'action=start        arm (or resume) the run. `when` is the DISPATCH GATE, re-evaluated every beat: "now"',
  '                    ignores the clock, "window" defers to the project night window, "queue" waits until no',
  '                    other epic in this project has work in flight and then holds the runner EXCLUSIVELY until',
  '                    this run goes dry (everything else keeps verifying, but stops dispatching). Comma-separate',
  '                    to compose -- `when=window,queue` means both must pass. `concurrency` defaults to 3 -- that',
  '                    is a REVIEW ceiling, not a machine one; raising it means choosing to stop reviewing',
  '                    per-change.',
  '                    THREE HANDBRAKES, none of them infinity: `max_gens` (40) bounds how often the overseer',
  '                    THINKS, `max_usd` (100) bounds what the whole run SPENDS, `max_wall_clock_minutes` (480)',
  '                    bounds how long it runs unattended. Whichever trips first PARKS the run and says so in',
  '                    the baton. A parked run resumes by starting it again with the ceiling raised.',
  '                    CHEAP BY DESIGN: it merges rather than clobbers, so sending one knob changes one knob, and',
  '                    it answers with the STATUS BLOCK ONLY (state, when, target, concurrency, caps, lease).',
  '                    Raising a ceiling therefore costs about what `list` costs. Use get for the digest.',
  'action=pause        stop dispatching, release the overseer lease. A later start RESUMES; it never resets the',
  '                    generation counter.',
  'action=abort        terminal, with `reason` recorded in the append-only baton.',
  'action=clear        acknowledge a run that has ALREADY ENDED, so it stops occupying THE WALL. It is not a',
  '                    quieter abort and not a delete: run.md, the baton and every card stay exactly as they are,',
  '                    and it REFUSES an armed or running run -- pause or abort first.',
  'action=beat         run ONE beat RIGHT NOW instead of waiting up to 45s for the sweep. Use this after arming',
  '                    to see immediately whether the run does anything, and to step a stalled run by hand.',
  '',
  'INSPECT',
  'action=list         every run this project has: status, generation, cards in flight, whether armed.',
  'action=get          the cheap read -- run state, digest and baton tail. This is where the digest lives: start',
  '                    does not print it, so reach for get when you want the plan of record.',
  'action=inspect      THE DEBUG READ. Everything at once: the run, who holds the overseer lease, the DAG plan',
  '                    (what is dispatchable / awaiting a verdict / held back by the ceiling / waiting on deps /',
  '                    parked as a question), WHY nothing is moving, which conversations are alive, which settled',
  '                    cards the baton has not acknowledged, and the beats the sweep actually performed.',
  '                    Reach for this first whenever an epic looks stuck. It never mutates anything.',
  '',
  'DEBUG',
  'action=break_lease  release a stuck overseer lease so the next beat can wake a fresh one. Refuses while the',
  '                    holder conversation is still alive unless `force` is set. Records who broke it in the baton.',
  '',
  '`baton_limit` / `baton_kinds` / `baton_card` deepen or filter the baton on get and inspect -- e.g. every',
  'verdict, or everything that ever happened to one card. The default tail is sized for a prompt, not for a human.',
].join('\n')

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

const ACTIONS = ['start', 'get', 'inspect', 'list', 'beat', 'pause', 'abort', 'clear', 'break_lease'] as const

/** Comma-separated or already a list -> a list. The MCP schema says string, and
 *  a model will send either spelling however the schema is worded. */
function toList(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : []
  const list = raw.map(s => s.trim()).filter(Boolean)
  return list.length > 0 ? list : undefined
}

/** The baton slice, if the caller asked for one. Undefined means "the default",
 *  which is the prompt-sized tail the engine itself uses. */
function toBatonQuery(p: Record<string, unknown>): Record<string, unknown> | undefined {
  const limit = typeof p.baton_limit === 'number' ? p.baton_limit : undefined
  const kinds = toList(p.baton_kinds)
  const cardId = p.baton_card ? String(p.baton_card) : undefined
  if (limit === undefined && !kinds && !cardId) return undefined
  return { ...(limit ? { limit } : {}), ...(kinds ? { kinds } : {}), ...(cardId ? { cardId } : {}) }
}

/** Tool args -> request body, or the error message. Separate from `handle` so
 *  the argument shaping is testable and the handler stays two lines. */
export function toBody(p: Record<string, unknown>): Record<string, unknown> | string {
  const project = String(p.project ?? '')
  const epicId = String(p.epic_id ?? '')
  const action = String(p.action ?? '')
  if (!project || !action) return 'project + action are required'
  // `list` is the one action that is about the PROJECT rather than one epic.
  if (!epicId && action !== 'list') return 'epic_id is required for every action except list'

  const start =
    action === 'start'
      ? {
          // `when` IS `cadence`, widened -- one axis, two names, and the storage
          // one still answers so a caller (or a test) written before the rename
          // keeps working. `when` wins when both are sent.
          cadence: p.when ?? p.cadence,
          target: p.target,
          concurrency: p.concurrency,
          maxGens: p.max_gens,
          maxUsd: p.max_usd,
          maxWallClockMinutes: p.max_wall_clock_minutes,
        }
      : undefined
  const baton = toBatonQuery(p)

  return {
    project,
    op: action,
    ...(epicId ? { epicId } : {}),
    ...(start ? { start } : {}),
    ...(baton ? { baton } : {}),
    ...(p.beats ? { beats: Number(p.beats) } : {}),
    ...(p.force ? { force: true } : {}),
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
      // The op goes to the renderer because the four run verbs come back in one
      // shape: only the request knows whether this call asked for the plan.
      return { content: [{ type: 'text', text: renderEpic(json, String(body.op)) }] }
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
          epic_id: {
            type: 'string',
            description: 'The epic CARD id -- its file name without .md. Required for everything except list.',
          },
          action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
          when: {
            type: 'string',
            description:
              'start: the gate(s) a ready card must pass before it dispatches -- "now" (no gate), "window" (the ' +
              'project\'s night window), "queue" (wait until no other epic in this project is running, then hold ' +
              'the runner exclusively until this run goes dry). Comma-separate to compose them: "window,queue" ' +
              'means ALL of them must pass on the same beat. Evaluated every beat, not once at arm time.',
          },
          cadence: {
            type: 'string',
            description: 'start: the old name for `when`. Accepted; prefer `when`, which is the same field.',
          },
          target: { type: 'string', enum: ['pr', 'merged', 'shipped'], description: 'start: delivery rung.' },
          concurrency: { type: 'number', description: 'start: max implementers in flight (default 3).' },
          max_gens: { type: 'number', description: 'start: overseer generation ceiling (default 40).' },
          max_usd: {
            type: 'number',
            description:
              'start: cumulative USD ceiling for the WHOLE run, across every conversation it spawns (default 100). ' +
              'Tripping it PARKS the run. 0 disarms it. Raise it and start again to let a parked run continue.',
          },
          max_wall_clock_minutes: {
            type: 'number',
            description:
              'start: ceiling on minutes since the run was first allowed to dispatch (default 480 = one night). ' +
              'Tripping it PARKS the run. 0 disarms it. The clock starts when work may begin, not when you arm -- ' +
              'a cadence=window run does not spend its budget waiting for the window.',
          },
          reason: { type: 'string', description: 'abort / break_lease: why, recorded in the baton.' },
          force: { type: 'boolean', description: 'break_lease: break it even though the holder is still alive.' },
          beats: { type: 'number', description: 'inspect: how many past beats to show (default 10).' },
          baton_limit: { type: 'number', description: 'get / inspect: baton entries to return (default 20).' },
          baton_kinds: {
            type: 'string',
            description:
              'get / inspect: comma-separated kinds to keep -- intent, dispatch, dispatch-failed, completion, verdict, blocked, merge, steering, checkpoint.',
          },
          baton_card: { type: 'string', description: 'get / inspect: only baton entries about this card id.' },
        },
        required: ['project', 'action'],
      },
      async handle(p: Record<string, unknown>) {
        const body = toBody(p)
        return typeof body === 'string' ? err(body) : post(body)
      },
    },
  }
}
