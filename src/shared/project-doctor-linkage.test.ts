import { describe, expect, it } from 'bun:test'
import { checkLinkageKeys } from './project-doctor-linkage'

const checks = (meta: Record<string, unknown>) => checkLinkageKeys({ id: 'c', meta }).map(f => f.check)
const only = (meta: Record<string, unknown>) => checkLinkageKeys({ id: 'c', meta })[0]

describe('a typo in a verb surfaces instead of vanishing', () => {
  it('catches a hyphen where the board uses an underscore', () => {
    const f = only({ 'depends-on': ['a'] })
    expect(f.check).toBe('linkage-verb-typo')
    expect(f.severity).toBe('warning')
    expect(f.problem).toContain('depends_on')
  })

  it('catches camelCase', () => {
    expect(only({ dependsOn: ['a'] }).check).toBe('linkage-verb-typo')
  })

  it('catches a stray plural', () => {
    expect(only({ epics: 'e' }).problem).toContain('epic')
  })

  it('catches a one-letter slip in a long key', () => {
    expect(only({ blocked_bu: ['a'] }).problem).toContain('blocked_by')
  })

  it('names the key that does not work AND the one that does', () => {
    const f = only({ relates_too: ['a'] })
    expect(f.problem).toContain('relates_too')
    expect(f.remedy).toContain('relates_to')
  })
})

describe('unfamiliar keys are LEFT ALONE -- preserve-unknown-keys is a promise', () => {
  it('says nothing about the gate machinery', () => {
    expect(
      checks({
        evidence_branch: 'x',
        evidence_commits: ['abc'],
        evidence_diffstat: '1 file',
        gate: 'y',
        test_cmd: 'z',
      }),
    ).toEqual([])
  })

  it('says nothing about the keys the store owns', () => {
    expect(checks({ title: 't', status: 'open', priority: 'high', tags: ['a'], created: '2026-01-01' })).toEqual([])
  })

  it('says nothing about authorship, which is not a relationship', () => {
    expect(checks({ created_by: 'jonas', owned_by: 'agent' })).toEqual([])
  })

  it('says nothing about a short key that merely rhymes with a verb', () => {
    // `pic` is one edit from `epic`, and near-miss matching deliberately stops
    // below five characters -- at four the guesses are noise, not help.
    expect(checks({ pic: 'x', foo: 'y' })).toEqual([])
  })

  it('but a singular `ref:` IS the typo it looks like', () => {
    expect(only({ ref: 'x' }).remedy).toContain('refs')
  })
})

describe('a key whose first word is relational is reported, gently', () => {
  it('flags an invented relation at info level', () => {
    const f = only({ supersedes: ['old-card'] })
    expect(f.check).toBe('linkage-verb-unknown')
    expect(f.severity).toBe('info')
  })

  it('lists the verbs that DO work', () => {
    expect(only({ parent_card: 'e' }).remedy).toContain('depends_on')
  })

  it('does not advertise deprecated verbs as a fix', () => {
    expect(only({ subtask_of: ['a'] }).remedy).not.toContain('blocks')
  })

  it('flags each of the usual inventions', () => {
    for (const key of ['duplicate_of', 'child_of', 'tracks', 'part_of', 'follows']) {
      expect(checks({ [key]: ['a'] })).toEqual(['linkage-verb-unknown'])
    }
  })
})

describe('a registered verb is never reported as unknown', () => {
  it('holds for every real verb', () => {
    expect(checks({ epic: 'e', depends_on: ['a'], relates_to: ['b'], quest: 'q', refs: ['x'] })).toEqual([])
  })
})

describe('aliases are announced, not scolded', () => {
  it('blocked_by is info -- it genuinely works', () => {
    const f = only({ blocked_by: ['a'] })
    expect(f.check).toBe('linkage-alias')
    expect(f.severity).toBe('info')
    expect(f.remedy).toContain('depends_on')
  })

  it('see_also likewise', () => {
    expect(only({ see_also: ['a'] }).remedy).toContain('relates_to')
  })
})

describe('deprecated verbs', () => {
  it('blocks with real content says what replaced it', () => {
    const f = only({ blocks: ['a'] })
    expect(f.check).toBe('linkage-deprecated')
    expect(f.remedy).toContain('depends_on')
  })

  it('an EMPTY blocks list is left alone -- it asserts nothing', () => {
    expect(checks({ blocks: [] })).toEqual([])
  })
})

describe('arity', () => {
  it('a list where one value belongs is a warning -- the rest are lost', () => {
    const f = only({ epic: ['a', 'b'] })
    expect(f.check).toBe('linkage-arity')
    expect(f.severity).toBe('warning')
    expect(f.problem).toContain('only the first')
  })

  it('a bare string where a list belongs is info -- it is read, just not canonical', () => {
    const f = only({ depends_on: 'a' })
    expect(f.check).toBe('linkage-arity')
    expect(f.severity).toBe('info')
  })

  it('correct shapes report nothing', () => {
    expect(checks({ epic: 'e', depends_on: ['a'], quest: 'q' })).toEqual([])
  })

  it('an empty value of any verb is silent', () => {
    expect(checks({ epic: '', depends_on: [], relates_to: [] })).toEqual([])
  })
})

describe('every finding carries a remedy', () => {
  it('holds across every check in this file', () => {
    const findings = checkLinkageKeys({
      id: 'c',
      meta: { 'depends-on': ['a'], supersedes: ['b'], blocked_by: ['c'], blocks: ['d'], epic: ['e', 'f'] },
    })
    expect(new Set(findings.map(f => f.check)).size).toBe(5)
    for (const f of findings) expect(f.remedy.length).toBeGreaterThan(0)
  })
})
