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
  // `getIdentity` is real here, not a stub convenience: the harvest asks who is
  // reporting so it can find the verdict THIS conversation wrote (verdict-harvest.ts).
  const ctx = {
    callbacks,
    elog: () => {},
    getIdentity: () => ({ conversationId: 'conv_status_test' }),
  } as unknown as McpToolContext
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

    test('the description states shipped-but-not-deployed is not needs_you', () => {
      const { description } = setup()
      expect(description).toContain('SHIPPED BUT NOT DEPLOYED IS NOT `needs_you`')
      expect(description).toMatch(/never `needs_you`, never `pending`/i)
    })

    test('a NOTE is the default and a caveat is the CEILING — never higher', () => {
      // Restated by Jonas 2026-08-18: "Something that is shipped, but not
      // deployed, does NOT sum up to a needs_you status! That's a NOTE, and at
      // MOST a caveat." The rule already existed but sat three paragraphs below
      // the definition, so it was not being read with it.
      const { description } = setup()
      expect(description).toContain('AT MOST a caveat')
      const caveatsLine = description.split('\n').find(l => l.trimStart().startsWith('- `caveats`'))
      expect(caveatsLine).toContain('CEILING')
    })

    test('the deploy rule sits with the state definitions, not buried below them', () => {
      // Placement IS the fix: a rule read after the reader has already chosen a
      // state does not change the choice.
      const { description } = setup()
      const blockedDef = description.indexOf('- `blocked`')
      const deployRule = description.indexOf('SHIPPED BUT NOT DEPLOYED')
      const fieldDocs = description.indexOf('The text fields are ALL OPTIONAL')
      expect(deployRule).toBeGreaterThan(blockedDef)
      expect(deployRule).toBeLessThan(fieldDocs)
    })

    test('the notes field claims un-run deploy steps', () => {
      const { description } = setup()
      const notesLine = description.split('\n').find(l => l.trimStart().startsWith('- `notes`'))
      expect(notesLine).toBeDefined()
      expect(notesLine).toContain('deploy')
      expect(notesLine).toContain('`needs_you`')
    })

    test('needs_you means work is STOPPED, not merely that a question exists', () => {
      // Tightened 2026-08-18: the old wording ("a decision, an answer, an
      // approval") read as covering "I finished, what next?", and a third of a
      // real fleet ended up flagged needs_you -- which trains the user to
      // ignore the badge, so the one genuinely stuck run gets missed.
      const { description } = setup()
      const line = description.split('\n').find(l => l.trimStart().startsWith('- `needs_you`'))
      expect(line).toContain('STOPPED')
    })

    test('the description sends "finished, what next?" to done rather than needs_you', () => {
      const { description } = setup()
      expect(description).toContain('IS NOT `needs_you`')
      expect(description).toContain('would anything be left unfinished')
    })
  })
})
