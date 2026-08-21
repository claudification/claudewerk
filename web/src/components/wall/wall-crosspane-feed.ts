/**
 * THE CROSS-PANE FIXTURE -- one dataset, thirteen panes, two projects.
 *
 * `wall-feed-stubs.ts` answers every wall feed with the thinnest legal body,
 * which is exactly right for the resilience suite: it only cares that a request
 * WAS made. The filter proof needs the opposite -- every pane holding ROWS, from
 * TWO projects, so that `@remote-claude` has something to keep and something to
 * drop on each of them. An empty pane proves nothing about a filter.
 *
 * So this file seeds the same wall through its REAL seams: the HTTP feeds behind
 * A2/P2/A4/A6, one `wall_frame` for S1/S2/P4/P3, the conversation registry for
 * P1/A5/A1/A7, and the two module stores behind A7 and A8. Nothing here mocks a
 * pane, a filter or a count -- the panes fold their own rows out of this, which
 * is what makes the proof a proof.
 *
 * It is data only. The two module-boundary mocks the rig needs (`sendBoardOp`
 * for A8's board op, `epic-inspect-api` for A7's per-row inspect) are `vi.mock`
 * calls and must be hoisted in the suite itself.
 */

import type { CommitRow } from '@shared/commit-ledger'
import { MARKER, type PinnedEpicRow } from '@shared/pinned-epic-rows'
import type { CardMove, EpicActivityEntry } from '@shared/protocol'
import type { WallFrame } from '@shared/wall'
import { vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useOverseerActivityStore } from '@/hooks/use-overseer-activity'
import { applyWallFrame } from '@/hooks/wall-frame-store'
import type { Conversation } from '@/lib/types'
import { activityMatrixFixture } from './activity-fixture'

/**
 * The clock every age in the fixture is measured against.
 *
 * EXPORTED for the time-cursor proof, which has to pin `Date.now()` to it. Every
 * row here is dated relative to this instant, so a suite measuring ages against
 * the real clock gets ages in YEARS -- under which every row is older than every
 * offset, the rewind narrows nothing, and the proof passes by doing nothing.
 */
export const NOW = 1_700_000_000_000

/** Two projects, one segment each so the display name IS the token a `@chip`
 *  writes into the box. */
const RC = 'claude://default/Users/j/remote-claude'
const ANVIL = 'claude://default/Users/j/anvil-md'
export const RC_NAME = 'remote-claude'
export const ANVIL_NAME = 'anvil-md'

/** What the sentinel calls the box each project's work runs on -- the `&host`
 *  axis needs two values as much as `@project` does. */
const RC_HOST = 'studio'
const ANVIL_HOST = 'thai'

/**
 * THE WORKSPACE SPLIT, and it is deliberately lopsided.
 *
 * RC sits in BOTH workspaces and ANVIL in NEITHER, which is the pair the
 * `^workspace` axis has to get right: membership is many-to-many, so a project
 * has to answer to every workspace holding it, and "in no workspace" has to be a
 * real answer rather than a wildcard. A one-project-one-workspace fixture would
 * pass with either rule.
 */
export const ENG_WS = 'Engineering'
export const CLIENT_WS = 'Client Work'

function projectOrder(): unknown {
  return {
    tree: [
      { id: RC, type: 'project' },
      { id: ANVIL, type: 'project' },
    ],
    workspaces: [
      { id: 'ws-eng', name: ENG_WS },
      { id: 'ws-client', name: CLIENT_WS },
    ],
    workspaceTrees: {
      // RC is reached through a GROUP in one of them, flat in the other: a
      // project buried in a group is still in the workspace.
      'ws-eng': [{ id: 'grp-shipped', type: 'group', name: 'shipped', children: [{ id: RC, type: 'project' }] }],
      'ws-client': [{ id: RC, type: 'project' }],
    },
  }
}

function conversation(id: string, project: string, host: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    project,
    status: 'active',
    title: `${id} on ${project}`,
    lastActivity: NOW - 60_000,
    hostSentinelAlias: host,
    model: 'opus',
    autocompactPct: 20,
    ...over,
  } as unknown as Conversation
}

function permission(conversationId: string) {
  return {
    conversationId,
    requestId: `req_${conversationId}`,
    toolName: 'Bash',
    description: 'run a command',
    inputPreview: '',
    timestamp: NOW - 120_000,
  }
}

function commit(hash: string, repoUri: string, repoName: string, host: string, subject: string): CommitRow {
  return {
    id: 1,
    hash,
    shortHash: hash.slice(0, 7),
    parentHashes: '',
    repoUri,
    cwdUri: repoUri,
    repoName,
    branch: 'main',
    isWorktree: false,
    conversationId: null,
    conversationName: null,
    sentinel: host,
    profile: null,
    host,
    container: '',
    osUser: 'j',
    authorName: 'Jonas Frost',
    authorEmail: 'j@example.com',
    subject,
    body: '',
    files: [],
    fileCount: 1,
    filesTruncated: false,
    insertions: 4,
    deletions: 1,
    kind: 'normal',
    ccType: null,
    ccScope: null,
    ccBreaking: false,
    origin: 'agent',
    supersededBy: null,
    committedAt: NOW - 300_000,
    ingestedAt: NOW - 300_000,
  }
}

function sheafProject(uri: string, label: string, cost: number, narrative: string): unknown {
  return {
    projectUri: uri,
    label,
    worktrees: [],
    forest: [{ children: [] }],
    totals: { tokens: { input: 1_000, output: 100, cache: 0 }, cost: { amount: cost, estimated: false } },
    sotu: { enabled: true, narrative, generatedAt: NOW - 600_000, alerts: [], contended: 0, branches: [] },
  }
}

/** The fleet union, carrying the STATE-OF-THE-UNION ROSTER A4 renders. Both
 *  fixture projects are chronicle-enabled, so both get a row -- the scoping of a
 *  chronicle-OFF project is the broker's job and is proved at `fleet.test.ts`. */
function sotuUnion(): unknown {
  const row = (uri: string, narrative: string) => ({
    projectUri: uri,
    narrative,
    generatedAt: NOW - 600_000,
    alerts: [],
    contended: 0,
    unmerged: 0,
  })
  return {
    projectsEnabled: 2,
    projectsWithNarrative: 2,
    alerts: [],
    contended: 0,
    atRiskProjects: 0,
    unpushedProjects: 0,
    stalledProjects: 0,
    unmergedProjects: 0,
    filteredProjects: 0,
    blocks: [row(RC, 'the wall grew a filter bus'), row(ANVIL, 'the spec site learned to end in a slash')],
  }
}

/**
 * An hour bucket inside today, so `costSince(localMidnight)` sees the spend.
 *
 * READ AT CALL TIME, and off the LIVE clock rather than off `NOW` -- the one
 * fixture row that is not `NOW`-relative. A2's window is measured against the
 * wall clock (`period-store`, `burnHourlyFrom`), so a bucket pinned to a 2023
 * constant falls outside every period the pane can select and the split renders
 * empty in any suite that does not pin `Date.now()`. The time-cursor proof, which
 * DOES pin it to `NOW`, gets exactly the old behaviour from this line: there,
 * `Date.now()` IS `NOW`.
 */
function thisHour(): string {
  const d = new Date(Date.now())
  d.setMinutes(0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function bodyFor(url: string): unknown {
  // A9's axis, dated against the fixture's own NOW like every other row here.
  if (url.includes('/api/stats/activity-matrix')) return activityMatrixFixture(NOW)
  if (url.includes('/api/stats/hourly')) {
    return [
      { hour: thisHour(), projectUri: RC, costUsd: 12 },
      { hour: thisHour(), projectUri: ANVIL, costUsd: 4 },
    ]
  }
  if (url.includes('/api/stats/openrouter')) return { byFeature: [{ key: 'recap', costUsd: 3 }] }
  if (url.includes('/api/stats/summary')) return { totalCostUsd: 1_500 }
  if (url.includes('/api/stats/tokens')) return { buckets: [] }
  if (url.includes('/api/commits/feed')) {
    return {
      commits: [
        commit('aaaaaaaaaaaa', RC, RC_NAME, RC_HOST, 'feat(wall): the cross-pane proof'),
        commit('bbbbbbbbbbbb', ANVIL, ANVIL_NAME, ANVIL_HOST, 'fix(md): trailing slash on every link'),
      ],
      conversations: [],
      projects: [],
      cursor: null,
      hasMore: false,
    }
  }
  if (url.includes('/api/sheaf')) {
    return {
      windowH: 24,
      windowStart: NOW - 86_400_000,
      windowEnd: NOW,
      generatedAt: NOW,
      totals: {
        projects: 2,
        conversations: 2,
        trees: 2,
        tokens: { input: 2_000, output: 200, cache: 0 },
        cost: { amount: 16, estimated: false },
      },
      projects: [
        sheafProject(RC, RC_NAME, 12, 'the wall grew a filter bus'),
        sheafProject(ANVIL, ANVIL_NAME, 4, 'the spec site learned to end in a slash'),
      ],
      sotu: sotuUnion(),
    }
  }
  return []
}

/** One `wall_frame` carrying every section the frame-fed panes read: S1 hosts,
 *  S2 plan samples, P4 counters, P3 card moves. */
function frame(): WallFrame {
  const cards: CardMove[] = [
    { id: 'wall-filter-bus', project: RC, title: 'the filter bus', from: 'open', to: 'done', ts: NOW - 120_000 },
    { id: 'md-anchor-links', project: ANVIL, title: 'anchor links', from: 'open', to: 'in-review', ts: NOW - 240_000 },
  ]
  return {
    type: 'wall_frame',
    seq: 1,
    at: NOW,
    full: true,
    coalesced: 4,
    cards,
    hosts: [
      { nodeId: 'n-studio', alias: RC_HOST, at: NOW, cpuPct: 42, memPct: 61, diskPct: 99, cores: 12, cpuHistory: [40] },
      { nodeId: 'n-thai', alias: ANVIL_HOST, at: NOW, cpuPct: 8, memPct: 30, diskPct: 40, cores: 8, cpuHistory: [8] },
    ],
    plan: [
      { profile: 'default', node: RC_HOST, utilization: 71, at: NOW, state: 'ok' },
      { profile: 'backup', node: ANVIL_HOST, utilization: 12, at: NOW, state: 'ok' },
    ],
    fleet: { conversations: 2, active: 2, idle: 0, blocked: 1, projects: 2, hosts: 2 },
  }
}

function epicRun(project: string, epicId: string): EpicActivityEntry {
  return {
    epicId,
    project,
    status: 'armed',
    gen: 3,
    maxGens: 40,
    inFlight: 1,
    overseerAlive: true,
    armed: true,
    lastBeatAt: new Date(NOW - 20_000).toISOString(),
    stale: false,
  }
}

function pin(project: string, epicId: string, epicTitle: string): PinnedEpicRow {
  return {
    project,
    epicId,
    epicTitle,
    done: 7,
    total: 17,
    pct: 41,
    children: [{ slug: `${epicId}-next`, title: `${epicId} next`, marker: MARKER.moving, lane: 'open', mtime: NOW }],
    cap: 5,
    hidden: 0,
    movedAt: NOW - 60_000,
  }
}

/** The pinned rows `sendBoardOp` must answer with. Exported so the suite's
 *  hoisted mock can serve them without duplicating the fixture. */
export function pinsFor(projectUri: string): PinnedEpicRow[] {
  return projectUri === RC ? [pin(RC, 'epic-the-wall-ii', 'THE WALL II')] : [pin(ANVIL, 'epic-spec-site', 'SPEC SITE')]
}

/** The epic rows `fetchActiveRuns` must answer with. */
export function activeRuns(): EpicActivityEntry[] {
  return [epicRun(RC, 'epic-the-wall-ii'), epicRun(ANVIL, 'epic-spec-site')]
}

/**
 * Seed every feed. Call BEFORE mounting: the HTTP stub has to be in place when
 * the panes fire their first request, and the frame is applied to a module store
 * that survives the mount either way.
 */
export function seedTheWall(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    return new Response(JSON.stringify(bodyFor(String(input))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })

  const rcConv = conversation('conv_rc', RC, RC_HOST, { title: 'wall filter cross-pane proof' })
  const anvilConv = conversation('conv_anvil', ANVIL, ANVIL_HOST, { title: 'spec site trailing slash' })
  // A third row that is NOT blocked. Both of the above hold a pending permission,
  // so without this one every band shorthand keeps the whole fleet and the `band`
  // axis could not be told apart from an axis nobody honours.
  const quietConv = conversation('conv_quiet', RC, RC_HOST, { title: 'quietly editing wall.css' })
  useConversationsStore.setState({
    conversationsById: { [rcConv.id]: rcConv, [anvilConv.id]: anvilConv, [quietConv.id]: quietConv },
    pendingPermissions: [permission('conv_rc'), permission('conv_anvil')],
    pendingProjectLinks: [],
    pendingAskQuestions: [],
    pendingDialogs: {},
    projectSettings: {},
    projectOrder: projectOrder(),
    connectSeq: 1,
  } as never)

  useOverseerActivityStore.setState({
    byProject: { [RC]: [epicRun(RC, 'epic-the-wall-ii')], [ANVIL]: [epicRun(ANVIL, 'epic-spec-site')] },
    primed: true,
  })

  applyWallFrame(frame())
}
