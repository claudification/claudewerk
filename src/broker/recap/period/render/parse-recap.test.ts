import { describe, expect, it } from 'bun:test'
import { parseRecapOutput, RecapParseError } from './parse-recap'

describe('parseRecapOutput', () => {
  it('parses a well-formed recap with frontmatter + body', () => {
    const raw = `---
subtitle: SQLite phase 4 ship
keywords: [sqlite, fts5, wal]
hashtags: [#ship-week, #sqlite-migration]
goals:
  - Ship Phase 4
  - Fix WAL incident
discoveries: [docker cp corrupts WAL]
side_effects: []
features:
  - title: Phase 4 SQLite migration
    conversations: [conv_abc123, conv_def456]
    commits: [abcd123, deadbee]
bugs: []
fixes: []
incidents:
  - title: WAL corruption
    severity: high
open_questions:
  - What is the long-term retention policy for recap_logs?
stakeholders: []
---

## TL;DR

- Shipped Phase 4
`
    const out = parseRecapOutput(raw)
    expect(out.metadata.subtitle).toBe('SQLite phase 4 ship')
    expect(out.metadata.keywords).toContain('sqlite')
    expect(out.metadata.hashtags).toContain('#ship-week')
    expect(out.metadata.goals.length).toBe(2)
    expect(out.metadata.discoveries[0]).toBe('docker cp corrupts WAL')
    expect(out.metadata.features.length).toBe(1)
    expect(out.metadata.features[0].title).toBe('Phase 4 SQLite migration')
    expect(out.metadata.features[0].conversations).toContain('conv_abc123')
    expect(out.metadata.open_questions.length).toBe(1)
    expect(out.body.startsWith('## TL;DR')).toBe(true)
  })

  it('throws RecapParseError when frontmatter is missing', () => {
    expect(() => parseRecapOutput('No frontmatter here, just body.')).toThrow(RecapParseError)
  })

  it('returns empty arrays for missing list fields', () => {
    const raw = `---
subtitle: minimal
---

body`
    const out = parseRecapOutput(raw)
    expect(out.metadata.keywords).toEqual([])
    expect(out.metadata.features).toEqual([])
    // Recap 2.0 fields default to empty arrays too.
    expect(out.metadata.decisions).toEqual([])
    expect(out.metadata.dead_ends).toEqual([])
    expect(out.metadata.gotchas).toEqual([])
  })

  it('parses Recap 2.0 sections: decisions, dead_ends, gotchas with detail + inferred', () => {
    const raw = `---
subtitle: rich recap
decisions:
  - title: Bearer tokens over cookies
    detail: SPA simplicity + mobile parity
    conversations: [conv_aaa111]
dead_ends:
  - title: Tried polling list() for /clear detection
    detail: list never rotates sessionId; switched to transcript-dir watch
    commits: [1234abc]
gotchas:
  - "[inferred] Bun fs.watch is unreliable on macOS"
  - title: docker cp corrupts WAL
    inferred: true
---

## TL;DR
body`
    const out = parseRecapOutput(raw)
    expect(out.metadata.decisions.length).toBe(1)
    expect(out.metadata.decisions[0].title).toBe('Bearer tokens over cookies')
    expect(out.metadata.decisions[0].detail).toBe('SPA simplicity + mobile parity')
    expect(out.metadata.decisions[0].conversations).toContain('conv_aaa111')
    expect(out.metadata.dead_ends.length).toBe(1)
    expect(out.metadata.dead_ends[0].commits).toContain('1234abc')
    expect(out.metadata.gotchas.length).toBe(2)
    // `[inferred]` title prefix is stripped and flagged.
    expect(out.metadata.gotchas[0].title).toBe('Bun fs.watch is unreliable on macOS')
    expect(out.metadata.gotchas[0].inferred).toBe(true)
    // explicit `inferred: true` sub-key also flags.
    expect(out.metadata.gotchas[1].inferred).toBe(true)
  })
})
