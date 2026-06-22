import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeDispatchThreads,
  deleteThread,
  getThread,
  initDispatchThreads,
  listThreads,
  recordThreadUsage,
  upsertThread,
} from './threads'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-threads-'))
  initDispatchThreads(dir)
})

afterEach(() => {
  closeDispatchThreads()
  rmSync(dir, { recursive: true, force: true })
})

describe('dispatch threads near-memory', () => {
  it('creates a thread with text + metadata', () => {
    const id = upsertThread({
      title: 'mic bug',
      summary: 'tracking the mic ducking regression',
      metadata: { entities: ['mic'], status: 'active' },
      now: 100,
    })
    const t = getThread(id)
    expect(t?.title).toBe('mic bug')
    expect(t?.summary).toContain('ducking')
    expect(t?.metadata?.status).toBe('active')
    expect(t?.conversations).toEqual([])
  })

  it('updates summary/metadata, preserves createdAt', () => {
    const id = upsertThread({ title: 't', summary: 'v1', now: 100 })
    upsertThread({ id, title: 't', summary: 'v2', now: 200 })
    const t = getThread(id)
    expect(t?.summary).toBe('v2')
    expect(t?.createdAt).toBe(100)
    expect(t?.updatedAt).toBe(200)
  })

  it('records conversations used + last-used, most-recent first', () => {
    const id = upsertThread({ title: 't', now: 100 })
    recordThreadUsage(id, 'conv_a', 110, 'A')
    recordThreadUsage(id, 'conv_b', 130, 'B')
    recordThreadUsage(id, 'conv_a', 150) // a used again, later
    const t = getThread(id)
    expect(t?.conversations.map(c => c.conversationId)).toEqual(['conv_a', 'conv_b'])
    expect(t?.conversations[0]?.lastUsedAt).toBe(150)
    expect(t?.conversations[0]?.label).toBe('A') // label preserved on re-use
  })

  it('usage bumps the thread to the top of the list', () => {
    const a = upsertThread({ title: 'A', now: 100 })
    const b = upsertThread({ title: 'B', now: 200 })
    expect(listThreads().map(t => t.id)).toEqual([b, a]) // b newer
    recordThreadUsage(a, 'conv_x', 300)
    expect(listThreads().map(t => t.id)).toEqual([a, b]) // a bumped
  })

  it('respects list limit', () => {
    upsertThread({ title: '1', now: 1 })
    upsertThread({ title: '2', now: 2 })
    upsertThread({ title: '3', now: 3 })
    expect(listThreads(2)).toHaveLength(2)
  })

  it('deletes a thread and its conversation rows', () => {
    const id = upsertThread({ title: 't', now: 100 })
    recordThreadUsage(id, 'conv_a', 110)
    deleteThread(id)
    expect(getThread(id)).toBeNull()
    expect(listThreads()).toHaveLength(0)
  })
})
