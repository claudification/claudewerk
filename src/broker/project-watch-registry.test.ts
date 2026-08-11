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

import { beforeEach, describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  dropSocketFromWatches,
  initProjectWatchRegistry,
  subscribeProjectWatch,
  unsubscribeProjectWatch,
} from './project-watch-registry'

const PROJECT = 'claude://default/Users/x/proj'

let sent: Array<{ type: string; project: string }>

/** One sentinel socket that records what the broker armed/disarmed. */
function fakeSentinel(): ServerWebSocket<unknown> {
  return {
    send: (raw: string) => {
      sent.push(JSON.parse(raw))
    },
  } as unknown as ServerWebSocket<unknown>
}

const types = () => sent.map(m => m.type)
/** A dashboard socket -- identity is all that matters. */
const dashboard = () => ({}) as ServerWebSocket<unknown>

beforeEach(() => {
  sent = []
  const sentinel = fakeSentinel()
  initProjectWatchRegistry({ getSentinelForProject: () => sentinel, log: () => {} })
})

describe('project watch lease refcounting', () => {
  it('keeps watching while a second subscriber on the SAME socket is still mounted', () => {
    const ws = dashboard()
    subscribeProjectWatch(ws, PROJECT) // transcript task editor
    subscribeProjectWatch(ws, PROJECT) // command palette task mode
    expect(types()).toEqual(['project_watch'])

    unsubscribeProjectWatch(ws, PROJECT) // palette closes...
    expect(types()).toEqual(['project_watch']) // ...the watch MUST survive

    unsubscribeProjectWatch(ws, PROJECT) // last subscriber leaves
    expect(types()).toEqual(['project_watch', 'project_unwatch'])
  })

  it('arms once and disarms once across many subscribers', () => {
    const ws = dashboard()
    for (let i = 0; i < 5; i++) subscribeProjectWatch(ws, PROJECT)
    for (let i = 0; i < 5; i++) unsubscribeProjectWatch(ws, PROJECT)
    expect(types()).toEqual(['project_watch', 'project_unwatch'])
  })

  it('holds the watch while another TAB still has a subscriber', () => {
    const a = dashboard()
    const b = dashboard()
    subscribeProjectWatch(a, PROJECT)
    subscribeProjectWatch(b, PROJECT)
    unsubscribeProjectWatch(a, PROJECT)
    expect(types()).toEqual(['project_watch'])
    unsubscribeProjectWatch(b, PROJECT)
    expect(types()).toEqual(['project_watch', 'project_unwatch'])
  })

  it('a closed socket drops ALL of its subscriptions at once', () => {
    const a = dashboard()
    const b = dashboard()
    subscribeProjectWatch(a, PROJECT)
    subscribeProjectWatch(a, PROJECT)
    subscribeProjectWatch(b, PROJECT)

    dropSocketFromWatches(a) // tab closed with 2 subscriptions outstanding
    expect(types()).toEqual(['project_watch'])

    unsubscribeProjectWatch(b, PROJECT)
    expect(types()).toEqual(['project_watch', 'project_unwatch'])
  })

  it('an unbalanced unsubscribe cannot drive the count negative', () => {
    const ws = dashboard()
    subscribeProjectWatch(ws, PROJECT)
    unsubscribeProjectWatch(ws, PROJECT)
    unsubscribeProjectWatch(ws, PROJECT) // stray/duplicate
    expect(types()).toEqual(['project_watch', 'project_unwatch'])

    // The project must be re-armable afterwards.
    subscribeProjectWatch(ws, PROJECT)
    expect(types()).toEqual(['project_watch', 'project_unwatch', 'project_watch'])
  })
})
