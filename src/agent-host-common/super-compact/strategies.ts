/**
 * Fold primitives the compactor composes. Every primitive here is TOOL-PAIR
 * SAFE by construction: we never drop a tool_use or tool_result block, we only
 * (a) drop thinking blocks (no pairing constraint) or (b) SHRINK a tool_result's
 * content to a digest while leaving the pair intact. That is why compaction can
 * never orphan a tool block and 400 the next API call.
 */

import type { ContentBlock, Entry } from './model'
import type { TokenEstimator } from './tokens'

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit'])

/** Block reference for a recoverable fold, embedded in the preamble. */
export interface FoldAnchor {
  file: string
  toolUseId: string
}

function blockText(b: ContentBlock): string {
  switch (b.kind) {
    case 'text':
    case 'thinking':
      return b.text
    case 'tool_use':
      return JSON.stringify(b.input ?? '')
    case 'tool_result':
      return typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
  }
}

export function entryTokens(e: Entry, estimate: TokenEstimator): number {
  return (e.blocks ?? []).reduce((sum, b) => sum + estimate(blockText(b)), 0)
}

/** A real human prompt: a user turn with text and no tool_result -- a safe cut point. */
function isHumanPrompt(e: Entry): boolean {
  if (e.role !== 'user' || !e.blocks) return false
  const hasText = e.blocks.some(b => b.kind === 'text')
  const hasResult = e.blocks.some(b => b.kind === 'tool_result')
  return hasText && !hasResult
}

/**
 * Index into `msgs` where the verbatim protected tail begins. We only ever cut
 * on a human-prompt boundary, so the tail can never start mid tool-cycle. We
 * extend the tail back through as many whole human turns as fit the budget, and
 * always keep at least the most recent human turn onward.
 */
export function findTailStart(msgs: Entry[], budget: number, estimate: TokenEstimator): number {
  const n = msgs.length
  let acc = 0
  let lastSafe = n
  for (let i = n - 1; i >= 0; i--) {
    acc += entryTokens(msgs[i], estimate)
    if (isHumanPrompt(msgs[i])) {
      if (acc <= budget) lastSafe = i
      else break
    }
  }
  if (lastSafe === n) {
    for (let i = n - 1; i >= 0; i--) {
      if (isHumanPrompt(msgs[i])) {
        lastSafe = i
        break
      }
    }
    if (lastSafe === n) lastSafe = Math.max(0, n - 1)
  }
  return lastSafe
}

/** Drop thinking blocks from a (cold) entry; returns how many were removed. */
export function dropThinking(e: Entry): number {
  if (!e.blocks) return 0
  const before = e.blocks.length
  e.blocks = e.blocks.filter(b => b.kind !== 'thinking')
  return before - e.blocks.length
}

function filePathOf(b: ContentBlock): string | null {
  if (b.kind !== 'tool_use' || !FILE_TOOLS.has(b.name)) return null
  const input = b.input as { file_path?: unknown } | null
  return input && typeof input.file_path === 'string' ? input.file_path : null
}

function findResultBlock(entries: Entry[], toolUseId: string): ContentBlock | null {
  for (const e of entries) {
    for (const b of e.blocks ?? []) {
      if (b.kind === 'tool_result' && b.toolUseId === toolUseId) return b
    }
  }
  return null
}

/**
 * Fold superseded file reads: a `Read` whose file is later read or edited again
 * in the cold zone is dead weight, so shrink its tool_result to a digest (the
 * pair stays). Returns count + anchors for recovery from the original session.
 */
export function collapseSupersededReads(cold: Entry[]): { collapsed: number; anchors: FoldAnchor[] } {
  const ops: Array<{ idx: number; id: string; file: string; name: string }> = []
  cold.forEach((e, idx) => {
    for (const b of e.blocks ?? []) {
      const file = filePathOf(b)
      if (file && b.kind === 'tool_use') ops.push({ idx, id: b.id, file, name: b.name })
    }
  })

  const anchors: FoldAnchor[] = []
  let collapsed = 0
  for (const op of ops) {
    if (op.name !== 'Read') continue
    const superseded = ops.some(o => o.file === op.file && o.idx > op.idx)
    if (!superseded) continue
    const result = findResultBlock(cold, op.id)
    if (result && result.kind === 'tool_result') {
      result.content = `[folded: Read ${op.file} -- superseded by a later edit/read; recover from the original session by tool_use id ${op.id}]`
      collapsed++
      anchors.push({ file: op.file, toolUseId: op.id })
    }
  }
  return { collapsed, anchors }
}
