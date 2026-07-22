import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  forgetMemory,
  listMemories,
  MAX_MEMORIES_PER_USER,
  MAX_VALUE_LENGTH,
  recallMemory,
  rememberMemory,
  setOrbMemoryFile,
} from './orb-memory'

let file: string

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'orb-memory-')), 'voice-orb-memory.json')
  setOrbMemoryFile(file)
})
afterEach(() => setOrbMemoryFile(null))

describe('remember / recall', () => {
  it('saves a fact and reads it back', () => {
    const out = rememberMemory('jonas', 'his timezone', 'Europe/Oslo', 1000)
    expect(out).toEqual({ saved: { key: 'his timezone', value: 'Europe/Oslo', updatedAt: 1000 } })
    expect(recallMemory('jonas', 'his timezone')?.value).toBe('Europe/Oslo')
  })

  it('matches however he says the key -- case and spacing', () => {
    rememberMemory('jonas', 'Deploy Ritual', 'build web, then broker')
    expect(recallMemory('jonas', '  deploy ritual ')?.value).toBe('build web, then broker')
  })

  it('saving the same key REPLACES, so a correction sticks', () => {
    rememberMemory('jonas', 'timezone', 'Europe/Berlin', 1)
    rememberMemory('jonas', 'timezone', 'Europe/Oslo', 2)
    expect(recallMemory('jonas', 'timezone')?.value).toBe('Europe/Oslo')
    expect(listMemories('jonas')).toHaveLength(1)
  })

  it('returns null for something never said, instead of inventing', () => {
    expect(recallMemory('jonas', 'his favourite colour')).toBeNull()
  })

  it('refuses an empty key or an empty value', () => {
    expect(rememberMemory('jonas', '   ', 'x')).toEqual({ error: 'a memory needs a name' })
    expect(rememberMemory('jonas', 'k', '   ')).toEqual({ error: 'a memory needs something to remember' })
    expect(listMemories('jonas')).toEqual([])
  })

  it('caps a runaway value rather than writing a novel to disk', () => {
    const out = rememberMemory('jonas', 'rant', 'x'.repeat(MAX_VALUE_LENGTH + 500))
    expect('saved' in out && out.saved.value.length).toBe(MAX_VALUE_LENGTH)
  })
})

describe('per user', () => {
  it('keeps users apart', () => {
    rememberMemory('jonas', 'secret', 'mine', 1)
    rememberMemory('someone-else', 'secret', 'theirs', 1)
    expect(recallMemory('jonas', 'secret')?.value).toBe('mine')
    expect(recallMemory('someone-else', 'secret')?.value).toBe('theirs')
    expect(listMemories('jonas')).toHaveLength(1)
  })

  it('an anonymous caller gets the shared default bucket, not a crash', () => {
    rememberMemory(null, 'k', 'v', 1)
    expect(recallMemory(undefined, 'k')?.value).toBe('v')
  })
})

describe('list / forget', () => {
  it('lists newest first', () => {
    rememberMemory('jonas', 'old', 'a', 1)
    rememberMemory('jonas', 'new', 'b', 2)
    expect(listMemories('jonas').map(m => m.key)).toEqual(['new', 'old'])
  })

  it('forget removes it AND hands back what was removed', () => {
    rememberMemory('jonas', 'wrong thing', 'misheard', 5)
    expect(forgetMemory('jonas', 'Wrong Thing')).toEqual({
      forgot: { key: 'wrong thing', value: 'misheard', updatedAt: 5 },
    })
    expect(recallMemory('jonas', 'wrong thing')).toBeNull()
  })

  it('forgetting something that was never there says so', () => {
    expect(forgetMemory('jonas', 'nope')).toEqual({ error: 'nothing remembered under "nope"' })
  })

  it('one user cannot forget another user memory', () => {
    rememberMemory('jonas', 'k', 'v', 1)
    expect(forgetMemory('someone-else', 'k')).toHaveProperty('error')
    expect(recallMemory('jonas', 'k')?.value).toBe('v')
  })
})

describe('bounds + durability', () => {
  it('evicts the OLDEST once over the cap, keeping the newest', () => {
    for (let i = 0; i < MAX_MEMORIES_PER_USER + 10; i++) rememberMemory('jonas', `k${i}`, `v${i}`, i + 1)
    const all = listMemories('jonas')
    expect(all).toHaveLength(MAX_MEMORIES_PER_USER)
    expect(recallMemory('jonas', `k${MAX_MEMORIES_PER_USER + 9}`)).not.toBeNull()
    expect(recallMemory('jonas', 'k0')).toBeNull()
  })

  it('survives a corrupt file instead of taking the broker down', () => {
    writeFileSync(file, 'not json at all', 'utf8')
    expect(listMemories('jonas')).toEqual([])
    expect(rememberMemory('jonas', 'k', 'v', 1)).toHaveProperty('saved')
    expect(recallMemory('jonas', 'k')?.value).toBe('v')
  })

  it('persists across reads -- it is a file, not a process cache', () => {
    rememberMemory('jonas', 'k', 'v', 1)
    setOrbMemoryFile(null)
    setOrbMemoryFile(file)
    expect(recallMemory('jonas', 'k')?.value).toBe('v')
  })
})
