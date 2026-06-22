import { describe, expect, it } from 'bun:test'
import type { ChatResponse } from '../recap/shared/openrouter-client'
import type { ChatFn, DispatchRosterEntry } from './classify'
import {
  buildSpawnExec,
  type DispatchCommand,
  type DispatchExecutor,
  type OrchestrateDeps,
  orchestrateDispatch,
  type RosterSource,
} from './orchestrate'
import { DispatchWorktreeError } from './worktree'

function chatReturning(decision: unknown): ChatFn {
  return async () => ({ content: JSON.stringify(decision), raw: {}, usage: {} as never, model: 'm' }) as ChatResponse
}

function rosterOf(entries: DispatchRosterEntry[]): RosterSource {
  return { list: async () => entries }
}

interface Spy {
  spawned: unknown[]
  routed: unknown[]
  revived: unknown[]
  emitted: unknown[]
  audited: unknown[]
}

function makeDeps(over: { chat: ChatFn; roster: RosterSource; executor?: DispatchExecutor }): {
  deps: OrchestrateDeps
  spy: Spy
} {
  const spy: Spy = { spawned: [], routed: [], revived: [], emitted: [], audited: [] }
  const executor: DispatchExecutor = over.executor ?? {
    spawn: async r => {
      spy.spawned.push(r)
      return { conversationId: 'conv_new' }
    },
    route: async r => {
      spy.routed.push(r)
      return { conversationId: r.conversationId }
    },
    revive: async r => {
      spy.revived.push(r)
      return { conversationId: r.conversationId }
    },
  }
  let n = 0
  const deps: OrchestrateDeps = {
    roster: over.roster,
    chat: over.chat,
    executor,
    emit: d => spy.emitted.push(d),
    audit: d => spy.audited.push(d),
    now: () => 12345,
    newId: () => `dec_${++n}`,
    traceId: 'trc_test',
  }
  return { deps, spy }
}

const liveRoster: DispatchRosterEntry[] = [
  { conversationId: 'conv_mic', project: 'rc', title: 'mic', idleMs: 1000, contextTokens: 20_000 },
]

describe('orchestrateDispatch', () => {
  it('routes into a live conversation and emits + audits', async () => {
    const { deps, spy } = makeDeps({
      roster: rosterOf(liveRoster),
      chat: chatReturning({ disposition: 'route', target: 'conv_mic', confidence: 0.9, reasoning: 'ok' }),
    })
    const d = await orchestrateDispatch({ intent: 'fix mic' }, deps)
    expect(d.disposition).toBe('route')
    expect(d.executed).toBe(true)
    expect(d.resultConversationId).toBe('conv_mic')
    expect(spy.routed).toHaveLength(1)
    expect(spy.emitted).toHaveLength(1)
    expect(spy.audited).toHaveLength(1)
  })

  it('ask -> emits candidates, executes nothing', async () => {
    const { deps, spy } = makeDeps({
      roster: rosterOf(liveRoster),
      chat: chatReturning({ disposition: 'route', target: 'conv_mic', confidence: 0.2, reasoning: 'unsure' }),
    })
    const d = await orchestrateDispatch({ intent: 'vague' }, deps)
    expect(d.disposition).toBe('ask')
    expect(d.executed).toBe(false)
    expect(spy.routed).toHaveLength(0)
    expect(spy.emitted).toHaveLength(1)
  })

  it('holds a very-expensive route at the cost gate until confirmed', async () => {
    const expensive: DispatchRosterEntry[] = [
      { conversationId: 'conv_big', contextTokens: 200_000, model: 'opus', idleMs: 1000 },
    ]
    const chat = chatReturning({ disposition: 'route', target: 'conv_big', confidence: 0.95, reasoning: 'continue' })

    const held = makeDeps({ roster: rosterOf(expensive), chat })
    const d1 = await orchestrateDispatch({ intent: 'continue the big one' }, held.deps)
    expect(d1.awaitingConfirmation).toBe(true)
    expect(d1.executed).toBe(false)
    expect(held.spy.routed).toHaveLength(0)

    const go = makeDeps({ roster: rosterOf(expensive), chat })
    const d2 = await orchestrateDispatch({ intent: 'continue the big one', confirmedExpensive: true }, go.deps)
    expect(d2.executed).toBe(true)
    expect(go.spy.routed).toHaveLength(1)
  })

  it('revives an ended conversation', async () => {
    const ended: DispatchRosterEntry[] = [{ conversationId: 'conv_dead', ended: true, contextTokens: 10_000 }]
    const { deps, spy } = makeDeps({
      roster: rosterOf(ended),
      chat: chatReturning({ disposition: 'revive', target: 'conv_dead', confidence: 0.9, reasoning: 'reopen' }),
    })
    const d = await orchestrateDispatch({ intent: 'pick that back up' }, deps)
    expect(d.disposition).toBe('revive')
    expect(spy.revived).toHaveLength(1)
  })

  it('converse -> answers with a reply, spawns/routes nothing (uses the brief fn)', async () => {
    const { deps, spy } = makeDeps({
      roster: rosterOf(liveRoster),
      chat: chatReturning({ disposition: 'converse', confidence: 0.9, reasoning: 'greeting' }),
    })
    deps.brief = async ({ intent, roster }) => `you said "${intent}"; ${roster.length} on the desk`
    const d = await orchestrateDispatch({ intent: "what's going on today?" }, deps)
    expect(d.disposition).toBe('converse')
    expect(d.executed).toBe(false)
    expect(d.reply).toBe('you said "what\'s going on today?"; 1 on the desk')
    expect(spy.spawned).toHaveLength(0)
    expect(spy.routed).toHaveLength(0)
    expect(spy.emitted).toHaveLength(1)
    expect(spy.audited).toHaveLength(1)
  })

  it('new with no project context -> spawns into the host default spawn root', async () => {
    const { deps, spy } = makeDeps({
      roster: rosterOf([]),
      chat: chatReturning({ disposition: 'new', target: null, confidence: 0.9, reasoning: 'fresh' }),
    })
    deps.defaultSpawnRoot = () => '/Users/me/projects'
    const d = await orchestrateDispatch({ intent: 'build me a quick script' }, deps)
    expect(d.disposition).toBe('new')
    expect(d.executed).toBe(true)
    expect((spy.spawned[0] as { cwd: string }).cwd).toBe('/Users/me/projects')
  })

  it('converse -> deterministic fallback reply when no brief fn is wired', async () => {
    const { deps } = makeDeps({
      roster: rosterOf([]),
      chat: chatReturning({ disposition: 'converse', confidence: 0.9, reasoning: 'greeting' }),
    })
    const d = await orchestrateDispatch({ intent: 'hey' }, deps)
    expect(d.disposition).toBe('converse')
    expect(d.reply).toContain("Nothing's on my desk")
  })
})

describe('HOT-PATH worktree guard on spawn', () => {
  const spawnCmd = (over: Partial<DispatchCommand> = {}): DispatchCommand => ({
    intent: 'new feature',
    disposition: 'new',
    ...over,
  })

  it('spawns worktree-correct: computes cwd from projectRoot + worktreeName', async () => {
    const { deps, spy } = makeDeps({ roster: rosterOf([]), chat: chatReturning({}) })
    await orchestrateDispatch(spawnCmd({ projectRoot: '/repo', worktreeName: 'feat-x' }), deps)
    expect((spy.spawned[0] as { cwd: string }).cwd).toBe('/repo/.claude/worktrees/feat-x')
  })

  it('REFUSES on the LIVE path when cwd=main but a worktree is named, executor untouched', async () => {
    const reached = { spawn: false }
    const executor: DispatchExecutor = {
      spawn: async () => {
        reached.spawn = true
        return { conversationId: 'x' }
      },
      route: async r => ({ conversationId: r.conversationId }),
      revive: async r => ({ conversationId: r.conversationId }),
    }
    const { deps, spy } = makeDeps({ roster: rosterOf([]), chat: chatReturning({}), executor })
    // explicit cwd=main + worktreeName -> the incident shape
    await expect(orchestrateDispatch(spawnCmd({ cwd: '/repo', worktreeName: 'feat-x' }), deps)).rejects.toThrow(
      DispatchWorktreeError,
    )
    expect(reached.spawn).toBe(false) // executor never ran
    // the refused attempt is still audited (executed:false)
    expect(spy.audited).toHaveLength(1)
    expect((spy.audited[0] as { executed: boolean }).executed).toBe(false)
  })
})

describe('buildSpawnExec', () => {
  it('computes a worktree cwd from projectRoot + worktreeName', () => {
    expect(buildSpawnExec({ intent: 'x', projectRoot: '/repo', worktreeName: 'wt' }).cwd).toBe(
      '/repo/.claude/worktrees/wt',
    )
  })

  it('passes an explicit cwd through verbatim (so the guard can catch a bad one)', () => {
    const s = buildSpawnExec({ intent: 'x', cwd: '/repo', worktreeName: 'wt' })
    expect(s.cwd).toBe('/repo') // NOT auto-fixed; guard will refuse this combo
    expect(s.worktreeName).toBe('wt')
  })

  it('no worktree -> cwd verbatim, worktreeName null', () => {
    const s = buildSpawnExec({ intent: 'x', cwd: '/repo' })
    expect(s.cwd).toBe('/repo')
    expect(s.worktreeName).toBeNull()
  })

  it('global desk (no cwd/projectRoot) -> falls back to the host spawn root', () => {
    const s = buildSpawnExec({ intent: 'start a scratch tool' }, '/Users/me/projects')
    expect(s.cwd).toBe('/Users/me/projects')
    expect(s.worktreeName).toBeNull()
  })

  it('projectRoot still wins over the fallback root', () => {
    const s = buildSpawnExec({ intent: 'x', projectRoot: '/repo' }, '/Users/me/projects')
    expect(s.cwd).toBe('/repo')
  })

  it('no cwd, no projectRoot, no fallback -> a friendly refusal (not the old cryptic throw)', () => {
    expect(() => buildSpawnExec({ intent: 'x' })).toThrow(/open a project first/)
  })
})
