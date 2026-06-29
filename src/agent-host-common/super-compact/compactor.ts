/**
 * superCompact: Transcript -> Transcript. Harness-agnostic. Produces a SMALLER
 * continuation of a session: a synthetic narrative preamble (with a link back
 * to the original + recovery anchors), the cold middle folded (thinking dropped,
 * superseded reads digested), and a protected verbatim tail. The output is a
 * fresh session with a clean parent chain, ready for an adapter to serialize
 * and a host to `--resume`.
 *
 * Nothing here deletes the original -- this is a CONTINUATION with a link back,
 * so the fold is always reversible at the source.
 */

import { type Entry, isMessageEntry, type Transcript } from './model'
import { collapseSupersededReads, dropThinking, entryTokens, type FoldAnchor, findTailStart } from './strategies'
import { estimateTokens, type TokenEstimator } from './tokens'

export interface CompactOptions {
  /** Fresh session id for the synthesized continuation. */
  newSessionId: string
  /** Where the original lives, embedded in the preamble for recovery. */
  parentRef?: { sessionId: string; path?: string }
  /** Keep the most recent entries under this token budget verbatim (default 20k). */
  tailTokenBudget?: number
  /** Drop thinking blocks from the cold zone (default true). */
  dropThinking?: boolean
  /** Digest superseded file reads in the cold zone (default true). */
  collapseSupersededReads?: boolean
  estimate?: TokenEstimator
  /** Id generator for synthesized/re-stitched entries (override for deterministic tests). */
  genId?: () => string
}

export interface CompactResult {
  transcript: Transcript
  stats: {
    beforeTokens: number
    afterTokens: number
    entriesBefore: number
    entriesAfter: number
    droppedThinking: number
    collapsedReads: number
    tailEntries: number
  }
}

const TEMPLATE_FIELDS = ['cwd', 'version', 'gitBranch', 'userType', 'entrypoint', 'permissionMode', 'timestamp']

function cloneEntry(e: Entry): Entry {
  return structuredClone(e)
}

function pickTemplate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of TEMPLATE_FIELDS) if (k in raw) out[k] = raw[k]
  return out
}

function renderPreamble(coldCount: number, anchors: FoldAnchor[], parentRef?: CompactOptions['parentRef']): string {
  const lines = ['[super-compacted context]', '']
  lines.push(
    `This session is a compacted continuation of a longer transcript; ${coldCount} earlier turns were folded to save context.`,
  )
  if (parentRef) {
    lines.push('', `Full history: session ${parentRef.sessionId}${parentRef.path ? ` at ${parentRef.path}` : ''}.`)
  }
  if (anchors.length) {
    lines.push('', 'Folded blocks (recover from the original session by tool_use id):')
    for (const a of anchors) lines.push(`- ${a.file} (${a.toolUseId})`)
  }
  return lines.join('\n')
}

function buildPreamble(
  opts: CompactOptions,
  template: Record<string, unknown>,
  coldCount: number,
  anchors: FoldAnchor[],
): Entry {
  const text = renderPreamble(coldCount, anchors, opts.parentRef)
  return {
    id: null,
    parentId: null,
    type: 'user',
    role: 'user',
    blocks: [{ kind: 'text', text }],
    raw: { ...pickTemplate(template), type: 'user', message: { role: 'user', content: text } },
  }
}

/** Re-stitch a single clean parent chain and stamp the new session id onto every entry. */
function relink(entries: Entry[], sessionId: string, genId: () => string): Entry[] {
  let parent: string | null = null
  for (const e of entries) {
    const id = genId()
    e.id = id
    e.parentId = parent
    e.raw = { ...e.raw, uuid: id, parentUuid: parent, sessionId }
    parent = id
  }
  return entries
}

export function superCompact(t: Transcript, opts: CompactOptions): CompactResult {
  const estimate = opts.estimate ?? estimateTokens
  const genId = opts.genId ?? (() => crypto.randomUUID())
  const budget = opts.tailTokenBudget ?? 20_000

  const msgs = t.entries.filter(isMessageEntry)
  const beforeTokens = msgs.reduce((s, e) => s + entryTokens(e, estimate), 0)

  const tailStart = findTailStart(msgs, budget, estimate)
  const cold = msgs.slice(0, tailStart).map(cloneEntry)
  const tail = msgs.slice(tailStart).map(cloneEntry)

  let droppedThinking = 0
  if (opts.dropThinking !== false) for (const e of cold) droppedThinking += dropThinking(e)

  let collapsedReads = 0
  let anchors: FoldAnchor[] = []
  if (opts.collapseSupersededReads !== false) {
    const r = collapseSupersededReads(cold)
    collapsedReads = r.collapsed
    anchors = r.anchors
  }

  // Drop cold entries left with no blocks (e.g. a pure-thinking assistant turn).
  const coldKept = cold.filter(e => (e.blocks?.length ?? 0) > 0)

  const preamble = buildPreamble(opts, msgs[0]?.raw ?? {}, tailStart, anchors)
  const entries = relink([preamble, ...coldKept, ...tail], opts.newSessionId, genId)
  const transcript: Transcript = { sessionId: opts.newSessionId, entries }
  const afterTokens = entries.filter(isMessageEntry).reduce((s, e) => s + entryTokens(e, estimate), 0)

  return {
    transcript,
    stats: {
      beforeTokens,
      afterTokens,
      entriesBefore: msgs.length,
      entriesAfter: entries.length,
      droppedThinking,
      collapsedReads,
      tailEntries: tail.length,
    },
  }
}
