import { describe, expect, test } from 'vitest'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import { applyChip, buildTaskDraft, emptyChips, removeChip } from './task-chips'
import { boardTags, cutRange, parseTags, scanTaskToken, stripTags } from './task-tokens'

/** Apply a cut the way the editor would, so assertions read as final text. */
function eat(text: string, from: number, to: number): string {
  const r = cutRange(text, from, to)
  return text.slice(0, r.from) + text.slice(r.to)
}

/** Caret at end of `text` unless a position is given. */
const scan = (text: string, pos = text.length) => scanTaskToken(text, pos)

describe('scanTaskToken', () => {
  test('recognises each trigger and its kind', () => {
    expect(scan('@wall')).toMatchObject({ kind: 'epic', query: 'wall', start: 0 })
    expect(scan('!hi')).toMatchObject({ kind: 'priority', query: 'hi' })
    expect(scan('+card')).toMatchObject({ kind: 'dependsOn', query: 'card' })
    expect(scan('&card')).toMatchObject({ kind: 'relatesTo', query: 'card' })
    expect(scan(':opus')).toMatchObject({ kind: 'model', query: 'opus' })
    expect(scan('/claudewerk')).toMatchObject({ kind: 'project', query: 'claudewerk' })
  })

  /** `:` is the wall's own model sigil (pulse/query-types.ts), and it has to stay
   *  inert everywhere prose already uses a colon -- which is everywhere. */
  test('a colon inside prose is not a model hint', () => {
    expect(scan('note: x', 7)).toBeNull()
    expect(scan('10:30')).toBeNull()
    expect(scan('claude://default')).toBeNull()
  })

  test('a slash inside prose is not a project switch', () => {
    // "and/or", "12/25" -- no whitespace before the slash, so nothing fires.
    expect(scan('and/or')).toBeNull()
    expect(scan('12/25')).toBeNull()
  })

  test('a bare trigger opens the picker with an empty query', () => {
    expect(scan('fix it @')).toMatchObject({ kind: 'epic', query: '' })
  })

  test('reports the trigger offset so an accept can replace the whole token', () => {
    const hit = scan('ship the thing @wa')
    expect(hit?.start).toBe(15)
  })

  test('mid-word triggers stay inert -- an email is not an epic', () => {
    expect(scan('jonas@duplo')).toBeNull()
    expect(scan('a+b')).toBeNull()
  })

  test('punctuation after a trigger is prose, not a token', () => {
    // `![alt]` markdown image, `&amp;` entity -- neither may open a popup.
    expect(scan('![alt', 2)).toBeNull()
    expect(scan('&#38', 2)).toBeNull()
  })

  test('an unknown trigger char yields nothing', () => {
    expect(scan('%nope')).toBeNull()
    expect(scan('plain')).toBeNull()
  })

  test('whitespace inside the query ends the token', () => {
    expect(scan('@two words')).toBeNull()
  })
})

describe('parseTags', () => {
  test('collects hash-prefixed words, lowercased and deduped', () => {
    expect(parseTags('wire the ledger #Infra #wall #infra')).toEqual(['infra', 'wall'])
  })

  test('a tag must START the word -- C# and issue#4 are not tags', () => {
    expect(parseTags('port it to C# and close issue#4')).toEqual([])
  })

  test('a bare hash or punctuation-led hash produces nothing', () => {
    expect(parseTags('# heading style')).toEqual([])
    expect(parseTags('#-nope #')).toEqual([])
  })

  test('a tag at the very start of the text counts', () => {
    expect(parseTags('#urgent do the thing')).toEqual(['urgent'])
  })
})

describe('stripTags', () => {
  test('removes tags and collapses the gap they leave', () => {
    expect(stripTags('Wire the ledger #infra #wall')).toBe('Wire the ledger')
    expect(stripTags('Fix #infra the parser')).toBe('Fix the parser')
  })

  test('leaves a tag-free line untouched', () => {
    expect(stripTags('Wire the ledger')).toBe('Wire the ledger')
  })
})

describe('buildTaskDraft', () => {
  test('empty input yields no draft', () => {
    expect(buildTaskDraft('   \n ', emptyChips())).toBeNull()
  })

  test('title is tag-stripped while the body keeps the tags', () => {
    const draft = buildTaskDraft('Wire the ledger #infra\nsecond line #wall', emptyChips())
    expect(draft?.title).toBe('Wire the ledger')
    expect(draft?.body).toBe('second line #wall')
    expect(draft?.tags).toEqual(['infra', 'wall'])
  })

  test('a one-liner is both title and body, so nothing is lost', () => {
    const draft = buildTaskDraft('Just this #infra', emptyChips())
    expect(draft?.title).toBe('Just this')
    expect(draft?.body).toBe('Just this #infra')
  })

  test('a title that is nothing BUT tags keeps its raw text', () => {
    const draft = buildTaskDraft('#infra', emptyChips())
    expect(draft?.title).toBe('#infra')
  })

  test('chips ride along and empty lists are omitted, not sent as []', () => {
    const chips = applyChip(applyChip(emptyChips(), 'epic', 'epic-wall'), 'priority', 'high')
    const draft = buildTaskDraft('do it', chips)
    expect(draft).toMatchObject({ epic: 'epic-wall', priority: 'high' })
    expect(draft?.dependsOn).toBeUndefined()
    expect(draft?.relatesTo).toBeUndefined()
  })

  test('an accepted model chip reaches the draft', () => {
    const draft = buildTaskDraft('do it', applyChip(emptyChips(), 'model', 'opus'))
    expect(draft?.model).toBe('opus')
  })

  /** `#model-opus` is folded on the WRITE side (project-task-input.ts), once, so
   *  an MCP caller gets the same normalisation. The capture box keeps it as the
   *  tag it typed and does not grow a second copy of the rule. */
  test('a `#model-` tag stays a tag here -- the fold belongs to the writer', () => {
    const draft = buildTaskDraft('do it #model-opus', emptyChips())
    expect(draft?.tags).toEqual(['model-opus'])
    expect(draft?.model).toBeUndefined()
  })
})

describe('applyChip / removeChip', () => {
  test('epic and priority are single-valued -- picking again replaces', () => {
    const chips = applyChip(applyChip(emptyChips(), 'epic', 'one'), 'epic', 'two')
    expect(chips.epic).toBe('two')
  })

  test('model is single-valued too, and removable', () => {
    let chips = applyChip(applyChip(emptyChips(), 'model', 'haiku'), 'model', 'opus')
    expect(chips.model).toBe('opus')
    chips = removeChip(chips, 'model')
    expect(chips.model).toBeUndefined()
  })

  test('list kinds append and dedupe', () => {
    let chips = applyChip(emptyChips(), 'dependsOn', 'a')
    chips = applyChip(chips, 'dependsOn', 'b')
    chips = applyChip(chips, 'dependsOn', 'a')
    expect(chips.dependsOn).toEqual(['a', 'b'])
  })

  test('removing clears a scalar and splices a list', () => {
    let chips = applyChip(applyChip(emptyChips(), 'epic', 'e'), 'relatesTo', 'x')
    chips = applyChip(chips, 'relatesTo', 'y')
    chips = removeChip(chips, 'epic')
    chips = removeChip(chips, 'relatesTo', 'x')
    expect(chips.epic).toBeUndefined()
    expect(chips.relatesTo).toEqual(['y'])
  })

  test('the input chip set is never mutated', () => {
    const before = emptyChips()
    applyChip(before, 'dependsOn', 'a')
    expect(before.dependsOn).toEqual([])
  })
})

describe('cutRange -- what accepting a token removes', () => {
  test('a token mid-sentence leaves ONE space, not two', () => {
    const text = 'fix @wall now'
    expect(eat(text, 4, 9)).toBe('fix now')
  })

  test('a token at end of line keeps the space before it', () => {
    const text = 'fix @wall'
    expect(eat(text, 4, 9)).toBe('fix ')
  })

  test('a token at the very start eats only itself', () => {
    const text = '@wall fix it'
    expect(eat(text, 0, 5)).toBe(' fix it')
  })

  test('a token before a newline still collapses its leading space', () => {
    const text = 'fix @wall\nmore'
    expect(eat(text, 4, 9)).toBe('fix\nmore')
  })
})

describe('boardTags', () => {
  test('unions every card tag, lowercased, sorted', () => {
    const tasks = [{ tags: ['Wall', 'infra'] }, { tags: ['infra', 'perf'] }] as ProjectTaskMeta[]
    expect(boardTags(tasks)).toEqual(['infra', 'perf', 'wall'])
  })
})
