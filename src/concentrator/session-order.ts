/**
 * Session Order - persistent tree structure for sidebar organization
 * Stored as a versioned JSON file in the concentrator cache dir.
 *
 * v1: flat array with implicit groups (legacy)
 * v2: explicit tree with group nodes and session leaves
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Tree node types
export interface SessionOrderGroup {
  id: string
  type: 'group'
  name: string
  children: SessionOrderNode[]
  isOpen?: boolean
}

export interface SessionOrderSession {
  id: string // "cwd:<path>" format
  type: 'session'
}

export type SessionOrderNode = SessionOrderGroup | SessionOrderSession

export interface SessionOrderV2 {
  version: 2
  tree: SessionOrderNode[]
}

// Legacy v1 format (for migration)
interface SessionOrderV1 {
  organized: Array<{ cwd: string; group?: string }>
}

let orderPath = ''
let order: SessionOrderV2 = { version: 2, tree: [] }

function migrateV1toV2(v1: SessionOrderV1): SessionOrderV2 {
  const groups = new Map<string, SessionOrderGroup>()
  const rootNodes: SessionOrderNode[] = []

  for (const entry of v1.organized) {
    const sessionNode: SessionOrderSession = { id: `cwd:${entry.cwd}`, type: 'session' }

    if (entry.group) {
      let group = groups.get(entry.group)
      if (!group) {
        group = {
          id: `group-${entry.group.toLowerCase().replace(/\s+/g, '-')}`,
          type: 'group',
          name: entry.group,
          children: [],
          isOpen: true,
        }
        groups.set(entry.group, group)
        rootNodes.push(group)
      }
      group.children.push(sessionNode)
    } else {
      rootNodes.push(sessionNode)
    }
  }

  return { version: 2, tree: rootNodes }
}

function parseFromDisk(raw: unknown): SessionOrderV2 {
  if (!raw || typeof raw !== 'object') return { version: 2, tree: [] }
  const obj = raw as Record<string, unknown>

  // v2 format
  if (obj.version === 2 && Array.isArray(obj.tree)) {
    return { version: 2, tree: obj.tree as SessionOrderNode[] }
  }

  // v1 format (legacy migration)
  if (Array.isArray(obj.organized)) {
    const v2 = migrateV1toV2(obj as unknown as SessionOrderV1)
    console.log(`[session-order] Migrated v1 -> v2 (${obj.organized.length} entries -> ${v2.tree.length} nodes)`)
    return v2
  }

  return { version: 2, tree: [] }
}

export function initSessionOrder(cacheDir: string): void {
  orderPath = join(cacheDir, 'session-order.json')
  mkdirSync(dirname(orderPath), { recursive: true })

  if (existsSync(orderPath)) {
    try {
      const raw = JSON.parse(readFileSync(orderPath, 'utf-8'))
      order = parseFromDisk(raw)
      // Save back if we migrated
      if (!raw.version) save()
    } catch {
      order = { version: 2, tree: [] }
    }
  }
}

function save(): void {
  if (!orderPath) return
  writeFileSync(orderPath, JSON.stringify(order, null, 2))
}

export function getSessionOrder(): SessionOrderV2 {
  return order
}

export function setSessionOrder(update: SessionOrderV2): void {
  if (update.version !== 2 || !Array.isArray(update.tree)) return
  order = { version: 2, tree: update.tree }
  save()
}

// Helper: extract all CWDs from the tree (for quick membership checks)
export function getAllTreeCwds(nodes: SessionOrderNode[] = order.tree): Set<string> {
  const cwds = new Set<string>()
  for (const node of nodes) {
    if (node.type === 'session') {
      const cwd = node.id.startsWith('cwd:') ? node.id.slice(4) : node.id
      cwds.add(cwd)
    } else if (node.type === 'group') {
      for (const c of getAllTreeCwds(node.children)) cwds.add(c)
    }
  }
  return cwds
}
