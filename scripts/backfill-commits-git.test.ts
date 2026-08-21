/**
 * The backfill's git parsing, tested without a repo.
 *
 * The fixtures below are the exact byte shape `git log` emits with the format in
 * `backfill-commits-git.ts` -- separators included -- because the whole class of
 * bug this file exists to catch is a field boundary drifting silently and every
 * commit after it landing shifted by one.
 */

import { describe, expect, it } from 'bun:test'
import { applyNumstatPass, logArgs, parseNameStatusPass, repoUriFor, toIngestPayload } from './backfill-commits-git'

const FS = '\x1f'
const RS = '\x1e'

/** One record exactly as git emits it: leading RS, seven FS-joined fields, then
 *  the diff block after the seventh separator. */
const record = (hash: string, parents: string, at: number, subject: string, body: string, diff: string): string =>
  `${RS}${hash}${FS}${parents}${FS}Jonas Frost${FS}j@duplo.org${FS}${at}${FS}${subject}${FS}${body}${FS}\n${diff}`

describe('parseNameStatusPass', () => {
  it('reads a plain commit with its files', () => {
    const raw = record(
      'a'.repeat(40),
      'b'.repeat(40),
      1_787_118_657,
      'fix: the thing',
      '',
      'M\tsrc/a.ts\nA\tsrc/b.ts\n',
    )
    const commits = parseNameStatusPass(raw)

    const commit = commits.get('a'.repeat(40))
    expect(commit).toBeDefined()
    expect(commit?.subject).toBe('fix: the thing')
    expect(commit?.committedAt).toBe(1_787_118_657_000)
    expect(commit?.files).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'src/b.ts' },
    ])
  })

  it('keeps a rename as one file with its old path, not as a delete plus an add', () => {
    const raw = record('c'.repeat(40), 'd'.repeat(40), 1, 'refactor: move it', '', 'R100\told/x.ts\tnew/x.ts\n')
    const commit = parseNameStatusPass(raw).get('c'.repeat(40))

    expect(commit?.files).toEqual([{ status: 'R100', path: 'new/x.ts', from: 'old/x.ts' }])
  })

  it('survives a multi-line body without swallowing the file list', () => {
    // The body is the field most likely to break the record: it is the only one
    // that legitimately contains newlines.
    const body = 'first line\n\nsecond paragraph\n- a bullet'
    const raw = record('e'.repeat(40), 'f'.repeat(40), 2, 'feat: x', body, 'M\tREADME.md\n')
    const commit = parseNameStatusPass(raw).get('e'.repeat(40))

    expect(commit?.body).toBe(body)
    expect(commit?.files).toEqual([{ status: 'M', path: 'README.md' }])
  })

  it('gives a merge no files, because git gives it no diff', () => {
    const raw = record('1'.repeat(40), `${'2'.repeat(40)} ${'3'.repeat(40)}`, 3, 'Merge branch x', '', '')
    const commit = parseNameStatusPass(raw).get('1'.repeat(40))

    expect(commit?.files).toEqual([])
    // Two parents travel to the broker, which is what makes it `kind: merge`
    // there rather than here.
    expect(commit?.parents.split(' ')).toHaveLength(2)
  })

  it('reads every record in a multi-commit log', () => {
    const raw =
      record('a'.repeat(40), '', 1, 'one', '', 'M\ta.ts\n') + record('b'.repeat(40), '', 2, 'two', '', 'M\tb.ts\n')

    expect(parseNameStatusPass(raw).size).toBe(2)
  })
})

describe('applyNumstatPass', () => {
  it('folds line counts onto the commits already read', () => {
    const commits = parseNameStatusPass(record('a'.repeat(40), '', 1, 'x', '', 'M\ta.ts\n'))
    applyNumstatPass(`${RS}${'a'.repeat(40)}${FS}${FS}${FS}${FS}${FS}${FS}${FS}\n12\t3\ta.ts\n4\t5\tb.ts\n`, commits)

    const commit = commits.get('a'.repeat(40))
    expect(commit?.insertions).toBe(16)
    expect(commit?.deletions).toBe(8)
  })

  it('does NOT count a binary file as zero changes', () => {
    // git reports `-` for a binary, meaning "not countable". Coercing that to 0
    // and summing it would report a confident number for something git refused
    // to measure.
    const commits = parseNameStatusPass(record('a'.repeat(40), '', 1, 'x', '', 'M\tlogo.png\n'))
    applyNumstatPass(`${RS}${'a'.repeat(40)}${FS.repeat(7)}\n-\t-\tlogo.png\n`, commits)

    expect(commits.get('a'.repeat(40))?.insertions).toBe(0)
  })

  it('ignores a hash the first pass never saw', () => {
    const commits = parseNameStatusPass(record('a'.repeat(40), '', 1, 'x', '', 'M\ta.ts\n'))
    applyNumstatPass(`${RS}${'9'.repeat(40)}${FS.repeat(7)}\n9\t9\tz.ts\n`, commits)

    expect(commits.get('a'.repeat(40))?.insertions).toBe(0)
    expect(commits.size).toBe(1)
  })
})

describe('toIngestPayload', () => {
  const ctx = {
    sentinel: 'default',
    repoRoot: '/Users/jonas/projects/links',
    repoName: 'links',
    branch: 'main',
    host: 'studio',
    osUser: 'jonas',
  }

  it('always declares backfill, which is what keeps the origin honest', () => {
    const commit = parseNameStatusPass(record('a'.repeat(40), '', 7, 'x', '', 'M\ta.ts\n')).get('a'.repeat(40))
    const payload = toIngestPayload(commit as NonNullable<typeof commit>, ctx)

    // Drop this and every backfilled commit lands as `origin: 'human'`.
    expect(payload.backfill).toBe(true)
    expect(payload.conversationId).toBeUndefined()
    expect(payload.repoUri).toBe('claude://default/Users/jonas/projects/links')
    expect(payload.committedAt).toBe(7000)
  })

  it('files a worktree commit under the main repo URI', () => {
    // Both URIs are the repo root: the walk reads the shared history once, and
    // filing half of it under a worktree path would split one project in two.
    const commit = parseNameStatusPass(record('a'.repeat(40), '', 7, 'x', '', '')).get('a'.repeat(40))
    const payload = toIngestPayload(commit as NonNullable<typeof commit>, ctx)

    expect(payload.cwdUri).toBe(payload.repoUri)
    expect(payload.isWorktree).toBe(false)
  })
})

describe('logArgs', () => {
  it('asks for name-status and numstat SEPARATELY, never both at once', () => {
    // Passing both to one `git log` silently yields only the later flag. This is
    // the assertion that stops someone "optimizing" the two passes into one.
    const names = logArgs('13 months ago', [], false)
    const nums = logArgs('13 months ago', [], true)

    expect(names).toContain('--name-status')
    expect(names).not.toContain('--numstat')
    expect(nums).toContain('--numstat')
    expect(nums).not.toContain('--name-status')
  })

  it('passes one --author per email, and none when unfiltered', () => {
    expect(logArgs('x', ['a@b.c', 'd@e.f'], false).filter(a => a.startsWith('--author='))).toEqual([
      '--author=a@b.c',
      '--author=d@e.f',
    ])
    expect(logArgs('x', [], false).some(a => a.startsWith('--author='))).toBe(false)
  })

  it('follows renames', () => {
    expect(logArgs('x', [], false)).toContain('-M')
  })
})

describe('repoUriFor', () => {
  it('matches the shape the post-commit hook builds in bash', () => {
    expect(repoUriFor('default', '/Users/jonas/projects/me')).toBe('claude://default/Users/jonas/projects/me')
  })
})
