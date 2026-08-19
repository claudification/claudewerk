/**
 * Pipeline-level cover for the point-in-time cut: the cut has to survive
 * parse -> fold -> serialize and come back out as a resumable transcript.
 */

import { describe, expect, test } from 'bun:test'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { buildFixture } from './fixtures'
import { runCompaction, StringReader, StringWriter } from './index'
import { makeGenId } from './fixtures'

const adapter = new ClaudeCodeAdapter()

function texts(serialized: string): string[] {
  return serialized
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .flatMap(r => {
      const c = r.message?.content
      if (typeof c === 'string') return [c]
      if (!Array.isArray(c)) return []
      return c.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text)
    })
}

async function run(cutAt?: Parameters<typeof runCompaction>[3]['cutAt'], onDropped?: (d: unknown[]) => Promise<string>) {
  const writer = new StringWriter()
  const result = await runCompaction(
    new StringReader(buildFixture()),
    writer,
    adapter,
    { newSessionId: 'fork-0001', genId: makeGenId(), tailTokenBudget: 0, cutAt },
    onDropped ? { onDropped: onDropped as never } : undefined,
  )
  return { result, out: writer.output }
}

describe('runCompaction -- point-in-time cut', () => {
  test('no cutAt folds the whole transcript, as a HEAD fork always has', async () => {
    const { result, out } = await run()
    expect(result.cut.resolvedBy).toBe('none')
    expect(result.cut.droppedEntries).toBe(0)
    expect(texts(out).join('\n')).toContain('All tests pass.')
  })

  test('carry-BEFORE drops everything after the boundary', async () => {
    // a6 is "Fixed the off-by-one in foo.ts." -- everything from "now run the
    // tests" onward should be gone.
    const { result, out } = await run({ uuid: 'a6', direction: 'before', inclusive: true })
    expect(result.cut.resolvedBy).toBe('uuid')
    const body = texts(out).join('\n')
    expect(body).toContain('Fixed the off-by-one in foo.ts.')
    expect(body).not.toContain('now run the tests')
    expect(body).not.toContain('All tests pass.')
  })

  test('carry-BEFORE exclusive leaves the boundary message out', async () => {
    const { out } = await run({ uuid: 'a6', direction: 'before', inclusive: false })
    expect(texts(out).join('\n')).not.toContain('Fixed the off-by-one in foo.ts.')
  })

  test('carry-AFTER drops the ancient head and keeps the recent tail', async () => {
    const { result, out } = await run({ uuid: 'a7', direction: 'after', inclusive: true })
    expect(result.cut.resolvedBy).toBe('uuid')
    const body = texts(out).join('\n')
    expect(body).toContain('now run the tests')
    expect(body).toContain('All tests pass.')
    expect(body).not.toContain('Read foo.ts and fix the bug')
  })

  test('the emitted transcript is still a clean single parent chain', async () => {
    const { out } = await run({ uuid: 'a7', direction: 'after', inclusive: true })
    const rows = out
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
    expect(rows[0].parentUuid).toBeNull()
    for (let i = 1; i < rows.length; i++) expect(rows[i].parentUuid).toBe(rows[i - 1].uuid)
    for (const r of rows) expect(r.sessionId).toBe('fork-0001')
  })

  test('an unresolvable boundary falls back to the full transcript', async () => {
    const { result, out } = await run({ uuid: 'does-not-exist', direction: 'before', inclusive: true })
    expect(result.cut.resolvedBy).toBe('none')
    expect(texts(out).join('\n')).toContain('All tests pass.')
  })

  test('the dropped hook receives ONLY the discarded slice and lands in the preamble', async () => {
    let seen = 0
    const { out } = await run({ uuid: 'a7', direction: 'after', inclusive: true }, async d => {
      seen = d.length
      return '[earlier context] The agent read foo.ts and fixed an off-by-one.'
    })
    expect(seen).toBeGreaterThan(0)
    const body = texts(out).join('\n')
    expect(body).toContain('fixed an off-by-one')
    // Still dropped from the verbatim history -- the summary replaces it, not augments it.
    expect(body).not.toContain('Read foo.ts and fix the bug')
  })

  test('the dropped hook is not called when nothing was dropped', async () => {
    let called = false
    await run(undefined, async () => {
      called = true
      return 'x'
    })
    expect(called).toBe(false)
  })
})
