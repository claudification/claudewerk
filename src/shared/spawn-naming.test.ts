import { describe, expect, it } from 'bun:test'
import {
  deriveConversationName,
  sanitizeConversationName,
  uniqueConversationName,
  validateConversationName,
} from './spawn-naming'
import type { TaskMeta } from './spawn-prompt'

const task: TaskMeta = {
  slug: 't-1',
  title: 'Build the rocket',
  status: 'open',
  priority: 'high',
  tags: ['alpha'],
}

describe('sanitizeSessionName', () => {
  it('strips single and double quotes', () => {
    expect(sanitizeConversationName(`"hello" 'world'`)).toBe('hello world')
  })

  it('collapses whitespace and trims', () => {
    expect(sanitizeConversationName('  a\t\tb\n\nc  ')).toBe('a b c')
  })

  it('truncates to 60 characters', () => {
    const s = 'x'.repeat(120)
    expect(sanitizeConversationName(s)).toHaveLength(60)
  })
})

// Every input below is a REAL title off this project's board. Launching one of
// these put its raw markdown straight into the conversation list.
describe('sanitizing a card title into a conversation name', () => {
  it('unwraps inline code but keeps the flag it wrapped', () => {
    expect(sanitizeConversationName('add launch/run/revive support of `--agent <name>`')).toBe(
      'add launch/run/revive support of --agent name',
    )
  })

  it('drops a lonely fence delimiter', () => {
    expect(sanitizeConversationName('ANVIL @code block (the ~~~ literal delimiter)')).toBe(
      'ANVIL @code block (the literal delimiter)',
    )
  })

  it('keeps the words inside emphasis', () => {
    expect(sanitizeConversationName('**A**gent-**N**ative **V**isual')).toBe('Agent-Native Visual')
    expect(sanitizeConversationName('the **spawn request shape** is duplicated')).toBe(
      'the spawn request shape is duplicated',
    )
  })

  it('drops a heading marker a pasted title carried along', () => {
    expect(sanitizeConversationName('## Symptom: the EPICS view')).toBe('Symptom: the EPICS view')
  })

  it('keeps a colon, which is how half these cards are titled', () => {
    expect(sanitizeConversationName('"EPIC: inline interaction language"')).toBe('EPIC: inline interaction language')
    expect(sanitizeConversationName('"feat: agent direct-spawns headless sessions (no tmux)"')).toBe(
      'feat: agent direct-spawns headless sessions (no tmux)',
    )
  })

  it('keeps slashes, plus, at-signs and parens -- none of them are unsafe here', () => {
    expect(sanitizeConversationName('Add CTRL+K command to reload the SW :-)')).toBe(
      'Add CTRL+K command to reload the SW :-)',
    )
  })

  it('unwraps a link to its text', () => {
    expect(sanitizeConversationName('see [the plan](.claude/docs/plan-fabric.md)')).toBe('see the plan')
  })

  it('strips control characters and newlines from a pasted title', () => {
    expect(sanitizeConversationName('first line\nsecondline')).toBe('first line second line')
  })

  it('leaves nothing dangling when truncation lands mid-punctuation', () => {
    const out = sanitizeConversationName(`${'x'.repeat(58)} -- tail`)
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out).toBe('x'.repeat(58))
  })

  it('survives a title that is nothing but syntax', () => {
    expect(sanitizeConversationName('***')).toBe('')
    expect(sanitizeConversationName('`` ``')).toBe('')
  })

  it('does not eat a lone asterisk or an underscore mid-word', () => {
    expect(sanitizeConversationName('2 * 3 and snake_case')).toBe('2 * 3 and snake_case')
  })
})

describe('deriveSessionName', () => {
  it('uses explicit name when provided', () => {
    expect(deriveConversationName({ name: 'my session' })).toBe('my session')
  })

  it('prefers explicit name over task.title', () => {
    expect(deriveConversationName({ name: 'override' }, task)).toBe('override')
  })

  it('falls back to task.title when name is absent', () => {
    expect(deriveConversationName({}, task)).toBe('Build the rocket')
  })

  it('falls back to first non-empty line of prompt', () => {
    const out = deriveConversationName({ prompt: '\n\nFirst real line\nsecond line' })
    expect(out).toBe('First real line')
  })

  it('returns null when no hints are present', () => {
    expect(deriveConversationName({})).toBeNull()
    expect(deriveConversationName({ prompt: '' })).toBeNull()
    expect(deriveConversationName({ prompt: '\n  \n\t\n' })).toBeNull()
  })

  it('strips quotes in derived name', () => {
    expect(deriveConversationName({ name: `"quoted"` })).toBe('quoted')
  })

  it('truncates long task titles to 60 chars', () => {
    const long = { ...task, title: 'x'.repeat(200) }
    const out = deriveConversationName({}, long)
    expect(out).toHaveLength(60)
  })

  it('ignores empty explicit name and advances to next hint', () => {
    expect(deriveConversationName({ name: '   ' }, task)).toBe('Build the rocket')
  })
})

describe('validateConversationName', () => {
  it('returns null for a valid unique name', () => {
    expect(validateConversationName('fresh-name', new Set(['other']))).toBeNull()
  })

  it('rejects names that collide with existing sessions', () => {
    expect(validateConversationName('taken', new Set(['taken']))).toContain('already in use')
  })

  it('rejects empty-after-sanitization names', () => {
    expect(validateConversationName('   ', new Set())).toContain('empty')
  })

  it('detects collision after sanitization (quotes stripped)', () => {
    expect(validateConversationName('"my session"', new Set(['my session']))).toContain('already in use')
  })
})

/**
 * `failOnNameCollision: false` -- the caller that would rather be renamed than
 * refused. Uniqueness is checked against every conversation that has EVER
 * existed, which is right for a human at the launch dialog and wrong for an
 * unattended engine: re-dispatching the same unit of work produces the same name
 * by construction, so the 400 made retry structurally impossible.
 */
describe('uniqueConversationName', () => {
  it('a free name is returned untouched', () => {
    expect(uniqueConversationName('feat: the wall', new Set())).toBe('feat: the wall')
  })

  it('a taken name gets the first free numeric suffix', () => {
    expect(uniqueConversationName('feat: the wall', new Set(['feat: the wall']))).toBe('feat: the wall (2)')
  })

  it('it keeps counting past the ones already taken', () => {
    const taken = new Set(['x', 'x (2)', 'x (3)'])
    expect(uniqueConversationName('x', taken)).toBe('x (4)')
  })

  it('it sanitizes first, so it collides on what would actually be STORED', () => {
    expect(uniqueConversationName('**bold**', new Set(['bold']))).toBe('bold (2)')
  })

  /**
   * A name is truncated from the RIGHT. Appending past the budget would slice
   * the disambiguator straight back off and return a name that still collides --
   * so the stem is trimmed to make room instead.
   */
  it('a name at the length limit is TRIMMED to make room for the suffix', () => {
    const long = 'w'.repeat(80)
    const stem = sanitizeConversationName(long)
    const out = uniqueConversationName(long, new Set([stem]))
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out.endsWith(' (2)')).toBe(true)
    expect(out).not.toBe(stem)
  })

  it('and the trimmed result is genuinely free, not a re-collision', () => {
    const long = 'w'.repeat(80)
    const stem = sanitizeConversationName(long)
    const first = uniqueConversationName(long, new Set([stem]))
    const second = uniqueConversationName(long, new Set([stem, first]))
    expect(second).not.toBe(first)
    expect(second.length).toBeLessThanOrEqual(60)
  })

  it('an empty-after-sanitization name stays empty rather than becoming " (2)"', () => {
    expect(uniqueConversationName('***', new Set(['']))).toBe('')
  })
})
