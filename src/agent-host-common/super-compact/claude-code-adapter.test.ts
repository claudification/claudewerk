/**
 * Adapter fidelity: parse <-> serialize must be lossless, or compaction would
 * corrupt the session before it even folds anything.
 */
import { describe, expect, test } from 'bun:test'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { buildFixture, ORIG_SESSION_ID } from './fixtures'

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter()

  test('round-trips a session losslessly (parse -> serialize -> parse)', () => {
    const raw = buildFixture()
    const t1 = adapter.parse(raw)
    const t2 = adapter.parse(adapter.serialize(t1))
    expect(t2).toEqual(t1)
  })

  test('parses session id, chain, and block kinds', () => {
    const t = adapter.parse(buildFixture())
    expect(t.sessionId).toBe(ORIG_SESSION_ID)
    expect(t.entries).toHaveLength(10)
    expect(t.entries[0].parentId).toBeNull()
    expect(t.entries[1].role).toBe('assistant')
    const kinds = (t.entries[1].blocks ?? []).map(b => b.kind)
    expect(kinds).toEqual(['thinking', 'tool_use'])
  })

  test('preserves bare-string user content as a string', () => {
    const t = adapter.parse(buildFixture())
    const out = adapter.serialize(t)
    const firstLine = JSON.parse(out.split('\n')[0]) as { message: { content: unknown } }
    expect(typeof firstLine.message.content).toBe('string')
  })
})
