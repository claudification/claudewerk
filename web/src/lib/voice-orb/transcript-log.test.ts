import { describe, expect, it } from 'vitest'
import type { SpokenLine } from './caption-fold'
import { appendLine, foldLog, TRANSCRIPT_LIMIT, typedLine } from './transcript-log'

const agent = (text: string, partial: boolean): SpokenLine => ({ role: 'agent', text, partial })
const user = (text: string): SpokenLine => ({ role: 'user', text, partial: false })

/** Feed a whole stream through, the way the session does. */
const stream = (...chunks: SpokenLine[]) => chunks.reduce<SpokenLine[]>((log, c) => foldLog(log, c), [])

describe('an agent turn is ONE entry', () => {
  it('appends fragments instead of one entry per delta', () => {
    const log = stream(agent('four ', true), agent('live, ', true), agent('one wants you', true))
    expect(log).toEqual([agent('four live, one wants you', true)])
  })

  it('lets the FINAL chunk replace the fragments, never double the sentence', () => {
    const log = stream(agent('four ', true), agent('four live, one wants you', false))
    expect(log).toEqual([agent('four live, one wants you', false)])
  })

  it('starts a fresh entry once the turn has closed', () => {
    const log = stream(agent('done', false), agent('posted', true))
    expect(log).toEqual([agent('done', false), agent('posted', true)])
  })
})

describe('the log KEEPS what the caption throws away', () => {
  it('does not let a user utterance overwrite the orb mid-sentence', () => {
    // foldCaption REPLACES here -- correct on screen, data loss in a log.
    const log = stream(agent('checking th', true), user('never mind'))
    expect(log).toEqual([agent('checking th', true), user('never mind')])
  })

  it('keeps both sides in the order they were spoken', () => {
    const log = stream(user('status?'), agent('four live', false), user('all of it'))
    expect(log.map(l => l.role)).toEqual(['user', 'agent', 'user'])
  })
})

describe('typed input', () => {
  it('is a complete user line, never a partial', () => {
    expect(typedLine('paste: sk-abc123')).toEqual(user('paste: sk-abc123'))
  })

  it('appends without disturbing the open agent turn ordering', () => {
    const log = appendLine(stream(agent('four live', false)), typedLine('and the arr one?'))
    expect(log).toEqual([agent('four live', false), user('and the arr one?')])
  })
})

describe('the log is bounded', () => {
  it('drops the OLDEST lines past the limit, keeping the newest', () => {
    let log: SpokenLine[] = []
    for (let i = 0; i < TRANSCRIPT_LIMIT + 25; i++) log = appendLine(log, user(`line ${i}`))
    expect(log).toHaveLength(TRANSCRIPT_LIMIT)
    expect(log.at(-1)).toEqual(user(`line ${TRANSCRIPT_LIMIT + 24}`))
    expect(log[0]).toEqual(user('line 25'))
  })

  it('does not grow while one agent turn streams', () => {
    let log: SpokenLine[] = []
    for (let i = 0; i < 500; i++) log = foldLog(log, agent('x', true))
    expect(log).toHaveLength(1)
  })
})
