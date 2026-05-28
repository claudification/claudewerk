import { describe, expect, it } from 'bun:test'
import { parseGitLogOutput } from './git-log'

const RS = '\x1e'
const US = '\x1f'
const GS = '\x1d'

describe('parseGitLogOutput', () => {
  it('parses commits with numstat sums', () => {
    const out =
      `${RS}abc1234${US}2026-05-28T10:00:00+00:00${US}Jonas${US}fix: the thing${US}body line${GS}\n` +
      `10\t2\tsrc/a.ts\n` +
      `5\t0\tsrc/b.ts\n` +
      `\n` +
      `${RS}def5678${US}2026-05-27T09:00:00+00:00${US}Jonas${US}feat: stuff${US}${GS}\n` +
      `-\t-\timage.png\n`
    const commits = parseGitLogOutput(out)
    expect(commits.length).toBe(2)
    expect(commits[0].sha).toBe('abc1234')
    expect(commits[0].subject).toBe('fix: the thing')
    expect(commits[0].author).toBe('Jonas')
    expect(commits[0].body).toBe('body line')
    expect(commits[0].filesChanged).toBe(2)
    expect(commits[0].insertions).toBe(15)
    expect(commits[0].deletions).toBe(2)
    // Binary file ('-\t-') counts as a changed file with 0 ins/del; empty body.
    expect(commits[1].sha).toBe('def5678')
    expect(commits[1].body).toBe('')
    expect(commits[1].filesChanged).toBe(1)
    expect(commits[1].insertions).toBe(0)
    expect(commits[1].deletions).toBe(0)
  })

  it('handles multi-line commit bodies (US-joined) and commas in subjects', () => {
    const out = `${RS}aaa${US}2026-05-28T10:00:00+00:00${US}A B${US}chore: x, y, z${US}line1\nline2${GS}\n1\t1\tf.ts\n`
    const commits = parseGitLogOutput(out)
    expect(commits[0].subject).toBe('chore: x, y, z')
    expect(commits[0].body).toBe('line1\nline2')
  })

  it('returns [] for empty output', () => {
    expect(parseGitLogOutput('')).toEqual([])
    expect(parseGitLogOutput('\n\n')).toEqual([])
  })
})
