/**
 * A VERDICT THAT IS NOT ON THE CARD WAS NOT DELIVERED.
 *
 * REGRESSION, 2026-08-22: a werk-verifier approved a 224-file migration --
 * scratch worktree, every command re-run, four commits read -- and the card
 * settled `done` carrying no verdict section, no `Built` section and no evidence
 * keys. From the board alone that is indistinguishable from a card nobody ever
 * reviewed, and the next werk-master generation found the approval only by
 * guessing the verifier's conversation id and reading its transcript tail.
 *
 * These tests are the wall: a review does not close unless its judgement reaches
 * the card, and a write that fails REFUSES the move rather than reporting
 * success. Real files in a real temp board -- the whole bug was about whether
 * bytes reached a card on disk, so a mocked writer would fake it away.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LiveStatusInput } from '../../../shared/protocol'
import { handleProjectSetStatus } from './project-set-status'
import { registerStatusTool } from './status'
import type { McpChannelCallbacks, McpToolContext, ToolCtx } from './types'
import { forgetVerdict } from './verdict-harvest'

const CARD_ID = 'werk-something'
const GUARD = 'conv_guard'
let root: string
let statuses: LiveStatusInput[]

function cardPath(): string {
  return join(root, '.rclaude', 'project', 'cards', `${CARD_ID}.md`)
}

function card(): string {
  return readFileSync(cardPath(), 'utf8')
}

function writeCard(status: string, body = '## The spec\n\nbuild it\n'): void {
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
  writeFileSync(cardPath(), `---\ntitle: T\nstatus: ${status}\n---\n\n${body}`, 'utf8')
}

function ctx(): McpToolContext {
  const callbacks: McpChannelCallbacks = { onSetStatus: s => statuses.push(s) }
  return {
    callbacks,
    elog: () => {},
    getDialogCwd: () => root,
    getIdentity: () => ({ conversationId: GUARD }),
  } as unknown as McpToolContext
}

function move(status: string, extra: Record<string, string> = {}) {
  return handleProjectSetStatus(ctx(), { id: CARD_ID, status, ...extra })
}

function report(params: Record<string, unknown>) {
  const tools = registerStatusTool(ctx())
  return tools.set_status.handle(params as Record<string, string>, { rawArgs: params } as ToolCtx)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verdict-'))
  statuses = []
})

afterEach(() => {
  forgetVerdict(GUARD)
  chmodSync(join(root, '.rclaude', 'project', 'cards'), 0o755)
  rmSync(root, { recursive: true, force: true })
})

describe('closing a review requires a verdict', () => {
  test('in-review -> done with no verdict is REFUSED and the lane does not move', async () => {
    writeCard('in-review')
    const res = await move('done')
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('leaving in-review is a VERDICT')
    expect(card()).toContain('status: in-review')
    expect(card()).not.toContain('## Verdict')
  })

  test('the refusal names the parameter and the target, so a retry can be right', async () => {
    writeCard('in-review')
    const res = await move('in-progress')
    expect(res.content[0].text).toContain(`project_set_status(id="${CARD_ID}", status="in-progress", verdict=`)
  })

  test('a blank verdict is no verdict', async () => {
    writeCard('in-review')
    expect((await move('done', { verdict: '   \n  ' })).isError).toBe(true)
    expect(card()).toContain('status: in-review')
  })
})

describe('the verdict reaches the card body', () => {
  test('an approval lands attributed to the acting conversation, and the lane moves', async () => {
    writeCard('in-review')
    const res = await move('done', { verdict: 'Re-ran the suite on the merge with main. Green.' })
    expect(res.isError).toBeUndefined()
    const written = card()
    expect(written).toContain('status: done')
    expect(written).toContain('## Verdict')
    expect(written).toContain(`**APPROVED** by \`${GUARD}\``)
    expect(written).toContain('Re-ran the suite on the merge with main. Green.')
  })

  test('a bounce lands as BOUNCED with the findings', async () => {
    writeCard('in-review')
    await move('in-progress', { verdict: '`bun run test:web` was never run and it is red.' })
    expect(card()).toContain('**BOUNCED**')
    expect(card()).toContain('never run and it is red')
    expect(card()).toContain('status: in-progress')
  })

  test('caveats and notes passed with the move land under it', async () => {
    writeCard('in-review')
    await move('done', { verdict: 'green', caveats: 'inert until a deploy', notes: 'worktree left standing' })
    expect(card()).toContain('**Caveats:** inert until a deploy')
    expect(card()).toContain('**Notes:** worktree left standing')
  })

  test('the card keeps its own body and frontmatter', async () => {
    writeCard('in-review')
    await move('done', { verdict: 'green' })
    expect(card()).toContain('## The spec')
    expect(card()).toContain('build it')
    expect(card()).toContain('title: T')
  })

  test('a re-review REPLACES the previous verdict rather than stacking one', async () => {
    writeCard('in-review')
    await move('in-progress', { verdict: 'suite red' })
    writeFileSync(cardPath(), card().replace('status: in-progress', 'status: in-review'), 'utf8')
    await move('done', { verdict: 'fixed and green' })
    expect(card().split('## Verdict').length - 1).toBe(1)
    expect(card()).toContain('fixed and green')
    expect(card()).not.toContain('suite red')
  })
})

describe('moves that close no review are untouched', () => {
  test('a worker handing off to in-review needs no verdict', async () => {
    writeCard('in-progress')
    const res = await move('in-review')
    expect(res.isError).toBeUndefined()
    expect(card()).toContain('status: in-review')
    expect(card()).not.toContain('## Verdict')
  })

  test('a question card going straight open -> done needs no verdict', async () => {
    writeCard('open')
    const res = await move('done')
    expect(res.isError).toBeUndefined()
    expect(card()).toContain('status: done')
  })
})

/**
 * THE FAILURE THIS CARD IS NAMED FOR. A verifier that reports success while its
 * verdict went nowhere is worse than one that has to retry: the card reads
 * settled and nobody can produce the approval.
 */
describe('a verdict that cannot be written REFUSES the move', () => {
  test('an unwritable card leaves the lane where it was and says why', async () => {
    writeCard('in-review')
    chmodSync(join(root, '.rclaude', 'project', 'cards'), 0o555)
    const res = await move('done', { verdict: 'green' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('the lane did NOT move')
    chmodSync(join(root, '.rclaude', 'project', 'cards'), 0o755)
    expect(card()).toContain('status: in-review')
    expect(card()).not.toContain('## Verdict')
  })
})

/**
 * THE HARVEST. The verifier settles the card FIRST and signs off with
 * `set_status` LAST, so the move cannot read a status that does not exist yet --
 * the enrichment has to run from the other end.
 */
describe('set_status caveats and notes are harvested onto the verdict', () => {
  test('a later sign-off folds its caveats and notes into the verdict already written', async () => {
    writeCard('in-review')
    await move('done', { verdict: 'green' })
    expect(card()).not.toContain('Caveats')

    const res = await report({ state: 'done', done: 'approved it', caveats: 'inert until deploy', notes: 'no rebuild' })
    expect(card()).toContain('**Caveats:** inert until deploy')
    expect(card()).toContain('**Notes:** no rebuild')
    expect(card()).toContain('green')
    expect(res.content[0].text).toContain(`verdict on \`${CARD_ID}\``)
  })

  test('a sign-off with neither field changes nothing and says nothing', async () => {
    writeCard('in-review')
    await move('done', { verdict: 'green' })
    const before = card()
    const res = await report({ state: 'done', done: 'approved it' })
    expect(card()).toBe(before)
    expect(res.content[0].text).not.toContain('verdict on')
  })

  test('a conversation that wrote no verdict is left alone entirely', async () => {
    writeCard('in-progress')
    await move('in-review')
    const before = card()
    await report({ state: 'done', done: 'handed off', caveats: 'watch the flake' })
    expect(card()).toBe(before)
  })

  test('a harvest that cannot be written WARNS instead of pretending', async () => {
    writeCard('in-review')
    await move('done', { verdict: 'green' })
    chmodSync(join(root, '.rclaude', 'project', 'cards'), 0o555)
    const res = await report({ state: 'done', caveats: 'inert until deploy' })
    expect(res.content[0].text).toContain('could NOT be added')
    // The status itself still went through -- the harvest is enrichment, and a
    // failed enrichment must not swallow the conversation's handoff.
    expect(statuses.length).toBe(1)
  })
})
