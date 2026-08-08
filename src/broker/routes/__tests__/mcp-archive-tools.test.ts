import { expect, test } from 'bun:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerArchiveTools } from '../mcp-archive-tools'

function registered(): Record<string, { description?: string }> {
  const mcp = new McpServer({ name: 'test', version: '0' }, { capabilities: { tools: {} } })
  registerArchiveTools(mcp)
  return (mcp as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools
}

test('both cold-archive tools register', () => {
  expect(Object.keys(registered()).sort()).toEqual(['archive_search_plan', 'search_archives'])
})

// The description IS the safety mechanism. An agent chooses between the indexed
// hot search and this unindexed scan on these words alone, so the cost warning
// and the "try search_transcripts first" instruction are load-bearing, not prose.
test('search_archives leads with its cost and names the cheap alternative', () => {
  const description = registered().search_archives.description ?? ''
  expect(description).toContain('SLOW')
  expect(description).toContain('EXPENSIVE')
  expect(description).toContain('NO INDEX')
  expect(description).toContain('search_transcripts FIRST')
  expect(description).toContain('archive_search_plan')
  expect(description).toContain('truncated')
})

test('archive_search_plan says it decompresses nothing', () => {
  const description = registered().archive_search_plan.description ?? ''
  expect(description).toContain('WITHOUT running it')
  expect(description).toContain('decompresses nothing')
})
