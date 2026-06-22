import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, ChatResponse } from '../recap/shared/openrouter-client'
import {
  condenseProjectNow,
  startDeskMemoryService,
  stopDeskMemoryService,
  summarizeEvent,
} from './desk-memory-service'
import { clearDeskEventHandlers, type DeskEvent, emitDeskEvent } from './event-registry'
import { closeProjectMemory, getBrief, getPendingEvents, initProjectMemory } from './project-memory'
import { projectKeyOf } from './projects'

const URI = 'claude://default/Users/jonas/projects/arr'
const KEY = projectKeyOf(URI) as string

let dir: string
function chatReturning(content: string, capture?: (r: ChatRequest) => void) {
  return async (r: ChatRequest): Promise<ChatResponse> => {
    capture?.(r)
    return { content, raw: {}, usage: {} as never, model: r.model }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dms-'))
  initProjectMemory(dir)
})
afterEach(() => {
  stopDeskMemoryService()
  clearDeskEventHandlers()
  closeProjectMemory()
  rmSync(dir, { recursive: true, force: true })
})

const turn = (ts: number): DeskEvent => ({
  kind: 'turn_complete',
  conversationId: 'c1',
  project: URI,
  ts,
  title: 'auth work',
})

describe('summarizeEvent', () => {
  test('produces raw transient one-liners', () => {
    expect(summarizeEvent(turn(1))).toBe('turn ended in auth work')
    expect(
      summarizeEvent({
        kind: 'lifecycle',
        conversationId: 'c1',
        project: URI,
        ts: 1,
        transition: 'created',
        title: 'idx',
      }),
    ).toBe('spawned conversation idx')
    expect(
      summarizeEvent({
        kind: 'recap_available',
        conversationId: null,
        project: URI,
        ts: 1,
        recapId: 'r',
        title: 'Weekly',
      }),
    ).toBe('recap available: Weekly')
  })
})

describe('desk-memory-service', () => {
  test('an emitted event is recorded as per-project raw signal in the background', () => {
    startDeskMemoryService({ chat: chatReturning('brief'), debounceMs: 999_999, volumeTrigger: 999 })
    emitDeskEvent(turn(1))
    const pending = getPendingEvents(KEY)
    expect(pending).toHaveLength(1)
    expect(pending[0].summary).toBe('turn ended in auth work')
    expect(getBrief(KEY)?.pendingCount).toBe(1)
  })

  test('condenseProjectNow folds pending signal into the durable brief', async () => {
    let prompt: ChatRequest | undefined
    startDeskMemoryService({
      chat: chatReturning('Arr is a media indexer; auth work in progress.', r => {
        prompt = r
      }),
      debounceMs: 999_999,
      volumeTrigger: 999,
    })
    emitDeskEvent(turn(1))
    const wrote = await condenseProjectNow(KEY)
    expect(wrote).toBe(true)
    expect(getBrief(KEY)?.brief).toContain('media indexer')
    expect(getPendingEvents(KEY)).toHaveLength(0)
    expect(prompt?.user).toContain('turn ended in auth work')
  })

  test('first condense seeds from recaps (cold-start backfill)', async () => {
    let prompt: ChatRequest | undefined
    startDeskMemoryService({
      chat: chatReturning('seeded brief', r => {
        prompt = r
      }),
      listRecaps: () => [{ title: 'Auth shipped', subtitle: 'token refresh' }],
      debounceMs: 999_999,
      volumeTrigger: 999,
    })
    emitDeskEvent(turn(1))
    await condenseProjectNow(KEY)
    expect(prompt?.user).toContain('Auth shipped')
  })

  test('idle project with recaps but no events still gets a backfilled brief', async () => {
    startDeskMemoryService({
      chat: chatReturning('backfilled from recaps'),
      listRecaps: () => [{ title: 'History', subtitle: 'old work' }],
    })
    const wrote = await condenseProjectNow(KEY, URI, 'arr')
    expect(wrote).toBe(true)
    expect(getBrief(KEY)?.brief).toBe('backfilled from recaps')
  })

  test('nothing pending and no recaps -> no-op', async () => {
    startDeskMemoryService({ chat: chatReturning('should not be called') })
    expect(await condenseProjectNow(KEY, URI, 'arr')).toBe(false)
  })
})
