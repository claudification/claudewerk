import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommitIngestPayload } from '../../shared/commit-ledger'
import { classifyKind, parseConventional, splitMessage } from './categorize'
import { CommitPayloadError, normalizeCommit } from './normalize'
import { countCommits, ledgerStats, queryCommits } from './query'
import { closeCommitLedger, getCommitsByHash, initCommitLedger, insertCommit } from './store'

const REPO = 'claude://default/Users/x/proj'
const WORKTREE = 'claude://default/Users/x/proj/.claude/worktrees/feature'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commit-ledger-test-'))
  initCommitLedger(dir)
})

afterEach(() => {
  closeCommitLedger()
  rmSync(dir, { recursive: true, force: true })
})

function payload(over: Partial<CommitIngestPayload> = {}): CommitIngestPayload {
  return {
    hash: 'a'.repeat(40),
    parents: 'b'.repeat(40),
    repoUri: REPO,
    cwdUri: WORKTREE,
    branch: 'feature',
    subject: 'feat(ledger): record commits',
    files: [{ status: 'M', path: 'src/broker/auth.ts' }],
    committedAt: 1_700_000_000_000,
    ...over,
  }
}

function record(over: Partial<CommitIngestPayload> = {}, profile: string | null = null) {
  return insertCommit(normalizeCommit(payload(over), Date.now()), profile)
}

// ─── categorize ───────────────────────────────────────────────────────

test('parses conventional-commit headers, including scope and breaking', () => {
  expect(parseConventional('feat(broker)!: rip out the queue')).toEqual({
    ccType: 'feat',
    ccScope: 'broker',
    ccBreaking: true,
  })
  expect(parseConventional('just a plain message')).toEqual({ ccType: null, ccScope: null, ccBreaking: false })
})

test('kind comes from the reflog when it is available', () => {
  expect(classifyKind({ ...payload(), reflogAction: 'commit (amend): thing' }, 'thing')).toBe('amend')
  expect(classifyKind({ ...payload(), reflogAction: 'commit (merge): thing' }, 'thing')).toBe('merge')
  expect(classifyKind({ ...payload(), reflogAction: 'rebase (pick): thing' }, 'thing')).toBe('rebase')
})

test('kind falls back to parent count when no reflog is reported', () => {
  expect(classifyKind({ ...payload(), parents: '' }, 'first')).toBe('initial')
  expect(classifyKind({ ...payload(), parents: 'aaa bbb' }, 'merge branch')).toBe('merge')
  expect(classifyKind({ ...payload(), parents: 'aaa' }, 'Revert "x"')).toBe('revert')
})

test('a multi-line subject splits into subject + body', () => {
  expect(splitMessage('one\ntwo\nthree', '')).toEqual(['one', 'two\nthree'])
})

// ─── normalize ────────────────────────────────────────────────────────

test('rejects a payload with no usable hash or repo', () => {
  expect(() => normalizeCommit({ ...payload(), hash: 'nope' }, 1)).toThrow(CommitPayloadError)
  expect(() => normalizeCommit({ ...payload(), repoUri: '' }, 1)).toThrow(CommitPayloadError)
})

test('truncation is recorded, never silent', () => {
  const files = Array.from({ length: 900 }, (_, i) => ({ status: 'M', path: `src/f${i}.ts` }))
  const row = normalizeCommit(payload({ files, fileCount: 900 }), 1)
  expect(row.files).toHaveLength(500)
  expect(row.filesTruncated).toBe(true)
  expect(row.fileCount).toBe(900) // the REAL count survives the clamp
})

test('origin is agent only when a conversation id came with the commit', () => {
  expect(normalizeCommit(payload({ conversationId: 'conv-1' }), 1).origin).toBe('agent')
  expect(normalizeCommit(payload(), 1).origin).toBe('human')
})

// ─── store ────────────────────────────────────────────────────────────

test('records a commit and finds it by hash prefix', () => {
  const result = record({ conversationId: 'conv-1' })
  expect(result.inserted).toBe(true)
  const [row] = getCommitsByHash('aaaa')
  expect(row.subject).toBe('feat(ledger): record commits')
  expect(row.ccType).toBe('feat')
  expect(row.origin).toBe('agent')
  expect(row.files[0].path).toBe('src/broker/auth.ts')
})

test('re-posting the same commit is a duplicate, not an error or a second row', () => {
  expect(record().inserted).toBe(true)
  const second = record()
  expect(second.inserted).toBe(false)
  expect(countCommits({})).toBe(1)
})

test('an amend supersedes the commit it replaced', () => {
  record({ hash: 'a'.repeat(40) })
  const amended = record({ hash: 'c'.repeat(40), reflogAction: 'commit (amend): fix', subject: 'feat: fixed up' })
  expect(amended.supersededCount).toBe(1)
  expect(queryCommits({}).map(r => r.shortHash)).toEqual(['cccccccc'])
  expect(queryCommits({ includeSuperseded: true })).toHaveLength(2)
})

test('sibling commits off the same parent never supersede each other', () => {
  // The WORK MODE case: two worktrees both branch from main and both commit.
  record({ hash: 'a'.repeat(40) })
  const sibling = record({ hash: 'd'.repeat(40), reflogAction: 'commit: other worktree' })
  expect(sibling.supersededCount).toBe(0)
  expect(queryCommits({})).toHaveLength(2)
})

// ─── query ────────────────────────────────────────────────────────────

test('finds a project commits through either the repo or the worktree URI', () => {
  record({ conversationId: 'conv-1' })
  expect(queryCommits({ projectUris: [REPO] })).toHaveLength(1)
  expect(queryCommits({ projectUris: [WORKTREE] })).toHaveLength(1)
  expect(queryCommits({ projectUris: ['claude://default/Users/x/elsewhere'] })).toHaveLength(0)
})

test('matches a project URI that arrives in legacy triple-slash form', () => {
  record()
  expect(queryCommits({ projectUris: ['claude:///Users/x/proj'] })).toHaveLength(1)
})

test('full-text search hits the message and the touched paths', () => {
  record({ hash: 'a'.repeat(40), subject: 'fix(auth): stop the token race' })
  record({ hash: 'e'.repeat(40), subject: 'docs: readme', files: [{ status: 'M', path: 'README.md' }] })
  expect(queryCommits({ text: 'token race' }).map(r => r.shortHash)).toEqual(['aaaaaaaa'])
  expect(queryCommits({ text: 'auth.ts' }).map(r => r.shortHash)).toEqual(['aaaaaaaa'])
  expect(queryCommits({ text: 'readme' }).map(r => r.shortHash)).toEqual(['eeeeeeee'])
})

test('search survives punctuation that would make raw FTS5 throw', () => {
  record()
  for (const text of ['"', '((', 'AND', 'a AND OR "b']) {
    expect(() => queryCommits({ text })).not.toThrow()
  }
})

test('filters by conversation, origin and touched path', () => {
  record({ hash: 'a'.repeat(40), conversationId: 'conv-1' })
  record({ hash: 'e'.repeat(40), files: [{ status: 'A', path: 'docs/ops.md' }] })
  expect(queryCommits({ conversationId: 'conv-1' })).toHaveLength(1)
  expect(queryCommits({ origin: 'human' })).toHaveLength(1)
  expect(queryCommits({ path: 'docs/' }).map(r => r.shortHash)).toEqual(['eeeeeeee'])
})

test('ledger stats split agent from human work', () => {
  record({ hash: 'a'.repeat(40), conversationId: 'conv-1' })
  record({ hash: 'e'.repeat(40) })
  const stats = ledgerStats()
  expect(stats.total).toBe(2)
  expect(stats.agent).toBe(1)
  expect(stats.human).toBe(1)
})
