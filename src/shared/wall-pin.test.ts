/**
 * THE PIN ROUND-TRIPS THROUGH DISK.
 *
 * The whole reason the pin lives on the epic's card rather than in panel
 * preferences is that a card survives a broker restart -- so the test that
 * matters is the one that writes the key, reads it back from a fresh store call,
 * and checks the file itself.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinnedEpicRows } from './pinned-epic-rows'
import {
  cardPath,
  createProjectTask,
  getProjectTask,
  listProjectTasks,
  setProjectTaskStatus,
  updateProjectTask,
} from './project-store'
import { isWallPinned, WALL_PINNED_KEY } from './wall-pin'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wall-pin-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeEpic(): string {
  return createProjectTask(root, { title: 'THE WALL', body: 'an epic', tags: ['epic'] }, Date.now()).slug
}

function fileOf(id: string): string {
  return readFileSync(cardPath(root, id), 'utf8')
}

describe('the wall pin', () => {
  test('a fresh epic carries no pin at all', () => {
    const id = makeEpic()
    expect(getProjectTask(root, id)?.wallPinned).toBeUndefined()
    expect(fileOf(id)).not.toContain(WALL_PINNED_KEY)
  })

  test('pinning writes a scalar boolean and reads back from a fresh store call', () => {
    const id = makeEpic()
    updateProjectTask(root, id, { wallPinned: true })

    expect(fileOf(id)).toContain(`${WALL_PINNED_KEY}: true`)
    // A LIST would put it back in reach of the wrapped-list frontmatter bug.
    expect(fileOf(id)).not.toContain(`${WALL_PINNED_KEY}: [`)
    expect(getProjectTask(root, id)?.wallPinned).toBe(true)
    expect(listProjectTasks(root).find(c => c.slug === id)?.wallPinned).toBe(true)
  })

  test('unpinning DELETES the key rather than writing false', () => {
    const id = makeEpic()
    updateProjectTask(root, id, { wallPinned: true })
    updateProjectTask(root, id, { wallPinned: false })

    expect(fileOf(id)).not.toContain(WALL_PINNED_KEY)
    expect(getProjectTask(root, id)?.wallPinned).toBeUndefined()
  })

  test('an unrelated patch leaves the pin alone', () => {
    const id = makeEpic()
    updateProjectTask(root, id, { wallPinned: true })
    updateProjectTask(root, id, { priority: 'high' })

    expect(getProjectTask(root, id)?.wallPinned).toBe(true)
  })

  /**
   * A LANE MOVE MUST NOT EAT THE PIN. Moving a card is the ONE write that does
   * not go through `updateProjectTask` -- `setProjectTaskStatus` rewrites the
   * whole card off `raw.meta`. It spreads today, so this passes today; it is
   * pinned here because the old store rebuilt cards from a fixed key list, and a
   * pin silently vanishing on the next status change would present as "pinning
   * does not persist" with nothing in any log.
   */
  test('the pin survives a status change', () => {
    const id = makeEpic()
    updateProjectTask(root, id, { wallPinned: true })
    setProjectTaskStatus(root, id, 'in-progress', Date.now())

    expect(getProjectTask(root, id)?.status).toBe('in-progress')
    expect(getProjectTask(root, id)?.wallPinned).toBe(true)
    expect(fileOf(id)).toContain(`${WALL_PINNED_KEY}: true`)
  })

  /** The wall reads pins through the SENTINEL's fold, not through the card
   *  store, so the round trip is only proven once that fold returns the row. */
  test('the sentinel fold returns the pinned epic and skips the unpinned one', () => {
    const pinnedId = makeEpic()
    const otherId = createProjectTask(root, { title: 'OTHER EPIC', body: '', tags: ['epic'] }, Date.now()).slug
    updateProjectTask(root, pinnedId, { wallPinned: true })

    const rows = pinnedEpicRows('claude:///tmp/proj', listProjectTasks(root))

    expect(rows.map(r => r.epicId)).toEqual([pinnedId])
    expect(rows.map(r => r.epicId)).not.toContain(otherId)
  })

  test('a hand-written card reads as pinned even though the parser hands back a string', () => {
    // `parseFrontmatter` keeps bare scalars as strings, so a card somebody typed
    // by hand arrives as `'true'`, not `true`. Both are the same fact.
    expect(isWallPinned({ [WALL_PINNED_KEY]: 'true' })).toBe(true)
    expect(isWallPinned({ [WALL_PINNED_KEY]: true })).toBe(true)
    expect(isWallPinned({ [WALL_PINNED_KEY]: 'false' })).toBe(false)
    expect(isWallPinned({})).toBe(false)
  })
})
