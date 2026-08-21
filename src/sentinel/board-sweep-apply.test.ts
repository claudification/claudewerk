/**
 * `apply` -- the op with the power to lie.
 *
 * These lock down the three properties that make a machine-executed board
 * mutation trustworthy: it touches ONLY what it was handed, it reports what
 * LANDED rather than what it intended, and it cannot be talked into a delete.
 *
 * A real board on a real temp dir, deliberately. `apply`'s whole job is the
 * write, and a mocked store would test the branch table while leaving the one
 * thing that matters -- do the lifecycle keys survive `updateProjectTask`,
 * `serializeCard` and a read back -- unexercised. That round-trip is the reason
 * this card was gated on `card-doctor-lifecycle-keys` in the first place.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProjectTask } from '../shared/project-card-read'
import { createProjectTask } from '../shared/project-card-write'
import type { BoardProposalRef } from '../shared/protocol'
import { applyProposals } from './board-sweep-apply'

const BERLIN = 'Europe/Berlin'
/** 2026-08-22 01:30 Berlin == 2026-08-21 23:30 UTC. The date the actor carries
 *  has to come from the ZONE, not the container's clock. */
const NOW = Date.parse('2026-08-21T23:30:00Z')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'board-apply-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function card(title: string, status: 'inbox' | 'open' = 'inbox'): string {
  return createProjectTask(root, { title, body: 'b', status }, NOW).slug
}

function apply(proposals: BoardProposalRef[], reportDate?: string) {
  return applyProposals(root, { proposals, tz: BERLIN, reportDate }, NOW)
}

describe('the lifecycle keys survive the round trip', () => {
  test('archive-cold writes `cold` + the report actor, and they read back', () => {
    const id = card('cold one')
    const [outcome] = apply([{ kind: 'archive-cold', card: id }])

    expect(outcome).toMatchObject({ kind: 'archive-cold', card: id, ok: true, status: 'archived' })
    // Reported from the write's OWN return value, not from the patch we sent.
    expect(outcome.archivedReason).toBe('cold')

    const written = getProjectTask(root, id)
    expect(written?.status).toBe('archived')
    expect(written?.archivedReason).toBe('cold')
    expect(written?.archivedBy).toBe('report-2026-08-22')
  })

  test('flag-duplicate writes the POINTER, which is why a lane could not carry it', () => {
    const id = card('dupe')
    const [outcome] = apply([{ kind: 'flag-duplicate', card: id, other: 'the-survivor' }])

    expect(outcome.ok).toBe(true)
    expect(getProjectTask(root, id)).toMatchObject({
      status: 'archived',
      archivedReason: 'duplicate-of:the-survivor',
      archivedBy: 'report-2026-08-22',
    })
  })

  test('a duplicate with no survivor named is refused, not archived against nothing', () => {
    const id = card('dupe')
    const [outcome] = apply([{ kind: 'flag-duplicate', card: id }])

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('other')
    expect(getProjectTask(root, id)?.status).toBe('inbox')
  })

  test('promote-delivered moves the lane and writes NO lifecycle key', () => {
    const id = card('delivered', 'open')
    const [outcome] = apply([{ kind: 'promote-delivered', card: id }])

    expect(outcome).toMatchObject({ ok: true, status: 'done' })
    // `done` is a working lane, not `archived`. A reason here would trip
    // `lifecycle-reason-not-archived` in the doctor -- and it would be right:
    // the card reads as archived to a grep while sitting in a lane people work.
    const written = getProjectTask(root, id)
    expect(written?.archivedReason).toBeUndefined()
    expect(written?.archivedBy).toBeUndefined()
  })

  test('the actor is dated in the SCHEDULE zone -- 01:30 Berlin is not yesterday', () => {
    const id = card('zoned')
    apply([{ kind: 'archive-cold', card: id }])
    // The instant is 2026-08-21 in UTC. Reading the date off the container's
    // clock would stamp `report-2026-08-21` on a report called 2026-08-22.
    expect(getProjectTask(root, id)?.archivedBy).toBe('report-2026-08-22')
  })

  test('an explicit reportDate wins -- Tuesday executing Monday still stamps Monday', () => {
    const id = card('late')
    apply([{ kind: 'archive-cold', card: id }], '2026-08-19')
    expect(getProjectTask(root, id)?.archivedBy).toBe('report-2026-08-19')
  })
})

describe('F18 -- nothing is ever hard-deleted here', () => {
  test('note-delete-at is refused AT THE OP, so a hand-crafted request cannot arm it', () => {
    const id = card('marked')
    const [outcome] = apply([{ kind: 'note-delete-at', card: id }])

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('F18')
    // Untouched: not merely undeleted, but not re-filed either.
    expect(getProjectTask(root, id)?.status).toBe('inbox')
  })

  test('a refused kind does not cost its neighbours their writes', () => {
    const marked = card('marked')
    const cold = card('cold')
    const outcomes = apply([
      { kind: 'note-delete-at', card: marked },
      { kind: 'archive-cold', card: cold },
    ])

    expect(outcomes.map(o => o.ok)).toEqual([false, true])
    expect(getProjectTask(root, cold)?.status).toBe('archived')
  })
})

describe('it mutates ONLY the proposals it was handed', () => {
  test('a card that would have qualified is untouched when it is not in the list', () => {
    const named = card('named')
    const bystander = card('bystander')
    apply([{ kind: 'archive-cold', card: named }])

    expect(getProjectTask(root, named)?.status).toBe('archived')
    // The board is never re-swept inside `apply`. A fresh fold here would act on
    // cards the human never saw on the report they ticked.
    expect(getProjectTask(root, bystander)?.status).toBe('inbox')
  })

  test('every ref gets exactly one row out, in the order it came in', () => {
    const a = card('a')
    const b = card('b')
    const outcomes = apply([
      { kind: 'archive-cold', card: b },
      { kind: 'archive-cold', card: a },
    ])
    expect(outcomes.map(o => o.card)).toEqual([b, a])
  })

  test('an empty list writes nothing and returns nothing', () => {
    expect(apply([])).toEqual([])
  })
})

describe('a failure is reported as a failure', () => {
  test('a stale id is a per-proposal error, not a thrown batch', () => {
    const good = card('good')
    const outcomes = apply([
      { kind: 'archive-cold', card: 'ghost' },
      { kind: 'archive-cold', card: good },
    ])

    expect(outcomes[0]).toMatchObject({ ok: false, error: 'no such card on this board' })
    // One stale id in a report executed an hour late must not cost the rest.
    expect(outcomes[1].ok).toBe(true)
  })

  test('a failed row carries no status -- it never claims a lane it did not write', () => {
    const [outcome] = apply([{ kind: 'archive-cold', card: 'ghost' }])
    expect(outcome.status).toBeUndefined()
    expect(outcome.archivedReason).toBeUndefined()
  })
})
