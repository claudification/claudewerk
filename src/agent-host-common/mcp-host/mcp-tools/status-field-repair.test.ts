import { describe, expect, test } from 'bun:test'
import { repairStatusField, repairStatusParams } from './status-field-repair'

/**
 * REGRESSION (2026-08-18, observed live): a set_status call mixed the two
 * parameter syntaxes. Only one form parses, so the closing tag and every later
 * field were swallowed into `pending` as literal text -- and `notes` / `caveats`
 * never arrived at all. The handoff card rendered a wall of raw XML.
 *
 * NOTE ON THIS FILE: the tag literals are ASSEMBLED from pieces rather than
 * typed out. Writing them whole would terminate the very tool call that creates
 * this file -- which is precisely the failure under test, and it happened once
 * while writing it.
 */
const LT = '<'
const open = (name: string) => `${LT}parameter name="${name}">`
const close = (name: string) => `${LT}/${name}>`
const closeParam = `${LT}/parameter>`

const LEAKED = [
  'One question, needs a yes: tightening needs_you.',
  close('pending'),
  `${open('notes')}Deliberately reporting this as done + a question.${closeParam}`,
  `${open('caveats')}main is RED and it is not mine.${closeParam}`,
].join('\n')

describe('repairStatusField', () => {
  test('splits the swallowed siblings back out', () => {
    const res = repairStatusField('pending', LEAKED)
    expect(res.repaired).toBe(true)
    expect(res.value).toBe('One question, needs a yes: tightening needs_you.')
    expect(res.fields.notes).toBe('Deliberately reporting this as done + a question.')
    expect(res.fields.caveats).toBe('main is RED and it is not mine.')
  })

  test('leaves a clean value completely untouched', () => {
    const clean = 'Run `Clear cache & reload`, then Cmd+K A.'
    const res = repairStatusField('pending', clean)
    expect(res.repaired).toBe(false)
    expect(res.value).toBe(clean)
    expect(res.fields).toEqual({})
  })

  test('does NOT touch legitimate markup in prose', () => {
    // Status fields are markdown; a user may paste real tags. A closing tag with
    // no parameter block after it is not a leak.
    const prose = `The fix was \`${LT}div role="dialog">\` -- see ${close('body')} in the snippet.`
    expect(repairStatusField('notes', prose).repaired).toBe(false)
  })

  test('recovers only known status fields, ignoring foreign ones', () => {
    const raw = ['text', close('done'), `${open('nonsense')}ignore me${closeParam}`].join('\n')
    const res = repairStatusField('done', raw)
    expect(res.value).toBe('text')
    expect(res.fields).toEqual({})
  })

  test('drops an empty recovered field rather than writing a blank', () => {
    const raw = ['text', close('done'), `${open('notes')}   ${closeParam}`].join('\n')
    expect(repairStatusField('done', raw).fields).toEqual({})
  })

  test('tolerates a final block with no closing tag', () => {
    const raw = ['text', close('done'), `${open('notes')}truncated mid-write`].join('\n')
    expect(repairStatusField('done', raw).fields.notes).toBe('truncated mid-write')
  })
})

describe('repairStatusParams', () => {
  test('reassembles the whole call', () => {
    const res = repairStatusParams({ state: 'done', pending: LEAKED })
    expect(res.repaired).toBe(true)
    expect(res.params.pending).toBe('One question, needs a yes: tightening needs_you.')
    expect(res.params.notes).toBe('Deliberately reporting this as done + a question.')
    expect(res.params.caveats).toBe('main is RED and it is not mine.')
    expect(res.params.state).toBe('done')
  })

  test('a properly-passed field WINS over a recovered one', () => {
    // Recovery is a fallback for what the parser dropped, never an override.
    const res = repairStatusParams({ state: 'done', pending: LEAKED, notes: 'the real notes' })
    expect(res.params.notes).toBe('the real notes')
  })

  test('a blank properly-passed field still yields to recovery', () => {
    const res = repairStatusParams({ state: 'done', pending: LEAKED, notes: '   ' })
    expect(res.params.notes).toBe('Deliberately reporting this as done + a question.')
  })

  test('is a no-op on a clean call', () => {
    const clean = { state: 'done', done: 'shipped it', notes: 'did not deploy' }
    const res = repairStatusParams(clean)
    expect(res.repaired).toBe(false)
    expect(res.params).toEqual(clean)
  })

  test('ignores non-string values without throwing', () => {
    const res = repairStatusParams({ state: 'done', safe_to_close: true, done: undefined })
    expect(res.repaired).toBe(false)
    expect(res.params.safe_to_close).toBe(true)
  })
})
