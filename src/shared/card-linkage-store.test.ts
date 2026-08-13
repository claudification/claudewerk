/**
 * Linkage across the STORE seam: what an alias looks like once it has been
 * through create -> disk -> read. A registry that only holds together in a pure
 * unit test is the same trap it exists to close -- `relates_to` parsed fine for
 * months too.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cardPath, createProjectTask, getProjectTask, updateProjectTask } from './project-store'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'card-linkage-store-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const NOW = 1_770_000_000_000

const onDisk = (id: string) => readFileSync(cardPath(root, id), 'utf8')

function writeRawCard(id: string, frontmatter: string): void {
  createProjectTask(root, { title: id, body: 'placeholder' }, NOW)
  writeFileSync(cardPath(root, id), `---\n${frontmatter}\n---\n\nbody\n`, 'utf8')
}

describe('blocked_by reaches disk as depends_on', () => {
  test('on create', () => {
    const { slug } = createProjectTask(root, { title: 'A', body: 'b', blockedBy: ['x'] }, NOW)
    expect(onDisk(slug)).toContain('depends_on:')
    expect(onDisk(slug)).not.toContain('blocked_by:')
    expect(getProjectTask(root, slug)?.dependsOn).toEqual(['x'])
  })

  test('merged with a dependsOn given alongside it, without duplicates', () => {
    const { slug } = createProjectTask(root, { title: 'A', body: 'b', dependsOn: ['x'], blockedBy: ['x', 'y'] }, NOW)
    expect(getProjectTask(root, slug)?.dependsOn).toEqual(['x', 'y'])
  })

  test('on update', () => {
    const { slug } = createProjectTask(root, { title: 'A', body: 'b' }, NOW)
    updateProjectTask(root, slug, { blockedBy: ['x'] })
    expect(onDisk(slug)).toContain('depends_on:')
    expect(getProjectTask(root, slug)?.dependsOn).toEqual(['x'])
  })
})

describe('a hand-written alias still WORKS -- it is read, not just tolerated', () => {
  test('blocked_by on disk reads as dependsOn', () => {
    writeRawCard('a', 'title: A\nstatus: open\nblocked_by: [x]')
    expect(getProjectTask(root, 'a')?.dependsOn).toEqual(['x'])
  })

  test('see_also on disk reads as relatesTo', () => {
    writeRawCard('a', 'title: A\nstatus: open\nsee_also: [x]')
    expect(getProjectTask(root, 'a')?.relatesTo).toEqual(['x'])
  })

  test('and the next write through the store collapses it to one spelling', () => {
    writeRawCard('a', 'title: A\nstatus: open\nblocked_by: [x]')
    updateProjectTask(root, 'a', { title: 'A renamed' })
    expect(onDisk('a')).not.toContain('blocked_by:')
    expect(getProjectTask(root, 'a')?.dependsOn).toEqual(['x'])
  })
})

describe('a scalar where a list belongs is no longer swallowed', () => {
  test('depends_on: one-card reads as a one-item list', () => {
    writeRawCard('a', 'title: A\nstatus: open\ndepends_on: lonely')
    expect(getProjectTask(root, 'a')?.dependsOn).toEqual(['lonely'])
  })

  test('epic given as a list takes the first, never the joined string', () => {
    writeRawCard('a', 'title: A\nstatus: open\nepic: [first, second]')
    expect(getProjectTask(root, 'a')?.epic).toBe('first')
  })
})

describe('relates_to round-trips', () => {
  test('through create and read', () => {
    const { slug } = createProjectTask(root, { title: 'A', body: 'b', relatesTo: ['x', 'y'] }, NOW)
    expect(onDisk(slug)).toContain('relates_to:')
    expect(getProjectTask(root, slug)?.relatesTo).toEqual(['x', 'y'])
  })

  test('and survives an unrelated patch', () => {
    const { slug } = createProjectTask(root, { title: 'A', body: 'b', relatesTo: ['x'] }, NOW)
    updateProjectTask(root, slug, { priority: 'high' })
    expect(getProjectTask(root, slug)?.relatesTo).toEqual(['x'])
  })
})

describe('preserve-unknown-keys still holds', () => {
  test('gate machinery survives a write that folds an alias', () => {
    writeRawCard('a', 'title: A\nstatus: open\nblocked_by: [x]\nevidence_commits: [abc]\ngate: green')
    updateProjectTask(root, 'a', { priority: 'low' })
    const raw = onDisk('a')
    expect(raw).toContain('evidence_commits:')
    expect(raw).toContain('gate: green')
  })
})
