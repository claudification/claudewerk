/**
 * Project Order - persistent tree structure for the sidebar project list.
 *
 * Each leaf node represents a project keyed by its project URI
 * (e.g. `claude:///Users/jonas/projects/remote-claude`).
 * Legacy `cwd:<path>` node IDs are migrated on load.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cwdToProjectUri } from '../shared/project-uri'

export interface ProjectOrderGroup {
  id: string
  type: 'group'
  name: string
  children: ProjectOrderNode[]
  isOpen?: boolean
}

export interface ProjectOrderProject {
  id: string // project URI (e.g. claude:///path)
  type: 'project'
}

export type ProjectOrderNode = ProjectOrderGroup | ProjectOrderProject

export interface ProjectOrder {
  tree: ProjectOrderNode[]
}

let orderPath = ''
let order: ProjectOrder = { tree: [] }

/** Migrate a node ID from legacy `cwd:<path>` format to project URI. */
function migrateNodeId(id: string): string {
  if (id.startsWith('cwd:')) {
    return cwdToProjectUri(id.slice(4))
  }
  return id
}

/**
 * Normalize legacy in-memory shapes to the current format. Accepts:
 *   - Current: { tree: [...] } with node.type === 'project' | 'group'
 *   - Legacy v2: { version: 2, tree: [...] } with leaf node.type === 'session'
 *   - Legacy node IDs: `cwd:<path>` -> project URI
 * Anything else returns an empty tree.
 */
function normalize(raw: unknown): { order: ProjectOrder; migrated: boolean } {
  if (!raw || typeof raw !== 'object') return { order: { tree: [] }, migrated: false }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.tree)) return { order: { tree: [] }, migrated: false }

  let migrated = false

  function walk(nodes: unknown[]): ProjectOrderNode[] {
    const out: ProjectOrderNode[] = []
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue
      const node = n as Record<string, unknown>
      if (node.type === 'group' && typeof node.id === 'string' && typeof node.name === 'string') {
        const children = Array.isArray(node.children) ? walk(node.children) : []
        out.push({
          id: node.id,
          type: 'group',
          name: node.name,
          children,
          ...(typeof node.isOpen === 'boolean' ? { isOpen: node.isOpen } : {}),
        })
      } else if ((node.type === 'project' || node.type === 'session') && typeof node.id === 'string') {
        const newId = migrateNodeId(node.id)
        if (newId !== node.id) migrated = true
        out.push({ id: newId, type: 'project' })
      }
    }
    return out
  }

  return { order: { tree: walk(obj.tree) }, migrated }
}

export function initProjectOrder(cacheDir: string): void {
  orderPath = join(cacheDir, 'project-order.json')
  mkdirSync(dirname(orderPath), { recursive: true })

  // One-shot migration from the legacy filename.
  if (!existsSync(orderPath)) {
    const legacyPath = join(cacheDir, 'session-order.json')
    if (existsSync(legacyPath)) {
      try {
        renameSync(legacyPath, orderPath)
        console.log('[project-order] Migrated session-order.json -> project-order.json')
      } catch (err) {
        console.warn('[project-order] Legacy rename failed:', err)
      }
    }
  }

  if (existsSync(orderPath)) {
    try {
      const raw = JSON.parse(readFileSync(orderPath, 'utf-8'))
      const wasLegacyFormat =
        (raw && typeof raw === 'object' && 'version' in raw) ||
        JSON.stringify(raw?.tree ?? []).includes('"type":"session"')

      const { order: normalized, migrated: hadCwdIds } = normalize(raw)
      order = normalized

      if (wasLegacyFormat || hadCwdIds) save()
    } catch {
      order = { tree: [] }
    }
  }
}

function save(): void {
  if (!orderPath) return
  writeFileSync(orderPath, JSON.stringify(order, null, 2))
}

export function getProjectOrder(): ProjectOrder {
  return order
}

export function setProjectOrder(update: ProjectOrder): void {
  if (!update || !Array.isArray(update.tree)) return
  const { order: normalized } = normalize(update)
  order = normalized
  save()
}

/** Extract all project URIs from a subtree. */
export function getAllTreeProjects(nodes: ProjectOrderNode[] = order.tree): Set<string> {
  const uris = new Set<string>()
  for (const node of nodes) {
    if (node.type === 'project') {
      const uri = node.id.startsWith('cwd:') ? cwdToProjectUri(node.id.slice(4)) : node.id
      uris.add(uri)
    } else {
      for (const u of getAllTreeProjects(node.children)) uris.add(u)
    }
  }
  return uris
}

/** @deprecated Use getAllTreeProjects() instead. */
export function getAllTreeCwds(nodes: ProjectOrderNode[] = order.tree): Set<string> {
  return getAllTreeProjects(nodes)
}
