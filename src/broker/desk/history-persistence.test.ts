import { describe, expect, test } from 'bun:test'
import {
  createHistorySaver,
  deserializeHistory,
  fileNameForKey,
  loadAllHistories,
  type PersistableState,
  type PersistenceDeps,
  serializeHistory,
} from './history-persistence'
import { appendTurn, createHistory, getBlock, upsertBlock } from './living-history'

function sampleState(userKey = 'jonas'): PersistableState {
  const history = createHistory()
  upsertBlock(history, 'fleet', 'fleet', '- arr: 2 live', 10)
  upsertBlock(history, 'memory', 'memory', 'likes Sonnet', 11)
  appendTurn(history, 'user', 'check arr', 12)
  appendTurn(history, 'assistant', 'on it', 13)
  return {
    userKey,
    history,
    lastConsolidatedAt: 99,
    transcript: [
      { kind: 'turn', role: 'user', content: 'older', ts: 1 },
      { kind: 'turn', role: 'assistant', content: 'older reply', ts: 2 },
    ],
  }
}

describe('serialize/deserialize', () => {
  test('round-trips blocks (Map order), turns, transcript, lastConsolidatedAt', () => {
    const back = deserializeHistory(serializeHistory(sampleState()))
    expect(back.userKey).toBe('jonas')
    expect(back.lastConsolidatedAt).toBe(99)
    expect([...back.history.blocks.keys()]).toEqual(['fleet', 'memory']) // order preserved
    expect(getBlock(back.history, 'memory')?.content).toBe('likes Sonnet')
    expect(back.history.turns.map(t => t.content)).toEqual(['check arr', 'on it'])
    expect(back.transcript.map(t => t.content)).toEqual(['older', 'older reply'])
    expect(back.transcript[0].kind).toBe('turn') // rehydrated to a real Turn
  })

  test('throws on corrupt JSON and on a missing userKey', () => {
    expect(() => deserializeHistory('{not json')).toThrow()
    expect(() => deserializeHistory(JSON.stringify({ blocks: [] }))).toThrow(/userKey/)
  })

  test('tolerates absent blocks/turns/transcript', () => {
    const back = deserializeHistory(JSON.stringify({ userKey: 'u' }))
    expect(back.history.turns).toHaveLength(0)
    expect(back.transcript).toHaveLength(0)
    expect(back.lastConsolidatedAt).toBeNull()
  })
})

/** An in-memory fs + manual timer queue so the debounce + atomic write are driven
 *  deterministically (no real disk, no real clock). */
function fakeEnv() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  let clock = 1000
  let nextHandle = 1
  const pending = new Map<number, () => void>()
  const deps: PersistenceDeps = {
    readdir: dir => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)),
    readFile: path => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT ${path}`)
      return v
    },
    writeFile: (path, data) => files.set(path, data),
    rename: (from, to) => {
      const v = files.get(from)
      if (v === undefined) throw new Error(`ENOENT ${from}`)
      files.set(to, v)
      files.delete(from)
    },
    remove: path => files.delete(path),
    ensureDir: dir => dirs.add(dir),
    now: () => clock++,
    schedule: fn => {
      const h = nextHandle++
      pending.set(h, fn)
      return h
    },
    cancel: handle => pending.delete(handle as number),
  }
  return {
    deps,
    files,
    dirs,
    flush: () => {
      const fns = [...pending.values()]
      pending.clear()
      for (const fn of fns) fn()
    },
    pendingCount: () => pending.size,
  }
}

describe('loadAllHistories', () => {
  test('reads each file, keys by in-JSON userKey, skips corrupt; missing dir -> empty', () => {
    const env = fakeEnv()
    const base = '/cache/dispatcher'
    env.files.set(`${base}/${fileNameForKey('jonas')}`, serializeHistory(sampleState('jonas')))
    env.files.set(`${base}/${fileNameForKey('alice')}`, serializeHistory(sampleState('alice')))
    env.files.set(`${base}/broken.json`, '{ corrupt')
    const loaded = loadAllHistories('/cache', env.deps)
    expect([...loaded.keys()].sort()).toEqual(['alice', 'jonas'])
    expect(loaded.get('jonas')?.history.turns).toHaveLength(2)
    // no dir at all
    expect(loadAllHistories('/nope', env.deps).size).toBe(0)
  })
})

describe('createHistorySaver', () => {
  test('debounce coalesces rapid saves into ONE atomic write of the latest state', () => {
    const env = fakeEnv()
    const saver = createHistorySaver('/cache', env.deps)
    let n = 0
    const getState = () => {
      n++
      return sampleState('jonas') // captured lazily at fire time
    }
    saver.scheduleSave('jonas', getState)
    saver.scheduleSave('jonas', getState)
    saver.scheduleSave('jonas', getState)
    expect(env.pendingCount()).toBe(1) // coalesced
    env.flush()
    expect(n).toBe(1) // state read once, at fire time
    const file = `/cache/dispatcher/${fileNameForKey('jonas')}`
    expect(env.files.has(file)).toBe(true)
    expect([...env.files.keys()].some(k => k.endsWith('.tmp'))).toBe(false) // tmp renamed away
    expect(deserializeHistory(env.files.get(file) as string).userKey).toBe('jonas')
  })

  test('removeFile cancels a pending write and deletes the file', () => {
    const env = fakeEnv()
    const saver = createHistorySaver('/cache', env.deps)
    const file = `/cache/dispatcher/${fileNameForKey('jonas')}`
    saver.scheduleSave('jonas', () => sampleState('jonas'))
    env.flush()
    expect(env.files.has(file)).toBe(true)
    saver.scheduleSave('jonas', () => sampleState('jonas'))
    saver.removeFile('jonas')
    expect(env.pendingCount()).toBe(0) // pending write cancelled
    env.flush()
    expect(env.files.has(file)).toBe(false) // deleted, not rewritten
  })
})
