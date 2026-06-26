import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearDeskEventHandlers, emitDeskEvent } from '../desk/event-registry'
import { startSotuFloor, stopSotuFloor } from './floor'
import { initSotuStore, projectSlug } from './index'
import { readQueue } from './queue'
import { readState } from './state'

const PROJECT = '/Users/jonas/projects/remote-claude'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-floor-'))
  initSotuStore(dir)
  startSotuFloor()
})
afterEach(() => {
  stopSotuFloor()
  clearDeskEventHandlers()
  rmSync(dir, { recursive: true, force: true })
})

test('a lifecycle desk event lands as a queue contribution', () => {
  emitDeskEvent({ kind: 'lifecycle', conversationId: 'conv-x', project: PROJECT, ts: 5000, transition: 'created' })
  const q = readQueue(projectSlug(PROJECT))
  expect(q).toHaveLength(1)
  expect(q[0]).toMatchObject({ kind: 'lifecycle', convId: 'conv-x', ts: 5000, event: 'created' })
  // weighted bump (lifecycle = 2)
  expect(readState(projectSlug(PROJECT)).pendingContribs).toBe(2)
})

test('every lifecycle transition is mapped verbatim', () => {
  emitDeskEvent({ kind: 'lifecycle', conversationId: 'c1', project: PROJECT, ts: 1, transition: 'created' })
  emitDeskEvent({ kind: 'lifecycle', conversationId: 'c1', project: PROJECT, ts: 2, transition: 'ended' })
  emitDeskEvent({ kind: 'lifecycle', conversationId: 'c1', project: PROJECT, ts: 3, transition: 'resumed' })
  const events = readQueue(projectSlug(PROJECT)).map(c => (c.kind === 'lifecycle' ? c.event : null))
  expect(events).toEqual(['created', 'ended', 'resumed'])
})

test('non-lifecycle events and project-less events are ignored', () => {
  emitDeskEvent({ kind: 'turn_complete', conversationId: 'c1', project: PROJECT, ts: 10 })
  emitDeskEvent({ kind: 'live_status', conversationId: 'c1', project: PROJECT, ts: 11, state: 'working' })
  emitDeskEvent({ kind: 'lifecycle', conversationId: 'c2', project: null, ts: 12, transition: 'created' })
  expect(readQueue(projectSlug(PROJECT))).toHaveLength(0)
})

test('stopSotuFloor unsubscribes -- no further contributions', () => {
  stopSotuFloor()
  emitDeskEvent({ kind: 'lifecycle', conversationId: 'c1', project: PROJECT, ts: 1, transition: 'created' })
  expect(readQueue(projectSlug(PROJECT))).toHaveLength(0)
})
