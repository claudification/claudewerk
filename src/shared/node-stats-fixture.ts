/**
 * Shared node-stats test fixtures.
 *
 * These are built with `buildNodeStatsReport`, NOT hand-written -- a fixture
 * that declares `type: 'node_stats'` itself is a second declaration of the
 * shape, which is the exact drift the contract forbids (and which
 * node-stats.test.ts fails the build over).
 *
 * fallow-ignore-next-line unused
 */

import type { MachineStats, NodeIdentity, NodeStatsReport } from './node-stats'
import { buildNodeStatsReport } from './node-stats-sample'

export const FIXTURE_MACHINE: MachineStats = {
  cpuPercent: 42.5,
  load: { one: 3.2, five: 2.8, fifteen: 2.1, cores: 10 },
  memory: { usedBytes: 8_000_000_000, totalBytes: 32_000_000_000 },
  disk: { usedBytes: 400_000_000_000, totalBytes: 2_000_000_000_000, mount: '/Users/jonas' },
}

export const FIXTURE_SAMPLED_AT = 1_760_000_000_000

export const FIXTURE_REPORTER_IDENTITY: NodeIdentity = {
  nodeId: 'rpt-node-1',
  hostId: 'host-beast',
  hostname: 'beast',
  osArch: 'linux/x64',
  agentVersion: 'abc1234',
  uptimeSec: 90_000,
  sender: 'reporter',
}

/** Same box, different agent. */
export const FIXTURE_SENTINEL_IDENTITY: NodeIdentity = {
  ...FIXTURE_REPORTER_IDENTITY,
  nodeId: 'snt-node-1',
  sender: 'sentinel',
}

/** A REPORTER frame: no `sentinel` block, by construction. */
export const FIXTURE_REPORTER_FRAME: NodeStatsReport = buildNodeStatsReport(
  FIXTURE_REPORTER_IDENTITY,
  FIXTURE_MACHINE,
  FIXTURE_SAMPLED_AT,
)

/** A SENTINEL frame: the same frame, same host, plus the optional extras. */
export const FIXTURE_SENTINEL_FRAME: NodeStatsReport = buildNodeStatsReport(
  FIXTURE_SENTINEL_IDENTITY,
  FIXTURE_MACHINE,
  FIXTURE_SAMPLED_AT,
  { conversationCount: 7 },
)

/** A sampler stub, so a frame builder never touches real hardware. */
export const stubSampler = { sample: (): MachineStats => FIXTURE_MACHINE }
