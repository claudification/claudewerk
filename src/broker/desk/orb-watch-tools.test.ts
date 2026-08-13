import { beforeEach, describe, expect, it } from 'bun:test'
import { getWatchPatterns, MAX_PATTERNS_PER_ORB, resetWatches } from './orb-status-watch'
import { orbWatchTools } from './orb-watch-tools'
import type { DispatchRuntime } from './runtime'
import type { ToolContext } from './tool-def'

/** A runtime whose store holds nothing -- `matchesNow` is exercised against a
 *  real fleet in desk-addresses.test.ts; here we only care about the plumbing. */
const rt = { store: { getAllConversations: () => [] } } as unknown as DispatchRuntime

const tool = () => orbWatchTools(rt).watch_conversations
const from = (orbId: string | null): ToolContext => ({ origin: { surface: 'voice', orbId } })

async function run(orbId: string | null, mode: string, patterns: string[] | null = null) {
  return (await tool().execute({ mode, patterns }, from(orbId))) as Record<string, unknown>
}

beforeEach(() => {
  resetWatches()
})

describe('watch_conversations', () => {
  it('adds a watch and echoes the canonical patterns back', async () => {
    const r = await run('orb-1', 'add', ['Remote Claude'])
    expect(r.watching).toEqual(['remote-claude:*'])
    expect(r.expiresAt).toBeString()
    expect(getWatchPatterns('orb-1')).toEqual(['remote-claude:*'])
  })

  it('keys the subscription on the SEAM orb id, not on anything the model says', async () => {
    // An orbId in the args is stripped by the schema, so a model cannot
    // subscribe some OTHER browser by naming its id.
    const parsed = tool().inputSchema.safeParse({ mode: 'add', patterns: ['a'], orbId: 'orb-2' })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ mode: 'add', patterns: ['a'] })

    await run('orb-1', 'add', ['a'])
    expect(getWatchPatterns('orb-1')).toEqual(['a:*'])
    expect(getWatchPatterns('orb-2')).toEqual([])
  })

  it('lists without changing anything', async () => {
    await run('orb-1', 'add', ['a', 'b'])
    const r = await run('orb-1', 'list')
    expect(r.watching).toEqual(['a:*', 'b:*'])
  })

  it('removes, replaces and clears', async () => {
    await run('orb-1', 'add', ['a', 'b'])
    expect((await run('orb-1', 'remove', ['a'])).watching).toEqual(['b:*'])
    expect((await run('orb-1', 'replace', ['c'])).watching).toEqual(['c:*'])

    const cleared = await run('orb-1', 'clear')
    expect(cleared.watching).toEqual([])
    expect(cleared.note).toContain('watching nothing')
    expect(cleared.expiresAt).toBeUndefined()
  })

  it('names a rejected pattern instead of swallowing it', async () => {
    const r = await run('orb-1', 'add', ['remote-claude', 'huh?!'])
    expect(r.watching).toEqual(['remote-claude:*'])
    expect(r.rejected).toEqual(['huh?!'])
  })

  it('refuses regex rather than turning it into a fleet-wide watch', async () => {
    const r = await run('orb-1', 'add', ['.*'])
    expect(r.watching).toEqual([])
    expect(r.rejected).toEqual(['.*'])
  })

  it('says when the cap clipped the list', async () => {
    const many = Array.from({ length: MAX_PATTERNS_PER_ORB + 2 }, (_, i) => `p${i}`)
    const r = await run('orb-1', 'add', many)
    expect((r.watching as string[]).length).toBe(MAX_PATTERNS_PER_ORB)
    expect(r.clipped).toBeString()
  })

  it('omits the failure fields entirely on a clean call', async () => {
    const r = await run('orb-1', 'add', ['remote-claude'])
    expect(r).not.toHaveProperty('rejected')
    expect(r).not.toHaveProperty('clipped')
    expect(r).not.toHaveProperty('note')
  })

  it('tolerates an orb that sent no instance id', async () => {
    const r = await run(null, 'add', ['remote-claude'])
    expect(r.watching).toEqual(['remote-claude:*'])
    expect(getWatchPatterns(null)).toEqual(['remote-claude:*'])
  })

  it('rejects a mode that is not in the enum', () => {
    expect(tool().inputSchema.safeParse({ mode: 'destroy', patterns: null }).success).toBe(false)
    expect(tool().inputSchema.safeParse({ mode: 'add', patterns: null }).success).toBe(true)
  })
})
