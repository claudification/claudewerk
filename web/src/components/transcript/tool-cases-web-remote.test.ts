import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { shortToolLabel } from './remote-tool-style'
import type { ToolCaseInput } from './tool-case-types'
import { dispatchToolCase } from './tool-dispatch'
import { visibleBytes } from './web-remote-shared'

function makeCtx(overrides: Partial<ToolCaseInput> = {}): ToolCaseInput {
  return { input: {}, expandAll: false, ...overrides }
}

/** Wrap a payload the way the MCP site does: content blocks around JSON. */
function mcpResult(payload: unknown): string {
  return JSON.stringify([{ type: 'text', text: JSON.stringify(payload) }])
}

function markup(node: unknown): string {
  return renderToStaticMarkup(node as ReactElement)
}

describe('web_execute_script', () => {
  const code = 'const x = 1\nreturn x + 1'

  it('summarises size instead of dumping the code', () => {
    const r = dispatchToolCase('mcp__rclaude__web_execute_script', makeCtx({ input: { code } }))
    const html = markup(r.summary)
    expect(html).toContain('script')
    expect(html).toContain('2 lines')
    expect(html).not.toContain('const x')
  })

  it('renders the code inline (syntax-highlighted block)', () => {
    const r = dispatchToolCase('mcp__rclaude__web_execute_script', makeCtx({ input: { code } }))
    expect(r.inlineContent).not.toBeNull()
  })

  it('shows the timeout when one was set', () => {
    const r = dispatchToolCase('mcp__rclaude__web_execute_script', makeCtx({ input: { code, timeoutMs: 30_000 } }))
    expect(markup(r.summary)).toContain('30s timeout')
  })

  it('unwraps { result } from the MCP envelope into a JSON block', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_execute_script',
      makeCtx({ input: { code }, result: mcpResult({ result: { themeAccent: 'oklch(75% .15 85)' } }) }),
    )
    expect(r.details).not.toBeNull()
  })

  it('says so when the script returned nothing', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_execute_script',
      makeCtx({ input: { code }, result: mcpResult({ result: null }) }),
    )
    expect(markup(r.details)).toContain('no return value')
  })
})

describe('web screenshots', () => {
  it('renders the captured image, not the url string', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_screenshot',
      makeCtx({ input: { selector: '.anvil-note' }, result: mcpResult({ url: 'https://j.duplo.org/a.png' }) }),
    )
    expect(markup(r.summary)).toContain('.anvil-note')
    expect(markup(r.details)).toContain('<img')
    expect(markup(r.details)).toContain('https://j.duplo.org/a.png')
  })

  it('falls back to "viewport" with no selector', () => {
    const r = dispatchToolCase('mcp__rclaude__web_screenshot', makeCtx({ input: {} }))
    expect(markup(r.summary)).toContain('viewport')
  })

  it('renders a shell screenshot the same way', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_terminal_screenshot',
      makeCtx({ input: { shellId: 'sh_abcdef123456' }, result: mcpResult({ url: 'https://j.duplo.org/b.png' }) }),
    )
    expect(markup(r.summary)).toContain('sh_abcde')
    expect(markup(r.details)).toContain('<img')
  })
})

describe('web panel-driving ops', () => {
  it('lists opted-in clients with a ttl', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_list_clients',
      makeCtx({ result: mcpResult([{ clientId: 'c1', label: 'Safari', userName: 'jonas', ttlMs: 1_800_000 }]) }),
    )
    expect(markup(r.summary)).toContain('1 opted in')
    expect(markup(r.details)).toContain('Safari')
    expect(markup(r.details)).toContain('30m left')
  })

  it('flags an empty client list', () => {
    const r = dispatchToolCase('mcp__rclaude__web_list_clients', makeCtx({ result: mcpResult([]) }))
    expect(markup(r.summary)).toContain('nobody to drive')
  })

  it('shows the palette command id and args', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_execute_command',
      makeCtx({ input: { id: 'conversation.fork', args: ['now'] } }),
    )
    const html = markup(r.summary)
    expect(html).toContain('conversation.fork')
    expect(html).toContain('now')
  })

  it('previews a sent prompt', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_send_prompt',
      makeCtx({ input: { conversationId: 'conv_1', text: 'ship it' } }),
    )
    expect(markup(r.summary)).toContain('ship it')
    expect(markup(r.details)).toContain('ship it')
  })

  it('reports transcript entry counts', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_read_transcript',
      makeCtx({ result: mcpResult({ conversationId: 'conv_1', count: 42, text: 'line' }) }),
    )
    expect(markup(r.summary)).toContain('42 entries')
  })

  it('renders the perf monitor toggle state', () => {
    const on = dispatchToolCase('mcp__rclaude__web_set_perf_monitor', makeCtx({ input: { enabled: true } }))
    const off = dispatchToolCase('mcp__rclaude__web_set_perf_monitor', makeCtx({ input: { enabled: false } }))
    expect(markup(on.summary)).toContain('ON')
    expect(markup(off.summary)).toContain('OFF')
  })
})

describe('web terminal ops', () => {
  it('lists host shells with status dots', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_terminal_list',
      makeCtx({
        result: mcpResult({
          shells: [{ shellId: 'sh_12345678', title: 'build', path: '/Users/jonas/projects/x', status: 'running' }],
        }),
      }),
    )
    expect(markup(r.summary)).toContain('1 on host')
    expect(markup(r.details)).toContain('build')
    expect(markup(r.details)).toContain('bg-green-400')
  })

  it('counts lines read from a shell buffer', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_terminal_read',
      makeCtx({ input: { shellId: 'sh_12345678' }, result: mcpResult({ text: 'a\nb\nc' }) }),
    )
    expect(markup(r.summary)).toContain('3 lines')
  })

  it('makes written control bytes visible', () => {
    const r = dispatchToolCase(
      'mcp__rclaude__web_terminal_write',
      makeCtx({ input: { shellId: 'sh_12345678', data: 'ls -la\n' } }),
    )
    expect(markup(r.summary)).toContain('ls -la⏎')
  })

  it('distinguishes attach from detach', () => {
    const a = dispatchToolCase('mcp__rclaude__web_terminal_attach', makeCtx({ input: { shellId: 'sh_1' } }))
    const d = dispatchToolCase('mcp__rclaude__web_terminal_detach', makeCtx({ input: { shellId: 'sh_1' } }))
    expect(markup(a.summary)).toContain('attach')
    expect(markup(d.summary)).toContain('detach')
  })
})

describe('visibleBytes', () => {
  it('maps newline, tab, escape and Ctrl-C to readable glyphs', () => {
    expect(visibleBytes('a\nb\tc')).toBe('a⏎b⇥c')
    expect(visibleBytes('\x03')).toBe('^C')
    expect(visibleBytes('\x1b[A')).toBe('ESC[A')
    expect(visibleBytes('\x7f')).toBe('^?')
  })

  it('leaves printable text alone', () => {
    expect(visibleBytes('bun run test')).toBe('bun run test')
  })
})

describe('shortToolLabel', () => {
  it('shortens the remote-control family', () => {
    expect(shortToolLabel('mcp__rclaude__web_execute_script')).toBe('web/script')
    expect(shortToolLabel('mcp__rclaude__web_terminal_read')).toBe('term/read')
  })

  it('keeps the existing behaviour for other tools', () => {
    expect(shortToolLabel('Bash')).toBe('Bash')
    expect(shortToolLabel('mcp__gmail__search_emails')).toBe('search_emails')
    expect(shortToolLabel('mcp__rclaude__notify')).toBe('notify')
  })
})
