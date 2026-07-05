/**
 * Tier 1 unit tests for the quest <-> board-card bridge (plan-quest-engine
 * §4a/§4c/§13): membership by `quest:` frontmatter (ORTHOGONAL to lane), the
 * computed completion predicate truth table (§11 -- computed, never asserted),
 * and the §13 abort card-stamping.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectTask, getProjectTask, moveProjectTask } from './project-store'
import { computeQuestStatus, listQuestCards, stampAbortCards, tagQuestCards } from './quest-cards'
import type { QuestManifest } from './quest-schema'
import { createQuest, patchManifest, readManifest } from './quest-store'

let root: string
const NOW = Date.UTC(2026, 6, 5, 9, 0, 0)
const PET = 'floppy-panda'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quest-cards-'))
  createQuest(root, { project: 'p', goal: 'g', petname: PET }, NOW)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function manifest(): QuestManifest {
  const m = readManifest(root, PET)
  if (!m) throw new Error('manifest missing')
  return m
}

describe('membership (§4a) is orthogonal to lane (§4c)', () => {
  test('quest key survives a lane move; only tagged cards are members', () => {
    const a = createProjectTask(root, { title: 'A', body: 'a', quest: PET }, NOW)
    createProjectTask(root, { title: 'B', body: 'b' }, NOW + 1) // untagged, not a member
    expect(listQuestCards(root, PET).map(c => c.slug)).toEqual([a.slug])

    const moved = moveProjectTask(root, a.slug, 'inbox', 'in-progress', NOW + 2)
    expect(moved).toBe(a.slug)
    const members = listQuestCards(root, PET)
    expect(members).toHaveLength(1)
    expect(members[0].status).toBe('in-progress')
    expect(members[0].quest).toBe(PET)
  })

  test('tagQuestCards tags an existing card by ref', () => {
    const b = createProjectTask(root, { title: 'B', body: 'b' }, NOW)
    expect(listQuestCards(root, PET)).toHaveLength(0)
    const tagged = tagQuestCards(root, PET, [{ slug: b.slug, status: 'inbox' }])
    expect(tagged).toEqual([b.slug])
    expect(getProjectTask(root, 'inbox', b.slug)?.quest).toBe(PET)
  })
})

describe('quest_status predicate truth table (§4c)', () => {
  test('no cards -> not complete (nothing to deliver)', () => {
    const r = computeQuestStatus(root, manifest())
    expect(r.total).toBe(0)
    expect(r.allTerminal).toBe(false)
    expect(r.complete).toBe(false)
  })

  test('mixed lanes -> not complete', () => {
    const a = createProjectTask(root, { title: 'A', body: 'a', quest: PET }, NOW)
    createProjectTask(root, { title: 'B', body: 'b', quest: PET }, NOW + 1)
    moveProjectTask(root, a.slug, 'inbox', 'done', NOW + 2) // A terminal, B still inbox
    const r = computeQuestStatus(root, manifest())
    expect(r.total).toBe(2)
    expect(r.terminalCount).toBe(1)
    expect(r.allTerminal).toBe(false)
    expect(r.complete).toBe(false)
  })

  test('all cards terminal (done|archived) -> complete', () => {
    const a = createProjectTask(root, { title: 'A', body: 'a', quest: PET }, NOW)
    const b = createProjectTask(root, { title: 'B', body: 'b', quest: PET }, NOW + 1)
    moveProjectTask(root, a.slug, 'inbox', 'done', NOW + 2)
    moveProjectTask(root, b.slug, 'inbox', 'archived', NOW + 3)
    const r = computeQuestStatus(root, manifest())
    expect(r.terminalCount).toBe(2)
    expect(r.allTerminal).toBe(true)
    expect(r.complete).toBe(true)
    expect(r.cards.every(c => c.terminal)).toBe(true)
  })

  test('all terminal but aborted -> not complete', () => {
    const a = createProjectTask(root, { title: 'A', body: 'a', quest: PET }, NOW)
    moveProjectTask(root, a.slug, 'inbox', 'done', NOW + 1)
    patchManifest(root, PET, { status: 'aborted', abortReason: 'x' }, NOW + 2)
    const r = computeQuestStatus(root, manifest())
    expect(r.allTerminal).toBe(true)
    expect(r.status).toBe('aborted')
    expect(r.complete).toBe(false)
  })
})

describe('abort card stamping (§13)', () => {
  test('non-terminal cards archived with reason; terminal cards untouched', () => {
    const open = createProjectTask(root, { title: 'Open', body: 'o', quest: PET }, NOW)
    const done = createProjectTask(root, { title: 'Done', body: 'd', quest: PET }, NOW + 1)
    moveProjectTask(root, done.slug, 'inbox', 'done', NOW + 2)

    const stamped = stampAbortCards(root, PET, 'quest giver pulled the plug', NOW + 3)
    expect(stamped).toHaveLength(1)
    expect(stamped[0].from).toBe('inbox')
    expect(stamped[0].to).toBe('archived')

    const archived = getProjectTask(root, 'archived', open.slug)
    expect(archived?.body).toContain('SKIPPED-by-abort')
    expect(archived?.body).toContain('quest giver pulled the plug')
    expect(archived?.quest).toBe(PET) // membership preserved through the stamp
    // The already-done card is left in its terminal lane.
    expect(getProjectTask(root, 'done', done.slug)).not.toBeNull()
  })
})
