import { beforeEach, describe, expect, it } from 'bun:test'
import { getWatchPatterns, MAX_PATTERNS_PER_WATCHER, resetWatches, type WatcherSocket } from './orb-status-watch'
import { orbWatchTools } from './orb-watch-tools'
import type { DispatchRuntime } from './runtime'
import type { ToolContext } from './tool-def'

/** A runtime whose store holds nothing -- `matchesNow` is exercised against a
 *  real fleet in desk-addresses.test.ts; here we only care about the plumbing. */
const rt = { store: { getAllConversations: () => [] } } as unknown as DispatchRuntime

const tool = () => orbWatchTools(rt).watch_conversations
const socket = (name: string): WatcherSocket => ({ send: () => {}, data: { name } })
const from = (ws?: WatcherSocket): ToolContext => ({ origin: { surface: 'voice', orbId: null, subscriber: ws } })

async function run(ws: WatcherSocket | undefined, mode: string, patterns: string[] | null = null) {
  return (await tool().execute({ mode, patterns }, from(ws))) as Record<string, unknown>
}

beforeEach(() => {
  resetWatches()
})

describe('watch_conversations', () => {
  it('adds a watch and echoes the canonical patterns back', async () => {
    const ws = socket('a')
    expect((await run(ws, 'add', ['Remote Claude'])).watching).toEqual(['remote-claude:*'])
    expect(getWatchPatterns(ws)).toEqual(['remote-claude:*'])
  })

  it('keys the subscription on the CONNECTION from the seam, not on the args', async () => {
    // There is no orbId/connection field in the schema at all, and an injected
    // one is stripped -- an orb cannot subscribe some other panel.
    const parsed = tool().inputSchema.safeParse({ mode: 'add', patterns: ['a'], orbId: 'someone-else' })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ mode: 'add', patterns: ['a'] })

    const a = socket('a')
    await run(a, 'add', ['x'])
    expect(getWatchPatterns(a)).toEqual(['x:*'])
    expect(getWatchPatterns(socket('b'))).toEqual([])
  })

  it('REFUSES when there is no live connection to deliver to', async () => {
    const r = await run(undefined, 'add', ['remote-claude'])
    expect(r.error).toContain('live panel connection')
    expect(r.watching).toBeUndefined()
  })

  it('lists without changing anything', async () => {
    const ws = socket('a')
    await run(ws, 'add', ['a', 'b'])
    expect((await run(ws, 'list')).watching).toEqual(['a:*', 'b:*'])
    expect(getWatchPatterns(ws)).toEqual(['a:*', 'b:*'])
  })

  it('removes, replaces and clears', async () => {
    const ws = socket('a')
    await run(ws, 'add', ['a', 'b'])
    expect((await run(ws, 'remove', ['a'])).watching).toEqual(['b:*'])
    expect((await run(ws, 'replace', ['c'])).watching).toEqual(['c:*'])

    const cleared = await run(ws, 'clear')
    expect(cleared.watching).toEqual([])
    expect(cleared.note).toContain('watching nothing')
  })

  it('names a rejected pattern instead of swallowing it', async () => {
    const r = await run(socket('a'), 'add', ['remote-claude', 'huh?!'])
    expect(r.watching).toEqual(['remote-claude:*'])
    expect(r.rejected).toEqual(['huh?!'])
  })

  it('refuses regex rather than turning it into a fleet-wide watch', async () => {
    const r = await run(socket('a'), 'add', ['.*'])
    expect(r.watching).toEqual([])
    expect(r.rejected).toEqual(['.*'])
  })

  it('says when the cap clipped the list', async () => {
    const many = Array.from({ length: MAX_PATTERNS_PER_WATCHER + 2 }, (_, i) => `p${i}`)
    const r = await run(socket('a'), 'add', many)
    expect((r.watching as string[]).length).toBe(MAX_PATTERNS_PER_WATCHER)
    expect(r.clipped).toBeString()
  })

  it('omits the failure fields entirely on a clean call', async () => {
    const r = await run(socket('a'), 'add', ['remote-claude'])
    expect(r).not.toHaveProperty('rejected')
    expect(r).not.toHaveProperty('clipped')
    expect(r).not.toHaveProperty('note')
  })

  it('never promises durability it cannot keep', async () => {
    // The description is the only place the model learns the lifetime, and
    // over-promising here is how "watch it overnight" gets confirmed.
    const d = tool().description
    expect(d).toContain('as long as this panel stays open')
    expect(d).toContain('reconnect')
    expect(d).not.toContain('hours')
  })

  it('rejects a mode that is not in the enum', () => {
    expect(tool().inputSchema.safeParse({ mode: 'destroy', patterns: null }).success).toBe(false)
    expect(tool().inputSchema.safeParse({ mode: 'add', patterns: null }).success).toBe(true)
  })
})
