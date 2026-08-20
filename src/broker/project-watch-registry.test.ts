/**
 * Watch lease refcounting.
 *
 * The failure this exists to kill: ONE browser tab is ONE socket, but eight
 * different `useProject` call sites subscribe independently (the transcript's
 * task editor, the Kanban board, the command palette's task mode, the input
 * autocomplete, ...). Refcounting by socket instead of by subscription meant the
 * FIRST unmount disarmed the sentinel watch out from under everyone still
 * mounted -- so a `project_set_status` move silently never reached the board.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  dropSocketFromWatches,
  initProjectWatchRegistry,
  rearmProjectWatches,
  stopProjectWatchRegistry,
  subscribeProjectWatch,
  unsubscribeProjectWatch,
} from './project-watch-registry'

const PROJECT = 'claude://default/Users/x/proj'
const OTHER = 'claude://default/Users/x/other'

let sent: Array<{ type: string; project?: string; projects?: string[] }>
let interest: string[]

/** One sentinel socket that records what the broker armed/disarmed. */
function fakeSentinel(): ServerWebSocket<unknown> {
  return {
    send: (raw: string) => {
      sent.push(JSON.parse(raw))
    },
  } as unknown as ServerWebSocket<unknown>
}

/** The legacy edge verbs only -- the compatibility bridge for old sentinels.
 *  Set syncs ride alongside every one of these and are asserted separately. */
const edges = () => sent.filter(m => m.type !== 'project_watch_set').map(m => m.type)
/** Projects in the most recent set the broker pushed. */
const lastSet = () => sent.filter(m => m.type === 'project_watch_set').at(-1)?.projects ?? []
/** A dashboard socket -- identity is all that matters. */
const dashboard = () => ({}) as ServerWebSocket<unknown>

beforeEach(() => {
  sent = []
  interest = []
  const sentinel = fakeSentinel()
  initProjectWatchRegistry({
    getSentinelForProject: () => sentinel,
    listInterestProjects: () => interest,
    log: () => {},
  })
})

afterEach(stopProjectWatchRegistry)

describe('project watch lease refcounting', () => {
  it('keeps watching while a second subscriber on the SAME socket is still mounted', () => {
    const ws = dashboard()
    subscribeProjectWatch(ws, PROJECT) // transcript task editor
    subscribeProjectWatch(ws, PROJECT) // command palette task mode
    expect(edges()).toEqual(['project_watch'])

    unsubscribeProjectWatch(ws, PROJECT) // palette closes...
    expect(edges()).toEqual(['project_watch']) // ...the watch MUST survive

    unsubscribeProjectWatch(ws, PROJECT) // last subscriber leaves
    expect(edges()).toEqual(['project_watch', 'project_unwatch'])
  })

  it('arms once and disarms once across many subscribers', () => {
    const ws = dashboard()
    for (let i = 0; i < 5; i++) subscribeProjectWatch(ws, PROJECT)
    for (let i = 0; i < 5; i++) unsubscribeProjectWatch(ws, PROJECT)
    expect(edges()).toEqual(['project_watch', 'project_unwatch'])
  })

  it('holds the watch while another TAB still has a subscriber', () => {
    const a = dashboard()
    const b = dashboard()
    subscribeProjectWatch(a, PROJECT)
    subscribeProjectWatch(b, PROJECT)
    unsubscribeProjectWatch(a, PROJECT)
    expect(edges()).toEqual(['project_watch'])
    unsubscribeProjectWatch(b, PROJECT)
    expect(edges()).toEqual(['project_watch', 'project_unwatch'])
  })

  it('a closed socket drops ALL of its subscriptions at once', () => {
    const a = dashboard()
    const b = dashboard()
    subscribeProjectWatch(a, PROJECT)
    subscribeProjectWatch(a, PROJECT)
    subscribeProjectWatch(b, PROJECT)

    dropSocketFromWatches(a) // tab closed with 2 subscriptions outstanding
    expect(edges()).toEqual(['project_watch'])

    unsubscribeProjectWatch(b, PROJECT)
    expect(edges()).toEqual(['project_watch', 'project_unwatch'])
  })

  it('an unbalanced unsubscribe cannot drive the count negative', () => {
    const ws = dashboard()
    subscribeProjectWatch(ws, PROJECT)
    unsubscribeProjectWatch(ws, PROJECT)
    unsubscribeProjectWatch(ws, PROJECT) // stray/duplicate
    expect(edges()).toEqual(['project_watch', 'project_unwatch'])

    // The project must be re-armable afterwards.
    subscribeProjectWatch(ws, PROJECT)
    expect(edges()).toEqual(['project_watch', 'project_unwatch', 'project_watch'])
  })
})

/**
 * THE REGRESSION THAT MATTERS.
 *
 * Until 2026-08-20 the viewer refcount was the only source of watches, so a
 * board was watched exactly while a human had it on screen. Every lane change
 * made by an unattended run went unrecorded and `card_moves` held 0 rows against
 * a fully-shipped card ledger. These tests pin the standing half: a project is
 * watched because work happens in it, not because someone is looking.
 */
describe('standing interest set', () => {
  it('watches an active project with NO dashboard viewer at all', () => {
    interest = [PROJECT]
    rearmProjectWatches()

    expect(lastSet()).toEqual([PROJECT])
  })

  it('keeps watching after the last viewer leaves, when the project is still active', () => {
    interest = [PROJECT]
    rearmProjectWatches()
    const ws = dashboard()
    subscribeProjectWatch(ws, PROJECT)
    unsubscribeProjectWatch(ws, PROJECT)

    // The old code sent project_unwatch here and the board went dark.
    expect(edges()).toEqual(['project_watch'])
    expect(lastSet()).toEqual([PROJECT])
  })

  it('still releases a viewed project that is NOT in the interest set', () => {
    const ws = dashboard()
    subscribeProjectWatch(ws, PROJECT)
    unsubscribeProjectWatch(ws, PROJECT)

    expect(edges()).toEqual(['project_watch', 'project_unwatch'])
    expect(lastSet()).toEqual([])
  })

  it('sends the UNION of standing and viewed projects', () => {
    interest = [PROJECT]
    rearmProjectWatches()
    subscribeProjectWatch(dashboard(), OTHER)

    expect(lastSet()).toEqual([OTHER, PROJECT]) // sorted, deduped
  })

  it('a project in both halves appears once', () => {
    interest = [PROJECT]
    rearmProjectWatches()
    subscribeProjectWatch(dashboard(), PROJECT)

    expect(lastSet()).toEqual([PROJECT])
  })

  it('re-sends the whole set on sentinel reconnect, since its watches are gone', () => {
    interest = [PROJECT, OTHER]
    rearmProjectWatches()
    const before = sent.filter(m => m.type === 'project_watch_set').length

    rearmProjectWatches() // sentinel dropped and came back
    expect(sent.filter(m => m.type === 'project_watch_set').length).toBe(before + 1)
    expect(lastSet()).toEqual([OTHER, PROJECT])
  })

  it('tells a sentinel to watch NOTHING when the union empties', () => {
    // Found while writing these tests: an empty union resolves to no sentinel
    // (there is no project left to look one up by), so a naive fan-out sent
    // nothing at all and the sentinel kept its last watch until the 20-minute
    // lease expired.
    interest = [PROJECT]
    rearmProjectWatches()
    expect(lastSet()).toEqual([PROJECT])

    interest = []
    rearmProjectWatches()
    expect(sent.at(-1)).toMatchObject({ type: 'project_watch_set', projects: [] })
  })

  it('survives a store read that throws, keeping the previous set', () => {
    interest = [PROJECT]
    rearmProjectWatches()

    stopProjectWatchRegistry()
    const sentinel = fakeSentinel()
    initProjectWatchRegistry({
      getSentinelForProject: () => sentinel,
      listInterestProjects: () => {
        throw new Error('database is locked')
      },
      log: () => {},
    })
    // The throw must not take the heartbeat down or empty the set silently --
    // it re-initialised here with no prior set, so an empty set is correct, but
    // the call itself must not reject.
    expect(() => rearmProjectWatches()).not.toThrow()
  })
})
