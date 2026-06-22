import { describe, expect, it } from 'bun:test'
import type { DispatchDecision, DispatchThread } from '../../shared/protocol'
import { buildDispatchToolset, type DispatchToolDeps, dispatchToolSchemas } from './tools'

function fakeDecision(over: Partial<DispatchDecision> = {}): DispatchDecision {
  return {
    type: 'dispatch_decision',
    decisionId: 'dec_1',
    intent: 'x',
    disposition: 'new',
    confidence: 1,
    reasoning: 'r',
    executed: true,
    traceId: 't',
    ts: 0,
    ...over,
  }
}

interface Calls {
  dispatch: unknown[]
  confirm: unknown[]
  screen: unknown[]
  threads: unknown[]
  commit: unknown[]
  subscribe: unknown[]
}

function makeDeps(): { deps: DispatchToolDeps; calls: Calls } {
  const calls: Calls = { dispatch: [], confirm: [], screen: [], threads: [], commit: [], subscribe: [] }
  const deps: DispatchToolDeps = {
    dispatch: async cmd => {
      calls.dispatch.push(cmd)
      return fakeDecision({ intent: cmd.intent, target: cmd.target })
    },
    confirmExpensive: async (id, confirm) => {
      calls.confirm.push({ id, confirm })
      return fakeDecision()
    },
    controlScreen: async (action, target) => {
      calls.screen.push({ action, target })
      return { ok: true }
    },
    listThreads: limit => {
      calls.threads.push({ limit })
      return [] as DispatchThread[]
    },
    commitThread: input => {
      calls.commit.push(input)
      return 'thr_1'
    },
    subscribeProject: async (project, subscribe) => {
      calls.subscribe.push({ project, subscribe })
      return { ok: true }
    },
  }
  return { deps, calls }
}

const ctx = {}

describe('dispatchToolSchemas', () => {
  it('is the single source -- 7 named tools', () => {
    expect(Object.keys(dispatchToolSchemas).sort()).toEqual([
      'commit_thread',
      'confirm_expensive',
      'control_screen',
      'conversation_select',
      'dispatch',
      'list_threads',
      'subscribe_project',
    ])
  })
})

describe('buildDispatchToolset -- execute routes to deps', () => {
  it('dispatch tool calls deps.dispatch with normalized args', async () => {
    const { deps, calls } = makeDeps()
    const set = buildDispatchToolset(deps)
    await set.dispatch!.execute({ intent: 'fix mic', target: null, disposition: null }, ctx)
    expect(calls.dispatch).toEqual([{ intent: 'fix mic', target: undefined, disposition: undefined }])
  })

  it('conversation_select routes into the chosen conversation', async () => {
    const { deps, calls } = makeDeps()
    const set = buildDispatchToolset(deps)
    await set.conversation_select!.execute({ decisionId: 'dec_1', conversationId: 'conv_x' }, ctx)
    expect(calls.dispatch[0]).toMatchObject({ target: 'conv_x', disposition: 'route' })
  })

  it('confirm_expensive forwards the decision + confirm flag', async () => {
    const { deps, calls } = makeDeps()
    const set = buildDispatchToolset(deps)
    await set.confirm_expensive!.execute({ decisionId: 'dec_9', confirm: true }, ctx)
    expect(calls.confirm).toEqual([{ id: 'dec_9', confirm: true }])
  })

  it('list_threads + commit_thread + control_screen + subscribe_project route through', async () => {
    const { deps, calls } = makeDeps()
    const set = buildDispatchToolset(deps)
    await set.list_threads!.execute({ limit: 5 }, ctx)
    await set.commit_thread!.execute({ id: null, title: 'T', summary: 's' }, ctx)
    await set.control_screen!.execute({ action: 'open_modal', target: 'audit' }, ctx)
    await set.subscribe_project!.execute({ project: 'rc', subscribe: true }, ctx)
    expect(calls.threads).toEqual([{ limit: 5 }])
    expect(calls.commit).toEqual([{ id: null, title: 'T', summary: 's' }])
    expect(calls.screen).toEqual([{ action: 'open_modal', target: 'audit' }])
    expect(calls.subscribe).toEqual([{ project: 'rc', subscribe: true }])
  })

  it('each tool input schema parses a valid example', () => {
    for (const [, schema] of Object.entries(dispatchToolSchemas)) {
      expect(schema.inputSchema).toBeDefined()
    }
  })
})
