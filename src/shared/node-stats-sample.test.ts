import { describe, expect, it } from 'bun:test'
import { validateNodeStats } from './node-stats'
import {
  buildNodeIdentity,
  buildNodeStatsReport,
  cpuPercentFromDelta,
  cpuTotals,
  createMachineSampler,
  osArchLabel,
  parseDfOutput,
  readDiskViaDf,
  readDiskViaStatfs,
  usedFromAvailable,
} from './node-stats-sample'

function times(user: number, nice: number, sys: number, idle: number, irq: number) {
  return { times: { user, nice, sys, idle, irq } }
}

describe('cpuTotals', () => {
  it('sums every core into one whole-box pair', () => {
    expect(cpuTotals([times(10, 0, 5, 85, 0), times(20, 0, 10, 70, 0)])).toEqual({ idle: 155, total: 200 })
  })

  it('is zero for no cores rather than throwing', () => {
    expect(cpuTotals([])).toEqual({ idle: 0, total: 0 })
  })
})

describe('cpuPercentFromDelta', () => {
  it('reports busy time over the interval, not since boot', () => {
    // 100 jiffies elapsed, 25 of them idle -> 75% busy.
    expect(cpuPercentFromDelta({ idle: 1000, total: 2000 }, { idle: 1025, total: 2100 })).toBe(75)
  })

  it('returns 0 when no time elapsed instead of dividing by zero', () => {
    expect(cpuPercentFromDelta({ idle: 1000, total: 2000 }, { idle: 1000, total: 2000 })).toBe(0)
  })

  it('never leaves 0..100, so the meter never has to clamp', () => {
    expect(cpuPercentFromDelta({ idle: 0, total: 0 }, { idle: 0, total: 100 })).toBe(100)
    expect(cpuPercentFromDelta({ idle: 0, total: 0 }, { idle: 200, total: 100 })).toBe(0)
  })

  it('rounds to one decimal', () => {
    expect(cpuPercentFromDelta({ idle: 0, total: 0 }, { idle: 1, total: 3 })).toBe(66.7)
  })
})

describe('parseDfOutput -- the fallback for filesystems statfs cannot describe', () => {
  // REGRESSION (2026-08-19, live on the Synology): `/volume1` has 7,492,117,464
  // blocks. That is > 2^32, so the 32-bit `statfs` returns EOVERFLOW and Bun's
  // statfsSync throws -- the reporter dutifully reported disk 0/0 for a 30TB
  // array. statfs stays the fast path (no fork on the 5s tick for the ~99% of
  // volumes it handles); df is the fallback for the ones it cannot.
  const DARWIN = [
    'Filesystem 1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1 1942700360 1893184216  40374144    98%    /',
  ].join('\n')

  it('reads used/total bytes and the mount point', () => {
    // `usedBytes` is total MINUS AVAILABLE, the same definition statfs uses --
    // NOT df's own `Used` column (1,893,184,216 KB here), which excludes the
    // root-reserved blocks and would read ~8.7 GiB low on this very capture.
    expect(parseDfOutput(DARWIN)).toEqual({
      usedBytes: (1_942_700_360 - 40_374_144) * 1024,
      totalBytes: 1_942_700_360 * 1024,
      mount: '/',
    })
  })

  it('handles the 30TB volume that overflowed statfs in the first place', () => {
    const synology = [
      'Filesystem           1024-blocks       Used Available Capacity Mounted on',
      '/dev/mapper/cachedev_0 29968469856 27510561000 2457908856      92% /volume1',
    ].join('\n')
    const parsed = parseDfOutput(synology)
    expect(parsed?.mount).toBe('/volume1')
    expect(parsed?.totalBytes).toBe(29_968_469_856 * 1024)
    expect(parsed?.usedBytes).toBeLessThan(parsed?.totalBytes ?? 0)
  })

  it('handles a mount path containing spaces', () => {
    const out = [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      '/dev/disk5 100 40 60 40% /Volumes/Big Disk',
    ].join('\n')
    expect(parseDfOutput(out)?.mount).toBe('/Volumes/Big Disk')
  })

  it('returns null on truncated or unparseable output rather than a fake zero', () => {
    expect(parseDfOutput('')).toBeNull()
    expect(parseDfOutput('Filesystem 1024-blocks Used Available Capacity Mounted on')).toBeNull()
    expect(parseDfOutput('header\n/dev/disk5 100 40')).toBeNull()
    expect(parseDfOutput('header\n/dev/disk5 lots some more 40% /')).toBeNull()
  })
})

describe('one definition of usedBytes -- both readers, one number', () => {
  // REGRESSION (2026-08-19): the two readers filled the SAME field two ways.
  // statfs computed `total - bavail` (the reserve counts as used); the df
  // fallback took df's `Used` column, which excludes the reserve. So the one
  // node that needs the fallback -- the 30TB Synology -- read systematically
  // low against every other node on the wall, with nothing in the payload to
  // say which reader produced the number.
  const CAPTURE = [
    'Filesystem 1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1 1942700360 1893184216  40374144    98%    /',
  ].join('\n')
  const [, blocksKb, dfUsedKb, availKb] = CAPTURE.split('\n')[1].split(/\s+/)

  it('agrees with the statfs arithmetic on one and the same df capture', () => {
    // statfs on this volume sees the same two numbers: blocks*bsize is the
    // 1024-blocks column and bavail*bsize is the Available column.
    const viaStatfs = usedFromAvailable(Number(blocksKb) * 1024, Number(availKb) * 1024)
    expect(parseDfOutput(CAPTURE)).toMatchObject({
      usedBytes: viaStatfs?.usedBytes,
      totalBytes: viaStatfs?.totalBytes,
    })
  })

  it('is NOT df field 3 -- the reserve counts as used, and the gap is real', () => {
    const parsed = parseDfOutput(CAPTURE)
    expect(parsed?.usedBytes).not.toBe(Number(dfUsedKb) * 1024)
    // df's own column reads LOW, never high: total = used + available + reserve.
    expect(parsed?.usedBytes).toBeGreaterThan(Number(dfUsedKb) * 1024)
  })

  // Cyclomatic 11 here is eleven `?.` guards on four assertions, not eleven
  // code paths. The test has one branch: none.
  // fallow-ignore-next-line complexity
  it('both readers describe the live volume the same way', () => {
    const dir = process.cwd()
    const viaStatfs = readDiskViaStatfs(dir)
    const viaDf = readDiskViaDf(dir)
    expect(viaStatfs).not.toBeNull()
    expect(viaDf).not.toBeNull()
    expect(viaDf?.totalBytes).toBe(viaStatfs?.totalBytes)
    expect(viaDf?.mount).toBe(viaStatfs?.mount)
    // The two readings are milliseconds apart on a live filesystem, so allow a
    // little drift -- but only a little. The bug this pins was a whole reserve
    // (~5% on a default ext4) wide, not a few blocks of churn.
    const drift = Math.abs((viaDf?.usedBytes ?? 0) - (viaStatfs?.usedBytes ?? 0))
    expect(drift).toBeLessThan((viaStatfs?.totalBytes ?? 0) * 0.005)
  })

  it('reports the directory it was asked about, not df`s mount point', () => {
    // `mount` diverged too: statfs cannot name a mount point at all, so it
    // reported the directory, while the df path reported df`s `Mounted on`.
    // One meaning wins -- the directory measured -- because that is the only
    // one the fast path (and the sh reporter, and the zeroed fallback) can say.
    const dir = process.cwd()
    expect(readDiskViaDf(dir)?.mount).toBe(dir)
    expect(dir).not.toBe('/')
  })
})

describe('disk read: statfs fast path, df fallback', () => {
  it('reads the real volume with used <= total', () => {
    const { disk } = createMachineSampler(process.cwd()).sample()
    expect(disk.totalBytes).toBeGreaterThan(0)
    expect(disk.usedBytes).toBeGreaterThanOrEqual(0)
    expect(disk.usedBytes).toBeLessThanOrEqual(disk.totalBytes)
  })

  it('reports the mount it was asked about', () => {
    expect(createMachineSampler('/').sample().disk.mount).toBe('/')
  })

  it('an unreadable path yields a zeroed disk, NOT a dropped frame -- cpu is still live', () => {
    const machine = createMachineSampler('/no/such/volume/anywhere').sample()
    expect(machine.disk).toEqual({ usedBytes: 0, totalBytes: 0, mount: '/no/such/volume/anywhere' })
    expect(machine.memory.totalBytes).toBeGreaterThan(0)
  })

  it('counts space this agent can actually WRITE (bavail), not root-reserved blocks', () => {
    // A meter that says 5% free while every write fails is a broken meter, so
    // used is computed against the unprivileged-available figure. That makes
    // used+free <= total on a reserved filesystem; it must never exceed total.
    const { disk } = createMachineSampler('/').sample()
    expect(disk.usedBytes).toBeLessThanOrEqual(disk.totalBytes)
  })
})

describe('osArchLabel', () => {
  it('is a single platform/arch string', () => {
    expect(osArchLabel()).toMatch(/^[a-z0-9]+\/[a-z0-9_]+$/)
  })
})

describe('buildNodeStatsReport -- one builder, two senders', () => {
  const sentinelIdentity = buildNodeIdentity({
    nodeId: 'snt_studio',
    hostId: 'host_studio',
    agentVersion: '1.2.3',
    sender: 'sentinel',
    hostname: 'studio',
  })
  const reporterIdentity = buildNodeIdentity({
    nodeId: 'rpt_nas',
    hostId: 'host_nas',
    agentVersion: '1.2.3',
    sender: 'reporter',
    hostname: 'nas',
  })
  const machine = createMachineSampler().sample()

  it('produces a sentinel frame that validates, extras included', () => {
    const report = buildNodeStatsReport(sentinelIdentity, machine, 1_700_000_000_000, { conversationCount: 5 })
    expect(report.sentinel).toEqual({ conversationCount: 5 })
    expect(validateNodeStats(report).ok).toBe(true)
  })

  it('produces a reporter frame that validates against the SAME schema', () => {
    const report = buildNodeStatsReport(reporterIdentity, machine, 1_700_000_000_000)
    expect(validateNodeStats(report).ok).toBe(true)
    expect('sentinel' in report).toBe(false)
  })

  it('drops sentinel-only extras handed to it on a reporter frame', () => {
    const report = buildNodeStatsReport(reporterIdentity, machine, 1_700_000_000_000, { conversationCount: 9 })
    expect('sentinel' in report).toBe(false)
    expect(validateNodeStats(report).ok).toBe(true)
  })

  it('reports HOST uptime, not process uptime', () => {
    // The agent started seconds ago; the box did not.
    expect(sentinelIdentity.uptimeSec).toBeGreaterThan(process.uptime())
  })
})

describe('createMachineSampler', () => {
  it('samples real machine facts that pass the contract validator', () => {
    const sampler = createMachineSampler()
    const machine = sampler.sample()
    expect(machine.load.cores).toBeGreaterThan(0)
    expect(machine.memory.totalBytes).toBeGreaterThan(0)
    expect(machine.memory.usedBytes).toBeLessThanOrEqual(machine.memory.totalBytes)
    expect(machine.disk.mount.length).toBeGreaterThan(0)
    const identity = buildNodeIdentity({
      nodeId: 'snt_local',
      hostId: 'host_local',
      agentVersion: '0.0.0-test',
      sender: 'sentinel',
    })
    expect(validateNodeStats(buildNodeStatsReport(identity, machine, Date.now())).ok).toBe(true)
  })

  it('measures the volume it was pointed at', () => {
    const machine = createMachineSampler(process.cwd()).sample()
    expect(machine.disk.totalBytes).toBeGreaterThan(0)
  })
})
