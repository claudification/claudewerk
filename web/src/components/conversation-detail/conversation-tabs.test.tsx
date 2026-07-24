/**
 * tabVisibility -- the pure predicate that decides which optional tabs render.
 * The security-relevant rule is that a share-link guest (`shareView`) never sees
 * the host-internal JSON or Project tabs, regardless of granted permissions.
 */

import { describe, expect, test } from 'vitest'
import type { Conversation } from '@/lib/types'
import { tabVisibility } from './conversation-tabs'

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    status: 'idle',
    totalSubagentCount: 0,
    activeSubagentCount: 0,
    bgTasks: [],
    taskCount: 0,
    archivedTaskCount: 0,
    ...over,
  } as unknown as Conversation
}

const FULL = {
  conversation: conv(),
  hasTerminal: true,
  hasJsonStream: true,
  canAdmin: true,
  canReadTerminal: true,
  showDiag: true,
  shareView: false,
}

describe('tabVisibility', () => {
  test('an authenticated admin sees the host-internal tabs', () => {
    const v = tabVisibility(FULL)
    expect(v.tty).toBe(true)
    expect(v.json).toBe(true)
    expect(v.events).toBe(true)
    expect(v.diag).toBe(true)
    expect(v.verbose).toBe(true)
    expect(v.kanban).toBe(true)
  })

  test('a share-link guest never gets JSON or Kanban, even with full perms', () => {
    const v = tabVisibility({ ...FULL, shareView: true })
    expect(v.json).toBe(false)
    expect(v.kanban).toBe(false)
  })

  test('JSON needs the json stream + terminal read', () => {
    expect(tabVisibility({ ...FULL, hasJsonStream: false }).json).toBe(false)
    expect(tabVisibility({ ...FULL, canReadTerminal: false }).json).toBe(false)
  })

  test('TTY needs a terminal + terminal read', () => {
    expect(tabVisibility({ ...FULL, hasTerminal: false }).tty).toBe(false)
    expect(tabVisibility({ ...FULL, canReadTerminal: false }).tty).toBe(false)
  })

  test('admin-only tabs collapse for a non-admin', () => {
    const v = tabVisibility({ ...FULL, canAdmin: false })
    expect(v.events).toBe(false)
    expect(v.agents).toBe(false)
    expect(v.diag).toBe(false)
    expect(v.verbose).toBe(false)
  })

  test('agents tab needs admin AND some agent/bg-task activity', () => {
    expect(tabVisibility(FULL).agents).toBe(false)
    expect(tabVisibility({ ...FULL, conversation: conv({ totalSubagentCount: 2 }) }).agents).toBe(true)
    expect(tabVisibility({ ...FULL, conversation: conv({ activeSubagentCount: 1 }) }).agents).toBe(true)
    expect(
      tabVisibility({ ...FULL, conversation: conv({ bgTasks: [{}] as unknown as Conversation['bgTasks'] }) }).agents,
    ).toBe(true)
  })

  test('tasks tab shows for live or archived tasks', () => {
    expect(tabVisibility(FULL).tasks).toBe(false)
    expect(tabVisibility({ ...FULL, conversation: conv({ taskCount: 3 }) }).tasks).toBe(true)
    expect(tabVisibility({ ...FULL, conversation: conv({ archivedTaskCount: 1 }) }).tasks).toBe(true)
  })

  test('kanban tab hides once the conversation has ended', () => {
    expect(tabVisibility({ ...FULL, conversation: conv({ status: 'ended' }) }).kanban).toBe(false)
  })

  test('diag needs admin AND showDiag', () => {
    expect(tabVisibility({ ...FULL, showDiag: false }).diag).toBe(false)
  })
})
