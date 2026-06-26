import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenDialogRegistry } from '../open-dialogs'
import { _resetBrokerRpc, dispatchBrokerRpcResponse, setBrokerRpcSender } from './lib/broker-rpc'
import { registerSotuTools } from './sotu'
import type { AgentHostIdentity, McpToolContext, ToolDef } from './types'

function identityFor(cwd: string): AgentHostIdentity {
  return { ccSessionId: 'cc_xx', conversationId: 'conv_xx', cwd, headless: true }
}

function buildCtx(identity: AgentHostIdentity | null): McpToolContext {
  return {
    callbacks: {},
    getIdentity: () => identity,
    getClaudeCodeVersion: () => '0.0.0',
    getDialogCwd: () => '/tmp',
    pendingDialogs: new Map(),
    openDialogs: new OpenDialogRegistry(),
    elog: () => {},
  }
}

function tools() {
  return registerSotuTools(buildCtx(identityFor('/Users/jonas/projects/foo')))
}

interface CapturedSend {
  type: string
  payload: Record<string, unknown>
}

async function callTool(
  tool: ToolDef,
  params: Record<string, unknown>,
  reply?: (id: string) => Record<string, unknown>,
) {
  const sent: CapturedSend[] = []
  setBrokerRpcSender(msg => {
    const m = msg as unknown as Record<string, unknown>
    sent.push({ type: String(m.type), payload: m })
    if (reply)
      queueMicrotask(() => dispatchBrokerRpcResponse({ requestId: m.requestId, ...reply(String(m.requestId)) }))
  })
  const result = await tool.handle(params as Record<string, string>, { rawArgs: params, extra: {} })
  return { result, sent }
}

describe('sotu MCP tools', () => {
  beforeEach(() => _resetBrokerRpc())
  afterEach(() => _resetBrokerRpc())

  test('exposes the SOTU read/write/tune tools', () => {
    expect(Object.keys(tools()).sort()).toEqual([
      'get_state_of_union',
      'sotu_configure',
      'sotu_contribute',
      'sotu_eval',
    ])
  })

  test('get_state_of_union resolves @self to the caller project + returns the view', async () => {
    const view = { project: 'claude://h/foo', enabled: true, chronicle: {}, holds: [], alerts: [], builtAt: 1 }
    const { result, sent } = await callTool(tools().get_state_of_union, { projectUri: '@self' }, () => ({
      ok: true,
      view,
    }))
    expect(sent[0].type).toBe('get_state_of_union_request')
    expect(String(sent[0].payload.projectUri)).toContain('foo')
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('claude://h/foo')
  })

  test('get_state_of_union surfaces a broker error', async () => {
    const { result } = await callTool(tools().get_state_of_union, {}, () => ({ ok: false, error: 'nope' }))
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('nope')
  })

  test('sotu_contribute validates noteType', async () => {
    const { result } = await callTool(tools().sotu_contribute, { noteType: 'bogus', payload: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('noteType must be one of')
  })

  test('sotu_contribute passes a claim target through + acks', async () => {
    const { result, sent } = await callTool(
      tools().sotu_contribute,
      { noteType: 'lock', payload: 'editing', target: { kind: 'claim', path: 'src/x.ts' } },
      () => ({ ok: true, pendingContribs: 3 }),
    )
    expect(sent[0].type).toBe('sotu_contribute_request')
    expect(sent[0].payload.target).toMatchObject({ kind: 'claim', path: 'src/x.ts' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('pendingContribs')
  })

  test('sotu_configure forwards the tuning write + @self project + returns the config', async () => {
    const config = { enabled: true, stakes: 'side', budget: { dailyUsd: 2 }, tuning: {}, overrides: {} }
    const { result, sent } = await callTool(
      tools().sotu_configure,
      { projectUri: '@self', enabled: true, stakes: 'side', params: { burstThreshold: 4 } },
      () => ({ ok: true, config }),
    )
    expect(sent[0].type).toBe('sotu_configure_request')
    expect(String(sent[0].payload.projectUri)).toContain('foo')
    expect(sent[0].payload.enabled).toBe(true)
    expect(sent[0].payload.params).toMatchObject({ burstThreshold: 4 })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('side')
  })

  test('sotu_eval forwards the request + returns the evals', async () => {
    const evals = [{ ts: 1, mode: 'scribe', costUsd: 0.02, recipe: { mode: 'scribe' } }]
    const { result, sent } = await callTool(tools().sotu_eval, { limit: 5 }, () => ({ ok: true, evals }))
    expect(sent[0].type).toBe('sotu_eval_request')
    expect(sent[0].payload.limit).toBe(5)
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('scribe')
  })
})
