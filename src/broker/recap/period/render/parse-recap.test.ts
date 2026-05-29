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
    // Pillar F retrospect fields are OPTIONAL -- absent (undefined) on a
    // non-retrospect recap, never defaulted to [].
    expect(out.metadata.went_well).toBeUndefined()
    expect(out.metadata.went_badly).toBeUndefined()
    expect(out.metadata.recommendations).toBeUndefined()
  })

  it('parses Pillar F retrospect fields when present', () => {
    const raw = `---
subtitle: retro
went_well:
  - title: Chunking shipped clean
    commits: [abc1234]
went_badly:
  - title: Relitigated the URI strip twice
    detail: cost an afternoon
    inferred: true
recommendations:
  - title: Add a lint rule for ccSessionId in broker
    detail: encode the boundary covenant as a check
    conversations: [conv_xyz789]
---

## Retrospective
body`
    const out = parseRecapOutput(raw)
    expect(out.metadata.went_well?.length).toBe(1)
    expect(out.metadata.went_well?.[0].commits).toContain('abc1234')
    expect(out.metadata.went_badly?.[0].inferred).toBe(true)
    expect(out.metadata.recommendations?.[0].title).toContain('lint rule')
    expect(out.metadata.recommendations?.[0].conversations).toContain('conv_xyz789')
  })

  it('parses inline flow-map items (the form the reduce LLM actually emits)', () => {
    // Regression for the v2.1 "cards render as raw {json}" bug: the LLM emitted
    // `- {title: X, detail: "...", conversations: [a], commits: [b]}` but the old
    // parser only understood block style, so the whole brace string became title.
    const raw = `---
subtitle: flow-map form
features:
  - {title: Profile URL strip, detail: "Removed profile@ from project URIs", conversations: [4a0318fc], commits: [c8704b8d]}
  - {title: Transport reframe, detail: "Daemon becomes a transport", conversations: [8ee9accb, bad58324], commits: [26943858, 15eb4110]}
bugs:
  - {title: "React #185 infinite render", conversations: [b5e47b7a], inferred: true}
---

## TL;DR
body`
    const out = parseRecapOutput(raw)
    expect(out.metadata.features.length).toBe(2)
    expect(out.metadata.features[0].title).toBe('Profile URL strip')
    expect(out.metadata.features[0].detail).toBe('Removed profile@ from project URIs')
    expect(out.metadata.features[0].conversations).toEqual(['4a0318fc'])
    expect(out.metadata.features[0].commits).toEqual(['c8704b8d'])
    expect(out.metadata.features[1].conversations).toEqual(['8ee9accb', 'bad58324'])
    expect(out.metadata.features[1].commits).toEqual(['26943858', '15eb4110'])
    // title with a comma inside quotes must not split the flow-map
    expect(out.metadata.bugs[0].title).toBe('React #185 infinite render')
    expect(out.metadata.bugs[0].inferred).toBe(true)
  })

  it('parses a multi-line wrapped flow-map item', () => {
    // Long items wrap across lines; the parser must accumulate until braces balance.
    const raw = `---
subtitle: wrapped
features:
  - {title: Spawn parent tracking,
     detail: "Track parent/root conversation relationships",
     conversations: [807269d9, 3352290f],
     commits: [de2815a9]}
---

body`
    const out = parseRecapOutput(raw)
    expect(out.metadata.features.length).toBe(1)
    expect(out.metadata.features[0].title).toBe('Spawn parent tracking')
    expect(out.metadata.features[0].detail).toBe('Track parent/root conversation relationships')
    expect(out.metadata.features[0].conversations).toEqual(['807269d9', '3352290f'])
    expect(out.metadata.features[0].commits).toEqual(['de2815a9'])
  })

  it('parses [inferred]-prefixed flow-map title', () => {
    const raw = `---
subtitle: inferred prefix
gotchas:
  - {title: "[inferred] Bun fs.watch unreliable on macOS", detail: "watch events drop"}
---

body`
    const out = parseRecapOutput(raw)
    expect(out.metadata.gotchas[0].title).toBe('Bun fs.watch unreliable on macOS')
    expect(out.metadata.gotchas[0].inferred).toBe(true)
  })

  it('parses Pillar F retrospect fields in flow-map form', () => {
    const raw = `---
subtitle: retro flow
went_well:
  - {title: Chunking shipped clean, commits: [abc1234]}
recommendations:
  - {title: Add lint rule for ccSessionId, detail: "encode the boundary covenant", conversations: [conv_xyz789]}
---

## Retrospective
body`
    const out = parseRecapOutput(raw)
    expect(out.metadata.went_well?.[0].title).toBe('Chunking shipped clean')
    expect(out.metadata.went_well?.[0].commits).toEqual(['abc1234'])
    expect(out.metadata.recommendations?.[0].title).toContain('lint rule')
    expect(out.metadata.recommendations?.[0].conversations).toEqual(['conv_xyz789'])
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
