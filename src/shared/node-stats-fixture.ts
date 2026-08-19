/**
 * Shared node-stats test fixtures. Lives beside the contract so the reporter
 * frame and the sentinel frame are defined ONCE for every test that needs
 * them -- two hand-written fixtures would drift exactly the way two hand-written
 * shapes would.
 *
 * fallow-ignore-next-line unused
 */

import { type NodeMachineStats, REPORT_NODE_STATS, type ReportNodeStats } from './node-stats'

export const FIXTURE_MACHINE: NodeMachineStats = {
  cpuPercent: 42.5,
  load: { avg1: 3.2, avg5: 2.8, avg15: 2.1, cores: 10 },
  memory: { usedBytes: 8_000_000_000, totalBytes: 32_000_000_000 },
  disk: { usedBytes: 400_000_000_000, totalBytes: 2_000_000_000_000, mount: '/Users/jonas' },
}

/** A REPORTER frame: no `sentinel` block, by construction. */
export const FIXTURE_REPORTER_FRAME: ReportNodeStats = {
  type: REPORT_NODE_STATS,
  nodeId: 'rpt-node-1',
  hostname: 'beast',
  platform: 'linux/x64',
  agentVersion: 'abc1234',
  uptimeSec: 90_000,
  sampledAt: 1_760_000_000_000,
  machine: FIXTURE_MACHINE,
}

/** A SENTINEL frame: the same frame plus the optional extras. */
export const FIXTURE_SENTINEL_FRAME: ReportNodeStats = {
  ...FIXTURE_REPORTER_FRAME,
  nodeId: 'snt-node-1',
  sentinel: {
    conversationCount: 7,
    profiles: [
      { name: 'default', utilizationPercent: 61 },
      { name: 'work', utilizationPercent: 12 },
    ],
  },
}

/** A sampler stub, so a frame builder never touches real hardware. */
export const stubSampler = { sample: (): NodeMachineStats => FIXTURE_MACHINE }
