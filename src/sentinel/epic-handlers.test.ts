import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '../shared/frontmatter'
import { cardPath } from '../shared/project-paths'
import type { EpicOp, EpicOpKind } from '../shared/protocol'
import { handleEpicOp } from './epic-handlers'

const T0 = Date.parse('2026-08-17T10:00:00.000Z')
const EPIC = 'e1'
let root = ''

function op(kind: EpicOpKind, extra: Partial<EpicOp> = {}, at = T0) {
  return handleEpicOp(
    root,
    { type: 'epic_op', requestId: 'r1', projectRoot: root, op: kind, epicId: EPIC, ...extra },
    at,
  )
}

function writeEpicCard() {
  const file = cardPath(root, EPIC, false)
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
  writeFileSync(file, '---\ntitle: The epic\nstatus: open\ntags: [epic]\n---\n\nBody.\n', 'utf8')
}

function cardMeta() {
  return parseFrontmatter(readFileSync(cardPath(root, EPIC, false), 'utf8')).meta
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'epic-handlers-'))
  writeEpicCard()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('handleEpicOp', () => {
  test('an unknown op fails loudly rather than silently succeeding', () => {
    const res = op('teleport' as EpicOpKind)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown epic op')
  })

  test('a throwing handler becomes a failed result, not an unhandled rejection', () => {
    const res = handleEpicOp(
      root,
      { type: 'epic_op', requestId: 'r1', projectRoot: root, op: 'start', epicId: '../escape' },
      T0,
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('invalid epic id')
  })

  test('start arms a run and get reads it back with an empty baton', () => {
    expect(op('start', { start: { cadence: 'window', concurrency: 2 } }).ok).toBe(true)
    const got = op('get')
    expect(got.run?.status).toBe('armed')
    expect(got.run?.cadence).toBe('window')
    expect(got.run?.concurrency).toBe(2)
    expect(got.baton).toEqual([])
  })

  test('patching a run that was never started fails instead of creating one', () => {
    expect(op('patch', { patch: { gen: 4 } }).ok).toBe(false)
  })

  test('log_append persists and get returns the tail', () => {
    op('start')
    op('log_append', { logAppend: { kind: 'dispatch', convId: 'conv_1', cardId: 't1', body: 'sent t1' } })
    const got = op('get')
    expect(got.baton).toHaveLength(1)
    expect(got.baton?.[0].cardId).toBe('t1')
  })
})

describe('the lease op -- the singleton, under contention', () => {
  test('the first wake takes generation 1 and flips the run to running', () => {
    op('start')
    const res = op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    expect(res.lease?.granted).toBe(true)
    expect(res.lease?.gen).toBe(1)
    expect(op('get').run?.status).toBe('running')
  })

  test('the lease is written to the EPIC CARD, where a human can see it', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    const meta = cardMeta()
    expect(meta.overseer).toBe('conv_a')
    // frontmatter.ts keeps bare scalars as STRINGS by design; readLease coerces.
    expect(String(meta.overseer_gen)).toBe('1')
    expect(meta.title).toBe('The epic') // the rest of the card is untouched
  })

  test('TWO wakes on the same beat: one grants, one is refused as stale', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    const second = op('lease', { lease: { convId: 'conv_b', expectGen: 1, holderAlive: true } }, T0 + 100)
    expect(second.lease?.granted).toBe(false)
    expect(second.lease?.convId).toBe('conv_a')
    const third = op('lease', { lease: { convId: 'conv_c', expectGen: 0, holderAlive: false } }, T0 + 200)
    expect(third.lease?.granted).toBe(false)
    expect(third.lease?.reason).toContain('stale wake')
  })

  test('release drops the grip but keeps the generation counter', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    expect(op('release').ok).toBe(true)
    expect(cardMeta().overseer).toBe('')
    expect(String(cardMeta().overseer_gen)).toBe('1')

    const next = op('lease', { lease: { convId: 'conv_b', expectGen: 1, holderAlive: false } }, T0 + 500)
    expect(next.lease?.granted).toBe(true)
    expect(next.lease?.gen).toBe(2)
  })

  test('force breaks a live lease -- the human override', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    const forced = op('lease', { lease: { convId: 'conv_x', expectGen: 999, holderAlive: true, force: true } })
    expect(forced.lease?.granted).toBe(true)
    expect(forced.lease?.convId).toBe('conv_x')
  })

  test('leasing an epic with no card fails rather than inventing one', () => {
    rmSync(cardPath(root, EPIC, false))
    op('start')
    expect(op('lease', { lease: { convId: 'c', expectGen: 0, holderAlive: false } }).ok).toBe(false)
  })
})

describe('pause and abort', () => {
  test('pause stops the run and releases the lease', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    expect(op('pause').run?.status).toBe('paused')
    expect(cardMeta().overseer).toBe('')
  })

  test('abort records the reason in the append-only baton', () => {
    op('start')
    const res = op('abort', { reason: 'scope changed' })
    expect(res.run?.status).toBe('aborted')
    const baton = op('get').baton ?? []
    expect(baton.at(-1)?.body).toContain('scope changed')
  })

  test('re-arming after a pause resumes rather than resetting the counter', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    op('pause')
    expect(op('start').run?.status).toBe('armed')
    expect(op('get').run?.gen).toBe(1)
  })
})
