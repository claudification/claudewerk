import { describe, expect, test } from 'vitest'
import { type CandidateSource, liveCandidates, matchCandidates } from './canvas-chat-candidates'

const PROJECT = 'claude://default/Users/jonas/projects/remote-claude'
const OTHER = 'claude://default/Users/jonas/projects/agent-drop'

function conv(over: Partial<CandidateSource> & Pick<CandidateSource, 'id'>): CandidateSource {
  return { project: PROJECT, status: 'idle', lastActivity: 0, title: over.id, ...over }
}

describe('liveCandidates', () => {
  test('drops ended conversations -- they have no socket to talk to', () => {
    const out = liveCandidates([conv({ id: 'dead', status: 'ended' }), conv({ id: 'alive', status: 'idle' })], PROJECT)
    expect(out.map(c => c.id)).toEqual(['alive'])
  })

  test("drops other projects, including this project's own worktrees", () => {
    const out = liveCandidates(
      [
        conv({ id: 'mine' }),
        conv({ id: 'elsewhere', project: OTHER }),
        conv({ id: 'worktree', project: `${PROJECT}/.claude/worktrees/foo` }),
      ],
      PROJECT,
    )
    expect(out.map(c => c.id)).toEqual(['mine'])
  })

  test('ranks active > booting/starting > idle, then most recent first', () => {
    const out = liveCandidates(
      [
        conv({ id: 'idle-new', status: 'idle', lastActivity: 900 }),
        conv({ id: 'starting', status: 'starting', lastActivity: 1 }),
        conv({ id: 'active-old', status: 'active', lastActivity: 2 }),
        conv({ id: 'active-new', status: 'active', lastActivity: 500 }),
        conv({ id: 'booting', status: 'booting', lastActivity: 5 }),
      ],
      PROJECT,
    )
    expect(out.map(c => c.id)).toEqual(['active-new', 'active-old', 'booting', 'starting', 'idle-new'])
  })

  test('falls back to an id prefix when the conversation has no title', () => {
    const out = liveCandidates([conv({ id: 'conv_abcdef123456', title: undefined })], PROJECT)
    expect(out[0]).toEqual({ id: 'conv_abcdef123456', name: 'conv_abc', status: 'idle' })
  })
})

describe('matchCandidates', () => {
  const rows = liveCandidates(
    [conv({ id: 'a', title: 'Nuclear Pelican' }), conv({ id: 'b', title: 'volatile-nugget' })],
    PROJECT,
  )

  test('blank query keeps everything', () => {
    expect(matchCandidates(rows, '   ')).toHaveLength(2)
  })

  test('matches case-insensitively on the name', () => {
    expect(matchCandidates(rows, 'PELI').map(c => c.id)).toEqual(['a'])
  })

  test('matches on the conversation id too, so a pasted id lands', () => {
    expect(matchCandidates(rows, 'b').map(c => c.id)).toEqual(['b'])
  })

  test('no match is empty, not everything', () => {
    expect(matchCandidates(rows, 'zzz')).toEqual([])
  })
})
