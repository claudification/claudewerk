import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveConversationId, ensureStableUuids, parseJsonlEntries, parseSession, recoverCwd } from './import-history'

describe('deriveConversationId', () => {
  it('is deterministic and namespaced under import-', () => {
    const a = deriveConversationId('ultrathink', '/Users/z/code/x', 'sess-1')
    const b = deriveConversationId('ultrathink', '/Users/z/code/x', 'sess-1')
    expect(a).toBe(b)
    expect(a.startsWith('import-')).toBe(true)
  })

  it('differs by session, cwd, and sentinel', () => {
    const base = deriveConversationId('ultrathink', '/Users/z/code/x', 'sess-1')
    expect(deriveConversationId('ultrathink', '/Users/z/code/x', 'sess-2')).not.toBe(base)
    expect(deriveConversationId('ultrathink', '/Users/z/code/y', 'sess-1')).not.toBe(base)
    expect(deriveConversationId('m1', '/Users/z/code/x', 'sess-1')).not.toBe(base)
  })
})

describe('recoverCwd', () => {
  it('returns the first entry cwd, ignoring control lines without one', () => {
    const entries = [
      { type: 'custom-title' },
      { type: 'agent-name' },
      { type: 'user', cwd: '/Users/z/code/x' },
      { type: 'assistant', cwd: '/Users/z/other' },
    ] as never
    expect(recoverCwd(entries)).toBe('/Users/z/code/x')
  })

  it('returns undefined when no entry carries a cwd', () => {
    expect(recoverCwd([{ type: 'custom-title' }, { type: 'agent-name' }] as never)).toBeUndefined()
  })
})

describe('ensureStableUuids', () => {
  const cid = 'import-abc'

  it('leaves entries that already have a uuid untouched', () => {
    const entries = [{ type: 'user', uuid: 'real-uuid', cwd: '/x' }] as never
    const out = ensureStableUuids(cid, entries)
    expect(out[0].uuid).toBe('real-uuid')
  })

  it('synthesizes a deterministic imp- uuid for uuid-less entries (idempotent)', () => {
    const entries = [{ type: 'custom-title', title: 'hi' }] as never
    const first = ensureStableUuids(cid, entries)
    const second = ensureStableUuids(cid, entries)
    expect(first[0].uuid).toBe(second[0].uuid)
    expect(String(first[0].uuid).startsWith('imp-')).toBe(true)
    // preserves the original payload
    expect((first[0] as { title?: string }).title).toBe('hi')
  })

  it('gives different uuids to distinct uuid-less entries', () => {
    const out = ensureStableUuids(cid, [{ type: 'a' }, { type: 'b' }] as never)
    expect(out[0].uuid).not.toBe(out[1].uuid)
  })
})

describe('parseJsonlEntries', () => {
  it('skips blank and malformed lines', () => {
    const text = ['{"type":"user","uuid":"1"}', '', '   ', 'not json', '{"type":"assistant","uuid":"2"}'].join('\n')
    const out = parseJsonlEntries(text)
    expect(out.length).toBe(2)
    expect(out.map(e => (e as { uuid: string }).uuid)).toEqual(['1', '2'])
  })
})

describe('parseSession', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-history-test-'))

  it('maps a JSONL file to an upload-ready session attributed to the sentinel', () => {
    const file = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'custom-title', title: 'My Session' }),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          cwd: '/Users/z/code/claudwerk',
          timestamp: '2026-04-28T09:21:32.156Z',
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          cwd: '/Users/z/code/claudwerk',
          timestamp: '2026-04-28T09:25:00.000Z',
        }),
      ].join('\n'),
    )
    const s = parseSession(file, 'ultrathink')
    expect(s).not.toBeNull()
    if (!s) return
    expect(s.sessionUuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(s.project).toBe('claude://ultrathink/Users/z/code/claudwerk')
    expect(s.entries.length).toBe(3)
    // every entry carries a uuid (control line got a synthetic one)
    expect(s.entries.every(e => typeof (e as { uuid?: unknown }).uuid === 'string')).toBe(true)
    // time bounds derived from entry timestamps
    expect(s.startedAt).toBe(Date.parse('2026-04-28T09:21:32.156Z'))
    expect(s.endedAt).toBe(Date.parse('2026-04-28T09:25:00.000Z'))
  })

  it('returns null when no cwd can be recovered', () => {
    const file = join(dir, '11111111-2222-3333-4444-555555555555.jsonl')
    writeFileSync(file, [JSON.stringify({ type: 'custom-title' }), JSON.stringify({ type: 'agent-name' })].join('\n'))
    expect(parseSession(file, 'ultrathink')).toBeNull()
  })

  it('returns null for an empty file', () => {
    const file = join(dir, '99999999-2222-3333-4444-555555555555.jsonl')
    writeFileSync(file, '')
    expect(parseSession(file, 'ultrathink')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})
