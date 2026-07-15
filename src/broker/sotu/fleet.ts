/**
 * SOTU fleet rollup (Phase 6) -- ENRICHES the existing Sheaf fleet view; it does
 * NOT build a parallel panel. Sheaf already renders the structural fleet (per-
 * project sections, spawn forest, cost/token rollups); this folds SOTU's
 * narrative + git-fabric INTO that structure:
 *
 *   - per project: the distilled narrative (paid, opt-in), the free floor (git
 *     escalation alerts + CONTENDED count), the per-branch/worktree merge-risk,
 *     and the citation-grounding metric;
 *   - the formerly-dead `commits` column is finished from the git-fabric scan
 *     (ahead-of-origin commits per worktree branch -- SOTU Phase 2 IS the git
 *     attribution Sheaf's "phase 3" never built);
 *   - a cheap, zero-LLM FLEET UNION across the projects the viewer can see.
 *
 * PERMISSION COVENANT (OPEN ITEM #2, a HARD gate): the fleet aggregate crosses
 * projects, so a viewer with access to project A must NEVER see project B's
 * chronicle bleed through. `canViewProject` is applied server-side BEFORE any
 * SOTU data is attached: a project the viewer cannot see gets NO `sotu` block and
 * is excluded from the union (and counted in `filteredProjects`, never silently
 * dropped). The structural Sheaf grid keeps its own (admin) gate at the route.
 */

import type { GitAlert, GitFabric } from '../../shared/protocol'
import type {
  SheafFleetSotu,
  SheafGrounding,
  SheafNode,
  SheafProject,
  SheafProjectSotu,
  SheafResponse,
} from '../../shared/sheaf-types'
import { detectWorktreeName } from '../../shared/worktree-detect'
import { readChronicle } from './chronicle'
import { defaultResolveSotuConfig, type ResolveSotuConfig } from './config'
import { buildFleetUnion } from './fleet-union'
import { scoreGrounding } from './grounding'
import { projectSlug } from './paths'
import { readLiveQueue } from './queue'
import { sharpenAlerts } from './sharpen'
import type { Contribution } from './types'
import { deriveHolds } from './view'

/** Cap the narrative folded into the fleet grid -- it is a glance surface, the
 *  full chronicle lives behind `GET /api/sotu` / the dispatcher. */
const FLEET_NARRATIVE_MAX = 600

export interface EnrichSheafOpts {
  /** Per-project visibility predicate (the permission covenant). Returns true iff
   *  this viewer may see the project's SOTU. Derived from the caller's grants at
   *  the route -- NEVER hardcoded true. */
  canViewProject: (projectUri: string) => boolean
  /** Resolve per-project opt-in (defaults to ProjectSettings). */
  resolveConfig?: ResolveSotuConfig
  /** Override "now" (tests inject); defaults to Date.now(). */
  now?: number
}

/** The latest git-fabric snapshot for a project: the reconcile-folded one on the
 *  chronicle, else the most recent git_scan still live in the queue. */
function latestFabric(chronicle: GitFabric | undefined, live: Contribution[]): GitFabric | undefined {
  if (chronicle) return chronicle
  let best: GitFabric | undefined
  for (const c of live) if (c.kind === 'git_scan') best = c.git
  return best
}

/** Map worktree-name -> ahead-of-origin commit count from the fabric. Only
 *  branches that ARE checked out in a worktree attribute to a node (a branch with
 *  no worktree lives nowhere a conversation runs). Max on collision (defensive). */
function worktreeCommitMap(fabric: GitFabric | undefined): Map<string | null, number> {
  const m = new Map<string | null, number>()
  if (!fabric) return m
  for (const b of fabric.branches) {
    if (!b.worktree) continue
    const name = detectWorktreeName(b.worktree)
    const prev = m.get(name)
    if (prev === undefined || b.aheadOrigin > prev) m.set(name, b.aheadOrigin)
  }
  return m
}

/** Fill the (formerly dead) commits column on every node in a forest, in place. */
function fillCommits(nodes: SheafNode[], byWorktree: Map<string | null, number>): void {
  for (const node of nodes) {
    node.commits = byWorktree.get(node.worktreeName) ?? 0
    if (node.children.length) fillCommits(node.children, byWorktree)
  }
}

/** Worktree names (null = main checkout) holding a LIVE conversation -- running
 *  or idle, i.e. still attached and able to act. Feeds the liveness sharpening. */
function liveWorktreeNames(nodes: SheafNode[], out = new Set<string | null>()): Set<string | null> {
  for (const node of nodes) {
    if (node.status === 'running' || node.status === 'idle') out.add(node.worktreeName)
    if (node.children.length) liveWorktreeNames(node.children, out)
  }
  return out
}

/** Assemble one project's SOTU block from its chronicle + live queue (zero LLM:
 *  reads what the distill/scan already produced). Also fills the commits column. */
function buildProjectSotu(project: SheafProject, resolveConfig: ResolveSotuConfig, now: number): SheafProjectSotu {
  const slug = projectSlug(project.projectUri)
  const chronicle = readChronicle(slug)
  const live = readLiveQueue(slug, now)
  const fabric = latestFabric(chronicle.git, live)
  const enabled = resolveConfig(project.projectUri).enabled

  fillCommits(project.forest, worktreeCommitMap(fabric))

  const sotu: SheafProjectSotu = {
    enabled,
    alerts: sharpenAlerts(fabric, liveWorktreeNames(project.forest)),
    contended: deriveHolds(live).filter(h => h.contended).length,
    branches: fabric?.branches ?? [],
  }
  const narrative = chronicle.narrative.trim()
  if (enabled && narrative) {
    sotu.narrative = narrative.slice(0, FLEET_NARRATIVE_MAX)
    sotu.generatedAt = chronicle.generatedAt
  }
  if (fabric?.fetchedAt !== undefined) sotu.fetchedAt = fabric.fetchedAt
  if (fabric) sotu.scannedAt = fabric.scannedAt
  // Grounding is only meaningful once a distill has actually run.
  if (chronicle.generatedAt > 0) sotu.grounding = scoreGrounding(chronicle, live)
  return sotu
}

/**
 * Enrich a built Sheaf response with SOTU (per-project + fleet union), in place,
 * respecting the per-project visibility filter. Returns the same object for
 * chaining. Never throws on a single project (a torn store degrades that project
 * to no SOTU block, not the whole fleet).
 */
export function enrichSheafWithSotu(sheaf: SheafResponse, opts: EnrichSheafOpts): SheafResponse {
  const resolveConfig = opts.resolveConfig ?? defaultResolveSotuConfig
  const now = opts.now ?? Date.now()
  const visibleBlocks: SheafProjectSotu[] = []
  let filteredProjects = 0
  for (const project of sheaf.projects) {
    if (!opts.canViewProject(project.projectUri)) {
      filteredProjects++
      continue // NO sotu block -> the chronicle cannot bleed to this viewer
    }
    try {
      const sotu = buildProjectSotu(project, resolveConfig, now)
      project.sotu = sotu
      visibleBlocks.push(sotu)
    } catch {
      // SOTU store unreadable for this project -- leave it structural-only.
    }
  }
  sheaf.sotu = buildFleetUnion(visibleBlocks, filteredProjects)
  return sheaf
}
