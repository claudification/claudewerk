/**
 * Project-order normalization -- every shape that has ever been persisted gets
 * folded into the current one here. Pure functions only; the store (persistence,
 * per-user rows) lives in project-order.ts.
 *
 * Accepted inputs:
 *   - Current: { tree, workspaces?, workspaceTrees? }
 *   - Legacy v2: { version: 2, tree } with leaf node.type === 'session'
 *   - Legacy node IDs: `cwd:<path>` -> project URI
 *   - Legacy workspace membership: flat `assignments` -> `workspaceTrees`
 * Anything else normalizes to an empty tree.
 */

import type { ProjectOrder, ProjectOrderNode, Workspace } from '../shared/project-order-types'
import { cwdToProjectUri, projectIdentityKey } from '../shared/project-uri'

/** Migrate a node ID from legacy `cwd:<path>` format to a canonical project URI.
 *  Also collapses profile userinfo, empty authority, quad-slash scars, and
 *  conversation fragments so sibling tree entries that name the same project
 *  dedupe into one node. */
function migrateNodeId(id: string): string {
  const upgraded = id.startsWith('cwd:') ? cwdToProjectUri(id.slice(4)) : id
  return projectIdentityKey(upgraded)
}

// Guard-heavy input validator: cyclomatic is driven entirely by inherent type
// guards (cognitively trivial). Kept as one readable function.
// fallow-ignore-next-line complexity
function sanitizeWorkspaces(raw: unknown): Workspace[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Workspace[] = []
  const seen = new Set<string>()
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue
    const o = w as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.name !== 'string' || seen.has(o.id)) continue
    seen.add(o.id)
    out.push({ id: o.id, name: o.name, ...(typeof o.color === 'string' ? { color: o.color } : {}) })
  }
  return out.length > 0 ? out : undefined
}

/** Sanitize per-workspace trees. Only keeps entries for valid workspace ids. */
function sanitizeWorkspaceTrees(
  raw: unknown,
  validWs: Set<string>,
  walkFn: (nodes: unknown[]) => ProjectOrderNode[],
): Record<string, ProjectOrderNode[]> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, ProjectOrderNode[]> = {}
  for (const [wsId, tree] of Object.entries(raw as Record<string, unknown>)) {
    if (!validWs.has(wsId) || !Array.isArray(tree)) continue
    const walked = walkFn(tree)
    if (walked.length > 0) out[wsId] = walked
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Migrate legacy assignments to workspaceTrees. For each assignment, find
 *  the root node in the global tree and copy it into the workspace tree. */
function migrateAssignments(
  assignments: Record<string, string>,
  globalTree: ProjectOrderNode[],
): Record<string, ProjectOrderNode[]> {
  const trees: Record<string, ProjectOrderNode[]> = {}
  for (const [nodeId, wsId] of Object.entries(assignments)) {
    const node = globalTree.find(n => n.id === nodeId)
    if (!node) continue
    const list = trees[wsId] ?? []
    list.push(structuredClone(node))
    trees[wsId] = list
  }
  return trees
}

/** True when the raw row predates the current tree format and must be re-saved. */
export function isLegacyFormat(raw: Record<string, unknown>): boolean {
  return 'version' in raw || JSON.stringify((raw as { tree?: unknown }).tree ?? []).includes('"type":"session"')
}

/** Set when a node had to be rewritten, so the caller knows to re-save the row. */
interface WalkState {
  migrated: boolean
}

function buildGroup(node: Record<string, unknown>, state: WalkState): ProjectOrderNode | null {
  if (typeof node.id !== 'string' || typeof node.name !== 'string') return null
  return {
    id: node.id,
    type: 'group',
    name: node.name,
    children: Array.isArray(node.children) ? walkNodes(node.children, state) : [],
    ...(typeof node.isOpen === 'boolean' ? { isOpen: node.isOpen } : {}),
  }
}

/** `seen` dedupes project IDs within ONE level -- profile-collapsed siblings
 *  would otherwise produce duplicate keys that dnd-kit chokes on. */
function buildProject(node: Record<string, unknown>, seen: Set<string>, state: WalkState): ProjectOrderNode | null {
  if (node.type !== 'project' && node.type !== 'session') return null
  if (typeof node.id !== 'string') return null
  const id = migrateNodeId(node.id)
  if (id !== node.id) state.migrated = true
  if (seen.has(id)) {
    state.migrated = true
    return null
  }
  seen.add(id)
  return { id, type: 'project' }
}

function walkNodes(nodes: unknown[], state: WalkState): ProjectOrderNode[] {
  const out: ProjectOrderNode[] = []
  const seenProjects = new Set<string>()
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const node = n as Record<string, unknown>
    const built = node.type === 'group' ? buildGroup(node, state) : buildProject(node, seenProjects, state)
    if (built) out.push(built)
  }
  return out
}

/** Current `workspaceTrees` if present, else the flat `assignments` map upgraded
 *  into one (and the row flagged for re-save). */
function resolveWorkspaceTrees(
  obj: Record<string, unknown>,
  validWsIds: Set<string>,
  walk: (nodes: unknown[]) => ProjectOrderNode[],
  globalTree: ProjectOrderNode[],
  state: WalkState,
): Record<string, ProjectOrderNode[]> | undefined {
  const current = sanitizeWorkspaceTrees(obj.workspaceTrees, validWsIds, walk)
  if (current) return current
  if (!obj.assignments || typeof obj.assignments !== 'object') return undefined

  const legacy: Record<string, string> = {}
  for (const [nodeId, wsId] of Object.entries(obj.assignments as Record<string, unknown>)) {
    if (typeof wsId === 'string' && validWsIds.has(wsId)) legacy[nodeId] = wsId
  }
  if (Object.keys(legacy).length === 0) return undefined

  state.migrated = true
  return migrateAssignments(legacy, globalTree)
}

export function normalize(raw: unknown): { order: ProjectOrder; migrated: boolean } {
  if (!raw || typeof raw !== 'object') return { order: { tree: [] }, migrated: false }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.tree)) return { order: { tree: [] }, migrated: false }

  const state: WalkState = { migrated: false }
  const walk = (nodes: unknown[]) => walkNodes(nodes, state)

  const globalTree = walk(obj.tree)
  const workspaces = sanitizeWorkspaces(obj.workspaces)
  const validWsIds = new Set((workspaces ?? []).map(w => w.id))
  const workspaceTrees = resolveWorkspaceTrees(obj, validWsIds, walk, globalTree, state)

  return {
    order: {
      tree: globalTree,
      ...(workspaces ? { workspaces } : {}),
      ...(workspaceTrees ? { workspaceTrees } : {}),
    },
    migrated: state.migrated,
  }
}
