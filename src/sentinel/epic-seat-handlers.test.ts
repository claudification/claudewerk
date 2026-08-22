/**
 * The seat lease AT THE DISK -- the CAS as the sentinel actually performs it.
 *
 * `epic-seat-lease.test.ts` proves the decision; this proves the read-modify-
 * write it rides on: the right keys on the right card, a werk-worker and a
 * werk-verifier coexisting in one frontmatter block, and a release that only the
 * holder may perform.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEASE_STALE_MS } from '../shared/epic-lease'
import { parseFrontmatter } from '../shared/frontmatter'
import { cardPath } from '../shared/project-paths'
import type { EpicOp, EpicOpKind, EpicSeatInput } from '../shared/protocol'
import { handleEpicOp } from './epic-handlers'

const T0 = Date.parse('2026-08-21T10:00:00.000Z')
const EPIC = 'epic-project-runner'
const CARD = 'runner-list-project-uri-unnormalized'
let root = ''

function op(kind: EpicOpKind, seat: Partial<EpicSeatInput>, at = T0) {
  const msg: EpicOp = {
    type: 'epic_op',
    requestId: 'r1',
    projectRoot: root,
    op: kind,
    epicId: EPIC,
    seat: { cardId: CARD, role: 'werk-worker', ...seat } as EpicSeatInput,
  }
  return handleEpicOp(root, msg, at)
}

const claim = (
  convId: string,
  expectGen: number,
  holderAlive: boolean,
  at = T0,
  role: EpicSeatInput['role'] = 'werk-worker',
) => op('seat_claim', { convId, expectGen, holderAlive, role }, at)

function cardMeta(id = CARD) {
  return parseFrontmatter(readFileSync(cardPath(root, id, false), 'utf8')).meta
}

function writeCard(id: string) {
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
  writeFileSync(
    cardPath(root, id, false),
    `---\ntitle: A card\nstatus: in-progress\nepic: ${EPIC}\n---\n\nBody.\n`,
    'utf8',
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'epic-seat-'))
  writeCard(CARD)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('seat_claim -- one writer per (card, role)', () => {
  test('the first claim is granted at generation 1 and lands on the WORK card', () => {
    const res = claim('conv_first', 0, false)

    expect(res.lease?.granted).toBe(true)
    expect(res.lease?.gen).toBe(1)
    expect(cardMeta()['seat_werk-worker']).toBe('conv_first')
    expect(String(cardMeta()['seat_werk-worker_gen'])).toBe('1')
    expect(cardMeta().title).toBe('A card') // the rest of the card is untouched
  })

  /** THE 2026-08-21 PAIR. Two werk-workers, one card, one worktree. */
  test('the second claimant loses and is told who holds it', () => {
    claim('conv_first', 0, false)

    const second = claim('conv_second', 1, true, T0 + 30_000)

    expect(second.lease?.granted).toBe(false)
    expect(second.lease?.convId).toBe('conv_first')
    expect(cardMeta()['seat_werk-worker']).toBe('conv_first')
  })

  test("two seats that both read a FREE card: the second one's generation is already wrong", () => {
    // Both read "never claimed" and both state expectGen 0. The sentinel
    // evaluates them one after the other and only the first is still right.
    expect(claim('conv_a', 0, false).lease?.granted).toBe(true)
    const loser = claim('conv_b', 0, false, T0 + 1)

    expect(loser.lease?.granted).toBe(false)
    expect(loser.lease?.reason).toContain('stale')
  })

  test('a werk-worker and a werk-verifier hold the SAME card at once', () => {
    expect(claim('conv_impl', 0, false, T0, 'werk-worker').lease?.granted).toBe(true)
    expect(claim('conv_verify', 0, true, T0 + 1000, 'werk-verifier').lease?.granted).toBe(true)

    const meta = cardMeta()
    expect(meta['seat_werk-worker']).toBe('conv_impl')
    expect(meta['seat_werk-verifier']).toBe('conv_verify')
  })

  test('a DEAD holder is displaced and the grant reports what it replaced', () => {
    claim('conv_dead', 0, false)

    const next = claim('conv_next', 1, false, T0 + 5_000)

    expect(next.lease?.granted).toBe(true)
    expect(next.lease?.replaced?.convId).toBe('conv_dead')
    expect(cardMeta()['seat_werk-worker']).toBe('conv_next')
  })

  /**
   * THE WEDGE, at the disk. A holder blocked in Bash is alive and silent. The
   * claim path has no early return on liveness, so the CAS is reached and the
   * TTL decides -- which is precisely what `epic-beat.ts:251` prevents for the
   * werk-master lease (see epic-lease-has-no-timeout).
   */
  test('a holder that is ALIVE but past the stale window is displaced', () => {
    claim('conv_wedged', 0, false)

    expect(claim('conv_next', 1, true, T0 + LEASE_STALE_MS - 1).lease?.granted).toBe(false)
    expect(claim('conv_next', 1, true, T0 + LEASE_STALE_MS + 1).lease?.granted).toBe(true)
  })

  test('a claim against a card that does not exist fails rather than creating one', () => {
    const res = op('seat_claim', { cardId: 'no-such-card', convId: 'c', expectGen: 0, holderAlive: false })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
  })

  test('a traversing card id is refused, not resolved', () => {
    const res = op('seat_claim', { cardId: '../../etc/passwd', convId: 'c', expectGen: 0, holderAlive: false })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('invalid card id')
  })
})

describe('seat_get -- who holds it', () => {
  test('an unclaimed seat reports null rather than inventing a holder', () => {
    expect(op('seat_get', {}).currentLease).toBeNull()
  })

  test('it reads back the holder and generation the claim wrote', () => {
    claim('conv_first', 0, false)
    const got = op('seat_get', {})
    expect(got.currentLease?.convId).toBe('conv_first')
    expect(got.currentLease?.gen).toBe(1)
  })

  test('the two roles are read independently', () => {
    claim('conv_impl', 0, false, T0, 'werk-worker')
    expect(op('seat_get', { role: 'werk-verifier' }).currentLease).toBeNull()
  })
})

describe('seat_release -- and why only the holder may do it', () => {
  test('the holder releases, keeping the generation counter', () => {
    claim('conv_first', 0, false)

    expect(op('seat_release', { convId: 'conv_first' }).ok).toBe(true)

    expect(cardMeta()['seat_werk-worker']).toBe('')
    expect(String(cardMeta()['seat_werk-worker_gen'])).toBe('1')
  })

  test('a released seat is claimable again, at the next generation', () => {
    claim('conv_first', 0, false)
    op('seat_release', { convId: 'conv_first' })

    const next = claim('conv_second', 1, false, T0 + 60_000)

    expect(next.lease?.granted).toBe(true)
    expect(next.lease?.gen).toBe(2)
  })

  /** A losing claimant that could release would hand the card to nobody while
   *  the winner is mid-edit -- the corruption, arrived by the front door. */
  test('a NON-HOLDER cannot release the seat out from under the holder', () => {
    claim('conv_first', 0, false)

    const res = op('seat_release', { convId: 'conv_loser' })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('only the holder')
    expect(cardMeta()['seat_werk-worker']).toBe('conv_first')
  })

  test('releasing a seat nobody holds succeeds -- an exit path must not fail', () => {
    expect(op('seat_release', { convId: 'conv_first' }).ok).toBe(true)
  })

  test('a seat whose lease was already broken can still finish its own exit', () => {
    claim('conv_first', 0, false)
    claim('conv_second', 1, false, T0 + LEASE_STALE_MS + 1)

    // conv_first is no longer the holder, so its release is refused rather than
    // silently stealing the card back from conv_second.
    const res = op('seat_release', { convId: 'conv_first' })
    expect(res.ok).toBe(false)
    expect(cardMeta()['seat_werk-worker']).toBe('conv_second')
  })
})
