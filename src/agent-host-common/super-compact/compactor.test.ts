/**
 * The theories, encoded as assertions. Each test pins one of the landmines we
 * reasoned about before writing a line of product code: tool-pair safety,
 * thinking drop, superseded-read fold, verbatim tail, valid chain, link-back.
 */
import { describe, expect, test } from 'bun:test'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { superCompact } from './compactor'
import { buildFixture, makeGenId, ORIG_SESSION_ID } from './fixtures'
import { runCompaction } from './index'
import { StringReader, StringWriter } from './io'
import type { ContentBlock, Transcript } from './model'

const NEW_SID = 'new-session-9999'
const PARENT = { sessionId: ORIG_SESSION_ID, path: '/x.jsonl' }

function compact(): Transcript {
  const t = new ClaudeCodeAdapter().parse(buildFixture())
  return superCompact(t, { newSessionId: NEW_SID, parentRef: PARENT, tailTokenBudget: 30, genId: makeGenId() })
    .transcript
}

function blocksOf(t: Transcript): ContentBlock[] {
  return t.entries.flatMap(e => e.blocks ?? [])
}

describe('superCompact', () => {
  test('tool_use and tool_result stay paired (no orphans after folding)', () => {
    const blocks = blocksOf(compact())
    const uses = new Set(blocks.filter(b => b.kind === 'tool_use').map(b => (b as { id: string }).id))
    const results = new Set(
      blocks.filter(b => b.kind === 'tool_result').map(b => (b as { toolUseId: string }).toolUseId),
    )
    for (const id of results) expect(uses.has(id)).toBe(true)
    for (const id of uses) expect(results.has(id)).toBe(true)
  })

  test('drops thinking from the cold zone', () => {
    const t = new ClaudeCodeAdapter().parse(buildFixture())
    const result = superCompact(t, {
      newSessionId: NEW_SID,
      parentRef: PARENT,
      tailTokenBudget: 30,
      genId: makeGenId(),
    })
    expect(result.stats.droppedThinking).toBe(2)
    expect(blocksOf(result.transcript).some(b => b.kind === 'thinking')).toBe(false)
  })

  test('folds a superseded read to a digest, keeping the pair', () => {
    const t = new ClaudeCodeAdapter().parse(buildFixture())
    const result = superCompact(t, {
      newSessionId: NEW_SID,
      parentRef: PARENT,
      tailTokenBudget: 30,
      genId: makeGenId(),
    })
    expect(result.stats.collapsedReads).toBe(1)
    const readResult = blocksOf(result.transcript).find(b => b.kind === 'tool_result' && b.toolUseId === 'tu_read')
    expect(String((readResult as { content: unknown }).content)).toContain('folded')
    expect(result.stats.afterTokens).toBeLessThan(result.stats.beforeTokens)
  })

  test('preamble links back to the original session + anchors the fold', () => {
    const preamble = compact().entries[0]
    const txt = (preamble.blocks?.[0] as { text: string }).text
    expect(txt).toContain('super-compacted')
    expect(txt).toContain(ORIG_SESSION_ID)
    expect(txt).toContain('tu_read')
  })

  test('preserves the protected tail verbatim', () => {
    const tail = compact().entries.slice(-4)
    expect(tail[0].blocks).toEqual([{ kind: 'text', text: 'now run the tests' }])
    expect(tail[1].blocks).toEqual([{ kind: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'bun test' } }])
    expect(tail[3].blocks).toEqual([{ kind: 'text', text: 'All tests pass.' }])
  })

  test('emits a single valid parent chain stamped with the new session id', () => {
    const out = compact()
    let parent: string | null = null
    const seen = new Set<string>()
    for (const e of out.entries) {
      expect(e.parentId).toBe(parent)
      expect(e.id).not.toBeNull()
      expect(seen.has(e.id as string)).toBe(false)
      seen.add(e.id as string)
      expect(e.raw.uuid).toBe(e.id)
      expect(e.raw.parentUuid).toBe(e.parentId)
      expect(e.raw.sessionId).toBe(NEW_SID)
      parent = e.id
    }
  })
})

describe('runCompaction pipeline (string in -> string out)', () => {
  test('reads, folds, writes a resumable transcript', async () => {
    const reader = new StringReader(buildFixture())
    const writer = new StringWriter()
    const result = await runCompaction(reader, writer, new ClaudeCodeAdapter(), {
      newSessionId: NEW_SID,
      parentRef: PARENT,
      tailTokenBudget: 30,
      genId: makeGenId(),
    })
    const reparsed = new ClaudeCodeAdapter().parse(writer.output)
    expect(reparsed.entries.length).toBeGreaterThan(0)
    expect(reparsed.entries.every(e => e.raw.sessionId === NEW_SID)).toBe(true)
    expect(result.stats.afterTokens).toBeLessThan(result.stats.beforeTokens)
  })
})
