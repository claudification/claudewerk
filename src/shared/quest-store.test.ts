/**
 * Tier 1 unit tests for the QUEST store (plan-quest-engine §4b/§14). Round-trips
 * the manifest (frontmatter scalars + goal + json-fenced contracts) through
 * disk, proves petname collision-avoidance at create time, and enforces the
 * APPEND-ONLY log property (§4e -- the log can never be rewritten).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QuestAcceptanceContract } from './quest-schema'
import {
  appendLogEntry,
  createQuest,
  getQuest,
  listQuestNames,
  listQuests,
  patchManifest,
  readLog,
  readManifest,
} from './quest-store'

let root: string
const NOW = Date.UTC(2026, 6, 5, 9, 0, 0)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quest-store-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const CONTRACTS: QuestAcceptanceContract[] = [
  { id: '001', command: 'bun test src/foo', description: 'unit tests pass' },
  { id: '002', command: 'bun run lint && tsc --noEmit' },
]

describe('manifest round-trip', () => {
  test('create -> read preserves every field incl. goal + contracts', () => {
    const m = createQuest(
      root,
      {
        project: 'claude:///Users/jonas/projects/foo',
        goal: 'Ship the widget, end to end.\nMulti-line goal survives.',
        target: 'merged',
        gate: 'blessed',
        contracts: CONTRACTS,
        petname: 'floppy-panda',
      },
      NOW,
    )
    expect(m.petname).toBe('floppy-panda')
    const read = readManifest(root, 'floppy-panda')
    expect(read).toEqual(m)
    expect(read?.goal).toContain('Multi-line goal survives.')
    expect(read?.contracts).toEqual(CONTRACTS)
    expect(read?.target).toBe('merged')
    expect(read?.gate).toBe('blessed')
    expect(read?.status).toBe('intake')
  })

  test('defaults: target=pr, status=intake, gate=pending, empty contracts', () => {
    const m = createQuest(root, { project: 'p', goal: 'g', petname: 'brave-otter' }, NOW)
    expect(m.target).toBe('pr')
    expect(m.status).toBe('intake')
    expect(m.gate).toBe('pending')
    expect(m.contracts).toEqual([])
  })

  test('patchManifest updates fields + bumps updated, never touches created', () => {
    createQuest(root, { project: 'p', goal: 'g', petname: 'brave-otter' }, NOW)
    const patched = patchManifest(root, 'brave-otter', { status: 'running', target: 'shipped' }, NOW + 1000)
    expect(patched?.status).toBe('running')
    expect(patched?.target).toBe('shipped')
    expect(patched?.created).toBe(readManifest(root, 'brave-otter')?.created)
    expect(patched?.updated).toBe(new Date(NOW + 1000).toISOString())
    expect(patched?.created).not.toBe(patched?.updated)
  })

  test('patch/read on a missing quest returns null', () => {
    expect(readManifest(root, 'no-such')).toBeNull()
    expect(patchManifest(root, 'no-such', { status: 'paused' }, NOW)).toBeNull()
    expect(getQuest(root, 'no-such')).toBeNull()
  })

  test('rejects a path-traversal petname', () => {
    expect(() => createQuest(root, { project: 'p', goal: 'g', petname: '../evil' }, NOW)).toThrow()
  })
})

describe('petname collision', () => {
  test('auto-generated petnames never collide across many creates', () => {
    const names = new Set<string>()
    for (let i = 0; i < 60; i++) {
      const m = createQuest(root, { project: 'p', goal: `g${i}` }, NOW + i)
      expect(names.has(m.petname)).toBe(false)
      names.add(m.petname)
    }
    expect(listQuestNames(root).sort()).toEqual([...names].sort())
  })

  test('a forced duplicate petname throws', () => {
    createQuest(root, { project: 'p', goal: 'g', petname: 'floppy-panda' }, NOW)
    expect(() => createQuest(root, { project: 'p', goal: 'g2', petname: 'floppy-panda' }, NOW)).toThrow(
      /already exists/,
    )
  })
})

describe('append-only log (§4e)', () => {
  test('appends accumulate in order and are never rewritten', () => {
    createQuest(root, { project: 'p', goal: 'g', petname: 'floppy-panda' }, NOW)
    appendLogEntry(root, 'floppy-panda', { kind: 'intent', convId: 'conv_a', body: 'about to branch' }, NOW)
    appendLogEntry(
      root,
      'floppy-panda',
      { kind: 'completion', convId: 'conv_a', body: 'branched + committed' },
      NOW + 1,
    )
    appendLogEntry(
      root,
      'floppy-panda',
      { kind: 'steering', convId: 'conv_b', body: 'switch target to merged' },
      NOW + 2,
    )

    const log = readLog(root, 'floppy-panda')
    expect(log.map(e => e.kind)).toEqual(['intent', 'completion', 'steering'])
    expect(log.map(e => e.convId)).toEqual(['conv_a', 'conv_a', 'conv_b'])
    expect(log[0].body).toBe('about to branch')
    expect(log[2].body).toBe('switch target to merged')
  })

  test('every prior entry survives verbatim after a later append', () => {
    createQuest(root, { project: 'p', goal: 'g', petname: 'floppy-panda' }, NOW)
    appendLogEntry(root, 'floppy-panda', { kind: 'intent', convId: 'c', body: 'first' }, NOW)
    const afterFirst = readFileSync(join(root, '.rclaude/project/quests/floppy-panda/log.md'), 'utf8')
    appendLogEntry(root, 'floppy-panda', { kind: 'plan', convId: 'c', body: 'second' }, NOW + 1)
    const afterSecond = readFileSync(join(root, '.rclaude/project/quests/floppy-panda/log.md'), 'utf8')
    // Append-only: the earlier file content is a strict prefix of the later one.
    expect(afterSecond.startsWith(afterFirst)).toBe(true)
  })

  test('appending to a missing quest throws', () => {
    expect(() => appendLogEntry(root, 'ghost-cat', { kind: 'intent', convId: 'c', body: 'x' }, NOW)).toThrow(
      /not found/,
    )
  })
})

describe('list', () => {
  test('lists all quests newest-updated first', () => {
    createQuest(root, { project: 'p', goal: 'g', petname: 'aaa-cat' }, NOW)
    createQuest(root, { project: 'p', goal: 'g', petname: 'bbb-dog' }, NOW + 10)
    patchManifest(root, 'aaa-cat', { status: 'running' }, NOW + 20) // touch aaa last
    const quests = listQuests(root)
    expect(quests.map(q => q.petname)).toEqual(['aaa-cat', 'bbb-dog'])
  })
})
