/**
 * Card `node-stats-reporter-credential`, "Done means" line 1 + scope item 4:
 * ONE capability (`can_report_node_stats`), enforced by a predicate in ONE
 * place, and the router accepts exactly one message type from a reporter and
 * rejects everything else WITH A LOGGED REASON.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NODE_STATS_MESSAGE } from '../shared/node-stats'
import {
  type CapabilityRole,
  canAuthenticateHttpRoutes,
  canHostSpawns,
  canReportNodeStats,
  connectionMaySendMessage,
  restrictedMessageTypes,
} from './node-capability'

const ALL_ROLES: CapabilityRole[] = [
  'admin',
  'sentinel',
  'gateway',
  'reporter',
  'control-panel',
  'agent-host',
  'share',
  'none',
]

describe('reporter capability: exactly one', () => {
  it('a reporter can report node stats', () => {
    expect(canReportNodeStats('reporter')).toBe(true)
  })

  it('a reporter authenticates ZERO HTTP routes', () => {
    expect(canAuthenticateHttpRoutes('reporter')).toBe(false)
  })

  it('a reporter can NEVER host spawns', () => {
    expect(canHostSpawns('reporter')).toBe(false)
  })

  it('report_node_stats is the reporter role`s ONLY capability', () => {
    const held = [
      canReportNodeStats('reporter') && 'report_node_stats',
      canAuthenticateHttpRoutes('reporter') && 'authenticate_http',
      canHostSpawns('reporter') && 'host_spawns',
    ].filter(Boolean)
    expect(held).toEqual(['report_node_stats'])
  })

  it('a sentinel keeps all three -- the reporter is a LESSER rung, not a rename', () => {
    expect(canReportNodeStats('sentinel')).toBe(true)
    expect(canAuthenticateHttpRoutes('sentinel')).toBe(true)
    expect(canHostSpawns('sentinel')).toBe(true)
  })

  it('no OTHER role gains spawn authority by accident', () => {
    expect(ALL_ROLES.filter(canHostSpawns)).toEqual(['sentinel'])
  })

  it('an unauthenticated role holds nothing', () => {
    expect(canReportNodeStats('none')).toBe(false)
    expect(canAuthenticateHttpRoutes('none')).toBe(false)
    expect(canHostSpawns('none')).toBe(false)
  })
})

describe('reporter capability: the message allowlist', () => {
  it('a reporter may send exactly report_node_stats', () => {
    expect([...(restrictedMessageTypes('reporter') ?? [])]).toEqual([NODE_STATS_MESSAGE])
    expect(connectionMaySendMessage('reporter', NODE_STATS_MESSAGE)).toEqual({ ok: true })
  })

  it('every other message type is refused WITH A REASON', () => {
    const forbidden = [
      'sentinel_identify',
      'spawn_result',
      'heartbeat',
      'shell_open',
      'project_read_file',
      'channel_subscribe',
      'sentinel_usage_report',
      'meta',
      'transcript_request',
      'anything_at_all',
    ]
    for (const type of forbidden) {
      const verdict = connectionMaySendMessage('reporter', type)
      expect(verdict.ok).toBe(false)
      if (verdict.ok) continue
      expect(verdict.reason).toContain(type)
      expect(verdict.reason.length).toBeGreaterThan(10)
    }
  })

  it('non-reporter roles are NOT message-restricted here (the role gate still applies)', () => {
    for (const role of ALL_ROLES.filter(r => r !== 'reporter')) {
      expect(restrictedMessageTypes(role)).toBeUndefined()
      expect(connectionMaySendMessage(role, 'anything')).toEqual({ ok: true })
    }
  })
})

/**
 * The card's actual demand: "The check is a capability predicate, not an
 * `if (kind === 'reporter')` scattered across handlers -- one place to read, one
 * place to audit."
 *
 * So the lock is an ALLOWLIST, not a ban. Exactly three files in the broker may
 * branch on the reporter literal, each for a reason that is not an authorization
 * decision. A fourth one fails this test and forces a conscious call: is that a
 * capability check that belongs in the table?
 */
const MAY_BRANCH_ON_REPORTER: Record<string, string> = {
  'node-capability.ts': 'the capability table itself',
  'index.ts':
    'WS upgrade: turns the resolved auth role into a socket tag. Not an authz decision -- every authz decision downstream reads the table.',
  'handlers/node-stats.ts':
    'strips the sentinel-only block from a reporter FRAME. A payload-shape rule, not a permission.',
}

/** Strip comments so prose quoting the forbidden pattern cannot trip the scan. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('reporter capability: ONE place to read, ONE place to audit', () => {
  it('only the allowlisted files branch on the reporter literal', () => {
    const brokerDir = import.meta.dirname
    const offenders: string[] = []
    for (const rel of new Bun.Glob('**/*.ts').scanSync({ cwd: brokerDir, absolute: false })) {
      if (rel.endsWith('.test.ts')) continue
      // The registry legitimately STORES the kind; it grants nothing.
      if (rel.startsWith('sentinel-registry')) continue
      const source = codeOnly(readFileSync(join(brokerDir, rel), 'utf8'))
      const branches = /(?:kind|role)\s*===\s*['"]reporter['"]/.test(source)
      if (branches && !(rel in MAY_BRANCH_ON_REPORTER)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('every gate that grants something reads the predicate, never the literal', () => {
    // The three real gates: HTTP auth, HTTP grants, WS message routing.
    for (const rel of ['auth-routes.ts', 'routes/shared.ts', 'message-router.ts']) {
      const source = codeOnly(readFileSync(join(import.meta.dirname, rel), 'utf8'))
      expect(source).not.toMatch(/(?:kind|role)\s*===\s*['"]reporter['"]/)
      expect(source).toMatch(/canAuthenticateHttpRoutes|connectionMaySendMessage/)
    }
  })
})
