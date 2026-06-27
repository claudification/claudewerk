/**
 * MCP catalog parity gate.
 *
 * Introspects BOTH binding sites' actual registered tool sets and asserts they
 * agree with the canonical catalog. Adding a tool to one site without accounting
 * for it in the catalog (and at the other site, or in DEFERRED_BINDINGS) fails
 * the build. This is the structural guarantee from plan-mcp-toolset-unification.md:
 * the gate that would have caught `web_*` reaching the broker but not the host.
 *
 * Both servers register their tools synchronously at construction without
 * touching their store/ctx, so empty stubs are enough to read the bound names.
 */

import { describe, expect, test } from 'bun:test'
import { registerAllTools } from '../../agent-host-common/mcp-host/mcp-tools'
import { createMcpServer } from '../../broker/routes/mcp-server'
import { CATALOG_NAMES, DEFERRED_BINDINGS, MCP_CATALOG, type McpSite } from './catalog'

const SITES = ['broker', 'host'] as const

const hostBound = new Set(
  Object.entries(registerAllTools({} as any))
    .filter(([, def]) => !def.hidden)
    .map(([name]) => name),
)
const brokerServer = createMcpServer({} as any, {} as any) as any
// _registeredTools is the MCP SDK's private registry; the server exposes no public
// tool enumeration. The SDK is version-pinned, so a rename failing this test loudly
// is the intended signal, not a silent gap.
const brokerBound = new Set<string>(Object.keys(brokerServer._registeredTools))

const boundBySite: Record<McpSite, ReadonlySet<string>> = { broker: brokerBound, host: hostBound }
const deferredBySite: Record<McpSite, ReadonlySet<string>> = {
  broker: new Set(DEFERRED_BINDINGS.filter(d => d.site === 'broker').map(d => d.name)),
  host: new Set(DEFERRED_BINDINGS.filter(d => d.site === 'host').map(d => d.name)),
}

describe('mcp catalog parity', () => {
  test('catalog has no duplicate tool names', () => {
    expect(MCP_CATALOG.length).toBe(CATALOG_NAMES.size)
  })

  test('every bound tool exists in the catalog (no uncatalogued tools)', () => {
    const uncatalogued: string[] = []
    for (const site of SITES) {
      for (const name of boundBySite[site]) if (!CATALOG_NAMES.has(name)) uncatalogued.push(`${site}:${name}`)
    }
    expect(uncatalogued).toEqual([])
  })

  test('every bound tool is bound at a site listed in its catalog entry', () => {
    const misplaced: string[] = []
    for (const site of SITES) {
      for (const name of boundBySite[site]) {
        const entry = MCP_CATALOG.find(t => t.name === name)
        if (entry && !entry.sites.includes(site)) misplaced.push(`${site}:${name}`)
      }
    }
    expect(misplaced).toEqual([])
  })

  test('each site binds or explicitly defers every tool intended for it', () => {
    const gaps: string[] = []
    for (const site of SITES) {
      for (const tool of MCP_CATALOG) {
        if (!tool.sites.includes(site)) continue
        if (!boundBySite[site].has(tool.name) && !deferredBySite[site].has(tool.name)) {
          gaps.push(`${site}:${tool.name} (intended but neither bound nor deferred)`)
        }
      }
    }
    expect(gaps).toEqual([])
  })

  test('no tool is both bound and deferred at the same site', () => {
    const conflicts: string[] = []
    for (const site of SITES) {
      for (const name of deferredBySite[site]) if (boundBySite[site].has(name)) conflicts.push(`${site}:${name}`)
    }
    expect(conflicts).toEqual([])
  })

  test('every deferred binding is a real gap (intended at site, not yet bound)', () => {
    const stale: string[] = []
    for (const d of DEFERRED_BINDINGS) {
      const entry = MCP_CATALOG.find(t => t.name === d.name)
      if (!entry?.sites.includes(d.site)) stale.push(`${d.site}:${d.name} (not catalogued/intended for site)`)
      else if (boundBySite[d.site].has(d.name)) stale.push(`${d.site}:${d.name} (already bound -- drop the defer)`)
    }
    expect(stale).toEqual([])
  })
})
