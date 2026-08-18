import { describe, expect, test } from 'bun:test'
import type { LiveStatusInput } from '../../../shared/protocol'
import { registerStatusTool } from './status'
import type { McpChannelCallbacks, McpToolContext, ToolCtx } from './types'

function setup() {
  const statuses: LiveStatusInput[] = []
  const buzzes: string[] = []
  const callbacks: McpChannelCallbacks = {
    onSetStatus: s => statuses.push(s),
    onNotify: m => buzzes.push(m),
  }
  const ctx = { callbacks, elog: () => {} } as unknown as McpToolContext
  const tools = registerStatusTool(ctx)
  const call = (rawArgs: Record<string, unknown>) =>
    tools.set_status.handle(rawArgs as Record<string, string>, { rawArgs } as ToolCtx)
  return { call, statuses, buzzes, description: tools.set_status.description }
}

describe('set_status tool', () => {
  test('records state and only the non-empty fields', async () => {
    const { call, statuses } = setup()
    await call({ state: 'done', done: 'shipped', pending: '   ', notes: 'not deployed' })
    expect(statuses).toEqual([{ state: 'done', done: 'shipped', notes: 'not deployed' }])
  })

  test('rejects an unknown state', async () => {
    const { call, statuses } = setup()
    expect((await call({ state: 'thinking' })).isError).toBe(true)
    expect(statuses.length).toBe(0)
  })

  test('notify buzzes the user, absent notify does not', async () => {
    const { call, buzzes } = setup()
    await call({ state: 'done' })
    expect(buzzes.length).toBe(0)
    await call({ state: 'needs_you', notify: 'pick one' })
    expect(buzzes).toEqual(['pick one'])
  })

  /**
   * REGRESSION: agents parked FINISHED work under `needs_you` because a broker
   * restart / build:packages / hard refresh had not happened yet. Nobody was
   * actually blocked — the badge just rotted. The description is the only place
   * that teaches this, so pin the contract here.
   */
  describe('a pending deploy is a NOTE, not needs_you', () => {
    const opsSteps = ['broker restart', 'build:packages', 'sentinel', 'hard refresh']

    test('the description names every operational step', () => {
      const { description } = setup()
      for (const step of opsSteps) expect(description).toContain(step)
    })

    test('the description states a pending deploy is not needs_you', () => {
      const { description } = setup()
      expect(description).toContain('A PENDING DEPLOY IS NOT `needs_you`')
      expect(description).toMatch(/never in `needs_you` or `pending`|NEVER in `needs_you` or `pending`/i)
    })

    test('the notes field claims un-run deploy steps', () => {
      const { description } = setup()
      const notesLine = description.split('\n').find(l => l.trimStart().startsWith('- `notes`'))
      expect(notesLine).toBeDefined()
      expect(notesLine).toContain('deploy')
      expect(notesLine).toContain('`needs_you`')
    })

    test('needs_you is scoped to what only the user can supply', () => {
      const { description } = setup()
      const line = description.split('\n').find(l => l.trimStart().startsWith('- `needs_you`'))
      expect(line).toContain('only THEY can supply')
    })
  })
})
