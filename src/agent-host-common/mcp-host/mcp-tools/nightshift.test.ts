/**
 * THE ROUTING, which is the whole bug: `enqueue` used to be relayed to the
 * sentinel as an artifact op and land in `.nightshift/queue/`, a directory
 * nothing reads. It must now write the board and never touch the wire -- while
 * every OTHER action keeps its envelope exactly as it was, including the two
 * legacy queue reads the card says stay.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenDialogRegistry } from '../open-dialogs'
import { registerNightshiftTools } from './nightshift'
import type { McpToolContext, ToolCtx } from './types'

let root: string
let posted: Array<Record<string, unknown>>
const realFetch = globalThis.fetch

function buildCtx(): McpToolContext {
  return {
    callbacks: {},
    getIdentity: () => null,
    getClaudeCodeVersion: () => '0.0.0',
    getDialogCwd: () => root,
    pendingDialogs: new Map(),
    openDialogs: new OpenDialogRegistry(),
    elog: () => {},
    brokerUrl: 'ws://localhost:9999',
    brokerSecret: 'secret',
  }
}

const TOOL_CTX: ToolCtx = { rawArgs: {}, extra: {} }

async function call(params: Record<string, string>): Promise<{ isError: boolean; text: string }> {
  const res = await registerNightshiftTools(buildCtx()).nightshift.handle(params, TOOL_CTX)
  return { isError: !!res.isError, text: res.content[0].text }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-tool-'))
  posted = []
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    posted.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
    return { json: async () => ({ ok: true }) } as unknown as Response
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(root, { recursive: true, force: true })
})

describe('enqueue no longer reaches the sentinel', () => {
  test('it writes a board card and POSTs nothing', async () => {
    const res = await call({ project: `claude://default${root}`, action: 'enqueue', title: 'Nightly chore' })
    expect(res.isError).toBe(false)
    expect(posted).toEqual([])
    expect(existsSync(join(root, '.rclaude', 'project', 'cards', 'nightly-chore.md'))).toBe(true)
  })

  test('a refused enqueue POSTs nothing either -- no fallback to the dead store', async () => {
    const res = await call({ project: `claude://default${root}`, action: 'enqueue' })
    expect(res.isError).toBe(true)
    expect(posted).toEqual([])
  })
})

describe('every other action keeps its envelope', () => {
  test('the legacy queue reads still relay, exactly as the card requires', async () => {
    await call({ project: 'claude://default/p', action: 'queue' })
    await call({ project: 'claude://default/p', action: 'dequeue', id: '003' })
    expect(posted).toEqual([
      { project: 'claude://default/p', op: 'queue_list' },
      { project: 'claude://default/p', op: 'dequeue', dequeueId: '003' },
    ])
  })

  test('report still relays', async () => {
    await call({ project: 'claude://default/p', action: 'report', run_id: '2026-08-21', id: '001', title: 'T' })
    expect(posted).toHaveLength(1)
    expect(posted[0].op).toBe('report')
  })

  test('run_start, run_finalize, snapshot and run still relay', async () => {
    await call({ project: 'claude://default/p', action: 'run_start', run_id: '2026-08-21' })
    await call({ project: 'claude://default/p', action: 'run_finalize', run_id: '2026-08-21' })
    await call({ project: 'claude://default/p', action: 'snapshot' })
    await call({ project: 'claude://default/p', action: 'run' })
    expect(posted.map(p => p.op)).toEqual(['run_start', 'run_finalize', 'snapshot', 'run'])
  })

  test('no action maps to op=enqueue any more', async () => {
    await call({ project: 'claude://default/p', action: 'queue' })
    await call({ project: 'claude://default/p', action: 'run' })
    await call({ project: `claude://default${root}`, action: 'enqueue', title: 'T' })
    expect(posted.some(p => p.op === 'enqueue')).toBe(false)
  })
})
