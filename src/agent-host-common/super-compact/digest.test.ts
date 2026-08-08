/**
 * digestLargeToolResults -- the strategy that carries the fold.
 *
 * A token census of real sessions put ~90% of a long transcript in tool_result
 * blocks and ~87% in Read output alone, nearly all one-shot reads that
 * collapseSupersededReads will not touch. Without this strategy the whole fold
 * lands around -14%; these tests pin that it bites hard AND stays pair-safe.
 */
import { describe, expect, test } from 'bun:test'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { superCompact } from './compactor'
import { buildLargeResultFixture, makeGenId, ORIG_SESSION_ID } from './fixtures'
import type { ContentBlock, Transcript } from './model'

const NEW_SID = 'new-session-digest'
const PARENT = { sessionId: ORIG_SESSION_ID, path: '/x.jsonl' }

function fold(over?: number) {
  const t = new ClaudeCodeAdapter().parse(buildLargeResultFixture())
  return superCompact(t, {
    newSessionId: NEW_SID,
    parentRef: PARENT,
    // Tail budget small enough that the big read lands in the COLD zone.
    tailTokenBudget: 30,
    digestToolResultsOverTokens: over,
    genId: makeGenId(),
  })
}

function blocksOf(t: Transcript): ContentBlock[] {
  return t.entries.flatMap(e => e.blocks ?? [])
}

function bigResult(t: Transcript): ContentBlock & { kind: 'tool_result' } {
  const b = blocksOf(t).find(x => x.kind === 'tool_result' && x.toolUseId === 'tu_big')
  if (b?.kind !== 'tool_result') throw new Error('tu_big result missing -- the pair was broken')
  return b
}

describe('digestLargeToolResults', () => {
  test('digests a big one-shot read that collapseSupersededReads ignores', () => {
    const r = fold()
    expect(r.stats.collapsedReads).toBe(0) // never re-read, so the old strategy is blind to it
    expect(r.stats.digestedResults).toBe(1)
  })

  test('cuts the session down hard', () => {
    const r = fold()
    // The fixture is ~15k tokens of read output; folding it must be dramatic,
    // not the ~14% the pre-digest strategies managed.
    expect(r.stats.afterTokens).toBeLessThan(r.stats.beforeTokens * 0.2)
  })

  test('keeps the tool pair intact (never orphans a tool_use)', () => {
    const blocks = blocksOf(fold().transcript)
    const uses = new Set(blocks.filter(b => b.kind === 'tool_use').map(b => (b as { id: string }).id))
    const results = new Set(
      blocks.filter(b => b.kind === 'tool_result').map(b => (b as { toolUseId: string }).toolUseId),
    )
    expect(uses).toEqual(results)
  })

  test('leaves a recovery anchor and a readable preview in the digest', () => {
    const content = String(bigResult(fold().transcript).content)
    expect(content).toContain('folded')
    expect(content).toContain('tu_big') // recoverable from the original session
    expect(content).toContain('/repo/big.ts') // names what it replaced
    expect(content).toContain('export function thing') // head preview survives
  })

  test('respects the threshold: a high bar digests nothing', () => {
    const r = fold(1_000_000)
    expect(r.stats.digestedResults).toBe(0)
    expect(String(bigResult(r.transcript).content)).not.toContain('folded')
  })

  test('0 disables the strategy entirely', () => {
    expect(fold(0).stats.digestedResults).toBe(0)
  })

  // Regression: the fold used to rewrite message.content while CC's sibling
  // `toolUseResult` copy of the SAME output rode along at full size in `raw`
  // (2.9MB / 53% of user-entry bytes on a real 675k session), so the serialized
  // fork carried back everything that had just been digested.
  test('shrinks CC toolUseResult duplicate in lockstep with the digest', () => {
    const out = new ClaudeCodeAdapter().serialize(fold().transcript)
    const dup = out
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { toolUseResult?: unknown })
      .find(o => o.toolUseResult !== undefined)

    expect(dup).toBeDefined()
    expect(JSON.stringify(dup?.toolUseResult)).toContain('folded')
    expect(JSON.stringify(dup?.toolUseResult)).not.toContain('export function thing')
  })

  test('serialized fork is actually smaller on disk, not just in token count', () => {
    const before = buildLargeResultFixture().length
    const after = new ClaudeCodeAdapter().serialize(fold().transcript).length
    expect(after).toBeLessThan(before * 0.3)
  })
})
