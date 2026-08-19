import type { Aspect } from './types'

/**
 * THE WALL, as promised, aspect by aspect.
 *
 * Two kinds of probe here, and the difference is deliberate:
 *
 *  - PANE FILES are pinned by the stub registry in `wall-surface-shell`, so the
 *    path is exact and a rename is a real failure worth reporting.
 *  - EVERYTHING ELSE is pinned by a CONTRACT SYMBOL named on the owning card.
 *    Where a name is otherwise free, the card names it and this file asserts it.
 *    Verification you can only do by guessing the implementer's naming is not
 *    verification.
 */

const PANES = 'web/src/components/wall/panes'
const WALL_DIR = 'web/src/components/wall'
const WALL = `${WALL_DIR}/**/*.{ts,tsx}`
/** The wall's non-React substrate -- stores, parsers, row builders. Panes are
 *  components; what they all agree ON is a library, and several cards put their
 *  contract symbol here rather than under `components/`. */
const LIB = 'web/src/lib/wall/**/*.ts'

export const ASPECTS: Aspect[] = [
  {
    code: 'SHELL',
    card: 'wall-surface-shell',
    promise: 'A managed surface that detaches into its own window, on a hard 3-column grid',
    artifacts: [
      { path: WALL, needle: 'useManagedModal', as: 'the surface is a MANAGED modal (covenant)' },
      { path: WALL, needle: 'WallPane', as: 'the shared WallPane chrome' },
    ],
    feeds: [{ path: 'web/src/hooks/modal-windows.ts', needle: 'openDetachedWindow' }],
    test: { path: `${WALL.replace('*.{ts,tsx}', '')}*.test.tsx`, as: 'a surface test' },
  },
  {
    code: 'W3',
    card: 'wall-surface-shell',
    promise: 'Ambient mode: fullscreen, no chrome, readable across a room',
    artifacts: [{ path: WALL, needle: 'ambient', as: 'ambient mode' }],
  },
  {
    code: 'CHANNEL',
    card: 'wall-live-channel',
    promise: 'ONE websocket channel feeding every pane, coalesced at ~2Hz',
    artifacts: [
      { path: 'src/shared/*.ts', needle: 'WALL_CHANNEL', as: 'the WALL_CHANNEL contract symbol' },
      { path: 'src/shared/protocol.ts', needle: 'WallFrame', as: 'the WallFrame wire type' },
    ],
    feeds: [{ path: 'web/src/hooks/use-websocket.ts', needle: 'channel_subscribe' }],
  },
  {
    code: 'P1',
    card: 'wall-pane-pulse',
    promise: 'Pulse: bands and tide, clickable rows, band vocabulary intact',
    artifacts: [{ path: `${PANES}/p1-pulse.tsx`, needle: 'PULSE_BAND_STYLE', as: 'the shared band palette' }],
    feeds: [{ path: 'web/src/components/pulse/use-pulse-fleet.ts' }],
  },
  {
    code: 'P2',
    card: 'wall-pane-commit-river',
    promise: 'Commit river: EVERY commit attributed to a project AND a conversation',
    artifacts: [
      { path: `${PANES}/p2-commit-river.tsx`, needle: 'project', as: 'per-commit project attribution' },
      // The implementer split the row out of the pane (SPLIT DISCIPLINE), so the
      // per-commit attribution renders here, not in the pane shell.
      { path: `${PANES}/commit-river-row.tsx`, needle: 'conversation', as: 'per-commit conversation attribution' },
    ],
    feeds: [{ path: 'web/src/components/commits/use-commit-subscription.ts' }],
  },
  {
    code: 'P3',
    card: 'wall-pane-card-ledger',
    promise: 'Card ledger: what moved on the board, chronological, epics excluded',
    artifacts: [{ path: `${PANES}/p3-card-ledger.tsx` }],
    feeds: [{ path: 'src/shared/protocol.ts', needle: 'CardMove', as: 'the card-move wire type' }],
    feedFrom: 'board-card-change-events',
  },
  {
    code: 'P4',
    card: 'wall-pane-fleet',
    promise: 'Fleet counters: tokens/min, tokens today, hosts up, WS round-trip',
    artifacts: [{ path: `${PANES}/p4-fleet.tsx` }],
    feeds: [{ path: 'web/src/hooks/token-flow-store.ts' }, { path: 'web/src/hooks/ws-stats.ts' }],
  },
  {
    code: 'A2',
    card: 'wall-pane-burn',
    promise: 'Burn clock: rate per hour, today, month, per project, and OpenRouter BY FEATURE',
    artifacts: [{ path: `${PANES}/a2-burn.tsx` }],
    feeds: [
      { path: 'src/broker/analytics-store.ts', needle: 'queryTimeSeries' },
      // The pane needs something it can QUERY, so the probe asks for the READER,
      // never the writer -- `recordOpenRouterSpend` existed all along as a
      // console.log (openrouter-client.ts:166) and a logger is not a feed.
      // Shipped as `querySpendRollup` in openrouter-spend-store.ts; this probe
      // guessed `queryOpenRouterSpend` and cried wolf until it was corrected.
      {
        path: 'src/broker/openrouter-spend-store.ts',
        needle: 'querySpendRollup',
        as: 'a QUERYABLE OpenRouter spend store',
      },
    ],
    feedFrom: 'wall-openrouter-spend-store',
  },
  {
    code: 'S1',
    card: 'wall-host-vitals',
    promise: 'Host vitals per sentinel: cpu, ram, disk, load, live sparkline',
    artifacts: [{ path: `${PANES}/s1-host-vitals.tsx` }],
    // The implementer named it `node-stats`, not the `report_node_stats` this
    // manifest first guessed -- and the contract-symbol table reached the epic
    // card AFTER that card was dispatched, so the guess was mine to lose. The
    // shipped name is the better one; the probe follows the code.
    feeds: [
      { path: 'src/shared/node-stats.ts', needle: 'NODE_STATS_INTERVAL_MS', as: 'the shared node-stats contract' },
    ],
    feedFrom: 'node-stats-contract',
  },
  {
    code: 'S2',
    card: 'wall-plan-usage-series',
    promise: 'Plan usage per profile and host, graphed over the 5h window',
    artifacts: [{ path: `${PANES}/s2-plan-usage.tsx` }],
    feeds: [{ path: 'src/shared/protocol.ts', needle: 'ProfileUsageSnapshot' }],
  },
  {
    code: 'A1',
    card: 'wall-pane-attention',
    promise: 'Blocked on you: hard and soft tiers, answerable without leaving the wall',
    artifacts: [{ path: `${PANES}/a1-attention.tsx` }],
    feeds: [{ path: 'web/src/components/pulse/use-attention-flags.ts' }],
  },
  {
    code: 'A4+A6',
    card: 'wall-pane-sheaf-sotu',
    promise: 'Sheaf rollup and the state of the union, from the one route that feeds both',
    artifacts: [{ path: `${PANES}/a6-sheaf.tsx` }, { path: `${PANES}/a4-sotu.tsx` }],
    feeds: [
      { path: 'src/broker/routes/sheaf.ts' },
      { path: 'src/broker/desk/fleet-sheaf.ts', needle: 'summarizeSheaf' },
    ],
  },
  {
    code: 'A5',
    card: 'wall-now-bar',
    promise: 'The now bar: what the whole fleet is doing right now, one stacked line',
    artifacts: [{ path: `${PANES}/a5-now-bar.tsx` }],
    feeds: [{ path: 'web/src/lib/types.ts', needle: 'classified', as: "CC's per-turn classifier" }],
  },
  {
    code: 'A7',
    card: 'wall-pane-unattended-runs',
    promise: 'Unattended runs: epic DAG, overseer lease age, baton tail, nightshift',
    // The stub registry pins this pane as `a7-unattended-runs.tsx`, and the
    // registry is what the epic says pane files are pinned BY. This manifest
    // guessed `a7-runs.tsx` and would have reported a delivered pane as missing
    // -- the same correction S1 and A2 already carry above: the probe follows
    // the code, never the other way round.
    artifacts: [{ path: `${PANES}/a7-unattended-runs.tsx` }],
    feeds: [{ path: 'src/broker/routes/epic.ts' }, { path: 'src/broker/routes/nightshift.ts' }],
  },
  {
    code: 'A8',
    card: 'wall-pane-pinned-epics',
    promise: 'Pinned epics: pin from the board, progress bar plus what is LEFT',
    artifacts: [
      { path: `${PANES}/a8-pinned.tsx` },
      { path: WALL, needle: 'useWallPins', as: 'the useWallPins contract symbol' },
      { path: 'web/src/**/*.ts*', needle: 'WALL_PINNED_KEY', as: 'the pin state key, shared by board and wall' },
    ],
    feeds: [{ path: 'src/shared/frontmatter.ts', needle: 'parseFrontmatter' }],
  },
  {
    code: 'W1',
    card: 'wall-time-cursor',
    promise: 'One scrubber rewinds EVERY pane together; past left, LIVE right',
    artifacts: [{ path: WALL, needle: 'useWallCursor', as: 'the useWallCursor contract symbol' }],
  },
  {
    code: 'W2',
    card: 'wall-filter-bus',
    promise: 'One query language, every pane obeys, one grammar reused from pulse',
    // The substrate half of this promise was split onto `wall-filter-store` by the
    // gen-7 q1 resolution (O2, "substrate first"), which also moved it OUT of
    // components/wall and INTO lib/wall. This manifest still asserted the
    // pre-split plan -- a `useWallQuery` that was never written, under a glob that
    // could never have matched -- so W2 read GONE for two generations while both
    // halves were merged and green. Assert what the CARDS name, where they say it
    // lives: `useWallFilter` + `parseWallQuery` (wall-filter-store) and the box
    // itself (wall-filter-bus).
    artifacts: [
      { path: LIB, needle: 'useWallFilter', as: 'the useWallFilter contract symbol' },
      { path: LIB, needle: 'parsePulseQuery', as: 'the pulse grammar REUSED, not forked' },
      { path: `${WALL_DIR}/wall-filter-box.tsx`, needle: 'useWallFilterStore', as: 'the header filter box' },
    ],
  },
  {
    code: 'W4',
    card: 'wall-navigation-and-hover',
    promise: 'A row click navigates the MAIN window even when the wall is detached',
    artifacts: [{ path: WALL, needle: 'navigateFromWall', as: 'the navigateFromWall contract symbol' }],
    feeds: [{ path: 'web/src/hooks/use-hover-popover.ts' }],
  },
  {
    code: 'COPY',
    card: 'wall-copy-affordance',
    promise: 'Every pane copies a report, every row copies its own value',
    artifacts: [{ path: WALL, needle: 'useWallCopy', as: 'the useWallCopy contract symbol' }],
  },
  {
    code: 'ICON',
    card: 'wall-surface-shell',
    promise: 'Every project mention carries its CONFIGURED icon and colour',
    artifacts: [{ path: WALL, needle: 'ProjectTag', as: 'the one ProjectTag component' }],
    feeds: [{ path: 'web/src/components/pulse/use-pulse-fleet.ts', needle: 'projectIcon' }],
  },
]
