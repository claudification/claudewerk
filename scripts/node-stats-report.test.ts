/**
 * THE COST OF OPTION A, made payable.
 *
 * Card `node-stats-http-ingest` names the sharp problem in as many words: a
 * shell script is a THIRD implementation of the measurement, and "the contract
 * can validate the SHAPE it posts and cannot validate the METHOD". Option A --
 * sanction the script -- was chosen on the condition that the method gets pinned
 * by a test that runs the script and the Bun sampler over the same inputs and
 * fails when they disagree. This is that test.
 *
 * It runs EVERYWHERE, not just on Linux: `NODE_STATS_PROC_ROOT` points the
 * script's reads at fixture files, so the arithmetic is compared deterministically
 * on any box instead of racing a live one. The live same-box comparison the card
 * describes runs too, gated to Linux, where /proc actually exists.
 *
 * The fixtures move iowait, softirq and steal HARD between snapshots. That is
 * deliberate: `os.cpus()` (libuv) excludes all three, so a script that "fixed"
 * itself by summing every column would read differently from every other node on
 * the wall, and this is the test that says so.
 */

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingestNodeStats } from '../src/broker/node-stats-ingest'
import { nodeStatsStore } from '../src/broker/node-stats-store'
import { hostId } from '../src/shared/host-id'
import { validateNodeStats } from '../src/shared/node-stats'
import { cpuPercentFromDelta, cpuTotals, createMachineSampler, osArchLabel } from '../src/shared/node-stats-sample'

const SCRIPT = join(import.meta.dirname, 'node-stats-report.sh')

function run(args: string[], env: Record<string, string> = {}): { out: string; err: string; code: number } {
  const proc = Bun.spawnSync(['sh', SCRIPT, ...args], { env: { ...process.env, ...env } })
  return {
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
    code: proc.exitCode ?? -1,
  }
}

/** A `/proc/stat` cpu line, by column name. */
interface CpuLine {
  user: number
  nice: number
  system: number
  idle: number
  iowait: number
  irq: number
  softirq: number
  steal: number
}

function statFile(cpu: CpuLine): string {
  const { user, nice, system, idle, iowait, irq, softirq, steal } = cpu
  return (
    `cpu  ${user} ${nice} ${system} ${idle} ${iowait} ${irq} ${softirq} ${steal} 0 0\n` +
    `cpu0 ${user} ${nice} ${system} ${idle} ${iowait} ${irq} ${softirq} ${steal} 0 0\n` +
    'intr 12345 0 0\n'
  )
}

/**
 * The same columns libuv's `uv_cpu_info` reads out of /proc/stat, in the shape
 * `cpuTotals` wants. iowait is READ AND DISCARDED there (it lands in a dummy),
 * softirq and steal are never read at all -- so they are absent here.
 */
function asCpusEntry(cpu: CpuLine) {
  return [{ times: { user: cpu.user, nice: cpu.nice, sys: cpu.system, idle: cpu.idle, irq: cpu.irq } }]
}

/** What the Bun sampler would compute for this pair of snapshots. */
function bunPercent(prev: CpuLine, next: CpuLine): number {
  return cpuPercentFromDelta(cpuTotals(asCpusEntry(prev)), cpuTotals(asCpusEntry(next)))
}

/** What the shell script computes for the same pair. */
function shellPercent(prev: CpuLine, next: CpuLine): number {
  const dir = mkdtempSync(join(tmpdir(), 'node-stats-cpu-'))
  try {
    writeFileSync(join(dir, 'prev'), statFile(prev))
    writeFileSync(join(dir, 'next'), statFile(next))
    const { out, err, code } = run(['cpu-percent', join(dir, 'prev'), join(dir, 'next')])
    expect({ code, err }).toEqual({ code: 0, err: '' })
    return Number(out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const IDLE: CpuLine = { user: 100, nice: 20, system: 50, idle: 1000, iowait: 30, irq: 5, softirq: 7, steal: 0 }

describe('CPU: the script and the Bun sampler compute the same number', () => {
  const CASES: Array<{ name: string; prev: CpuLine; next: CpuLine }> = [
    {
      name: 'a normal busy interval',
      prev: IDLE,
      next: { user: 200, nice: 40, system: 100, idle: 1500, iowait: 60, irq: 10, softirq: 14, steal: 0 },
    },
    {
      name: 'a fully idle interval',
      prev: IDLE,
      next: { ...IDLE, idle: 2000 },
    },
    {
      name: 'a pegged interval (no idle time at all)',
      prev: IDLE,
      next: { ...IDLE, user: 1100 },
    },
    {
      name: 'no time elapsed -- 0, never a NaN',
      prev: IDLE,
      next: IDLE,
    },
    {
      name: 'a counter that went BACKWARDS (a reboot mid-interval)',
      prev: { ...IDLE, user: 5000 },
      next: IDLE,
    },
    {
      name: 'huge counters (an uptime measured in months)',
      prev: { user: 9e8, nice: 1e7, system: 4e8, idle: 8e9, iowait: 3e8, irq: 5e6, softirq: 9e6, steal: 0 },
      next: {
        user: 9.1e8,
        nice: 1e7,
        system: 4.02e8,
        idle: 8.05e9,
        iowait: 3.1e8,
        irq: 5.1e6,
        softirq: 9.4e6,
        steal: 0,
      },
    },
  ]

  for (const { name, prev, next } of CASES) {
    it(name, () => {
      expect(shellPercent(prev, next)).toBe(bunPercent(prev, next))
    })
  }

  it('EXCLUDES iowait, softirq and steal -- exactly as libuv does', () => {
    // Same real work in both intervals; the second one also burns a mountain of
    // iowait/softirq/steal. Include those columns and the percent MOVES. libuv
    // does not, so neither may the script, or this node reads low against every
    // other node on the wall whenever the disk is busy.
    const busy: CpuLine = { user: 200, nice: 40, system: 100, idle: 1500, iowait: 60, irq: 10, softirq: 14, steal: 0 }
    const busyPlusNoise: CpuLine = { ...busy, iowait: 60_000, softirq: 14_000, steal: 9_000 }

    expect(shellPercent(IDLE, busyPlusNoise)).toBe(shellPercent(IDLE, busy))
    expect(shellPercent(IDLE, busyPlusNoise)).toBe(bunPercent(IDLE, busyPlusNoise))
  })

  it('rounds half UP like JS Math.round, not half-to-even like printf', () => {
    // busy = 1275/10000 * 100 = 12.75 -> 12.8, where "%.1f" would give 12.8 or
    // 12.7 depending on the libc. The script does int(x*10+0.5)/10 for this.
    const prev: CpuLine = { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 }
    const next: CpuLine = { user: 1275, nice: 0, system: 0, idle: 8725, iowait: 0, irq: 0, softirq: 0, steal: 0 }
    expect(bunPercent(prev, next)).toBe(12.8)
    expect(shellPercent(prev, next)).toBe(12.8)
  })
})

// ─── The whole frame, off fixture /proc files ──────────────────────────────

const FIXTURE_MEM_TOTAL_KB = 32_000_000
const FIXTURE_MEM_FREE_KB = 8_000_000
const FIXTURE_MEM_AVAILABLE_KB = 20_000_000 // deliberately nothing like MemFree

function fixtureProcRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'node-stats-proc-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stat'), statFile(IDLE))
  writeFileSync(
    join(dir, 'meminfo'),
    `MemTotal:       ${FIXTURE_MEM_TOTAL_KB} kB\n` +
      `MemFree:         ${FIXTURE_MEM_FREE_KB} kB\n` +
      `MemAvailable:   ${FIXTURE_MEM_AVAILABLE_KB} kB\n` +
      'Buffers:          123456 kB\n',
  )
  writeFileSync(join(dir, 'loadavg'), '3.20 2.80 2.10 2/1234 5678\n')
  writeFileSync(join(dir, 'uptime'), '90000.50 700000.00\n')
  writeFileSync(join(dir, 'cpuinfo'), 'processor\t: 0\nprocessor\t: 1\nprocessor\t: 2\nprocessor\t: 3\n')
  return dir
}

/** One frame, built off the fixtures, parsed. */
function fixtureFrame(mount = process.cwd()): Record<string, unknown> {
  const proc = fixtureProcRoot()
  try {
    const { out, err, code } = run(['--print', '--once', '--interval', '0', '--mount', mount], {
      NODE_STATS_PROC_ROOT: proc,
    })
    expect({ code, err }).toEqual({ code: 0, err: '' })
    return JSON.parse(out) as Record<string, unknown>
  } finally {
    rmSync(proc, { recursive: true, force: true })
  }
}

describe('the frame the script posts', () => {
  it('validates against the SHARED validator, unmodified', () => {
    const parsed = validateNodeStats(fixtureFrame())
    expect(parsed.ok ? [] : parsed.errors).toEqual([])
  })

  it('is a REPORTER frame: no sentinel extras, ever', () => {
    const frame = fixtureFrame()
    expect(frame.sentinel).toBeUndefined()
    expect((frame.node as { sender: string }).sender).toBe('reporter')
  })

  it('fingerprints the host IDENTICALLY to hostId() -- or one box becomes two rows', () => {
    // The single worst drift available here: a different fingerprint puts this
    // box on the wall twice, at double the RAM, which is the exact
    // double-counting the contract exists to prevent.
    expect((fixtureFrame().node as { hostId: string }).hostId).toBe(hostId())
  })

  it('labels os/arch in node`s spelling, not uname`s', () => {
    expect((fixtureFrame().node as { osArch: string }).osArch).toBe(osArchLabel())
  })

  it('reads MemFree, NOT MemAvailable (freemem() is sysinfo freeram)', () => {
    const { memory } = fixtureFrame().machine as { memory: { usedBytes: number; totalBytes: number } }
    expect(memory.totalBytes).toBe(FIXTURE_MEM_TOTAL_KB * 1024)
    expect(memory.usedBytes).toBe((FIXTURE_MEM_TOTAL_KB - FIXTURE_MEM_FREE_KB) * 1024)
    // The friendlier, wrong number.
    expect(memory.usedBytes).not.toBe((FIXTURE_MEM_TOTAL_KB - FIXTURE_MEM_AVAILABLE_KB) * 1024)
  })

  it('carries the load average with the core count it must be read against', () => {
    const { load } = fixtureFrame().machine as { load: Record<string, number> }
    expect(load).toEqual({ one: 3.2, five: 2.8, fifteen: 2.1, cores: 4 })
  })

  it('reports HOST uptime, rounded, not the process`s', () => {
    expect((fixtureFrame().node as { uptimeSec: number }).uptimeSec).toBe(90_000)
  })
})

describe('disk: the script agrees with the sampler on the same volume', () => {
  it('total is identical and used agrees within the churn between two readings', () => {
    // Both compute used = total - AVAILABLE (statfs `bavail`), NOT df's `Used`
    // column, which excludes the root-reserved blocks and reads ~2% low on ext4
    // (38 GB low on the APFS volume this was written on).
    const mount = process.cwd()
    const { disk } = fixtureFrame(mount).machine as {
      disk: { usedBytes: number; totalBytes: number; mount: string }
    }
    const sampled = createMachineSampler(mount).sample().disk

    expect(disk.totalBytes).toBe(sampled.totalBytes)
    expect(disk.mount).toBe(mount)
    // 64 MiB: the two readings are seconds apart on a live filesystem.
    expect(Math.abs(disk.usedBytes - sampled.usedBytes)).toBeLessThan(64 * 1024 * 1024)
  })
})

describe('the script`s bytes feed the SAME broker ingest as every other sender', () => {
  it('a printed frame lands in the store when handed to the ingest core', () => {
    nodeStatsStore.clear()
    const logs: string[] = []
    const result = ingestNodeStats({ nodeId: 'rpt-from-sh', sender: 'reporter' }, fixtureFrame(), {
      log: { info: m => logs.push(m), debug: m => logs.push(m) },
      broadcast: () => {},
      announceIdentity: false,
    })
    expect(result.ok ? null : result.errors).toBeNull()
    // Keyed by the CREDENTIAL, not the `sh@<hostId>` the script put on the wire.
    expect(nodeStatsStore.get('rpt-from-sh')).toBeDefined()
    nodeStatsStore.clear()
  })
})

describe('refusals', () => {
  it('refuses to post without a URL and a secret', () => {
    const proc = fixtureProcRoot()
    try {
      expect(run(['--once'], { NODE_STATS_PROC_ROOT: proc, NODE_STATS_URL: '', NODE_STATS_SECRET: '' }).code).toBe(2)
    } finally {
      rmSync(proc, { recursive: true, force: true })
    }
  })

  it('says plainly that it needs /proc rather than shipping fabricated numbers', () => {
    const empty = mkdtempSync(join(tmpdir(), 'node-stats-noproc-'))
    try {
      const { code, err } = run(['--print', '--once', '--interval', '0'], { NODE_STATS_PROC_ROOT: empty })
      expect(code).toBe(1)
      expect(err).toContain('Linux only')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(run(['--interval', '5', '--danger']).code).toBe(2)
  })
})

// ─── The card's literal ask: same box, both implementations, live ──────────

describe.skipIf(process.platform !== 'linux')('LIVE: script vs Bun sampler on this box', () => {
  it('agrees on memory, load, cores and disk against the real /proc', () => {
    const frame = JSON.parse(run(['--print', '--once', '--interval', '1', '--mount', process.cwd()]).out) as Record<
      string,
      unknown
    >
    const machine = frame.machine as {
      memory: { usedBytes: number; totalBytes: number }
      load: { one: number; cores: number }
      disk: { usedBytes: number; totalBytes: number }
    }
    const sampled = createMachineSampler(process.cwd()).sample()

    expect(machine.memory.totalBytes).toBe(sampled.memory.totalBytes)
    expect(machine.load.cores).toBe(sampled.load.cores)
    expect(machine.disk.totalBytes).toBe(sampled.disk.totalBytes)
    // Live values move between the two readings; these bound the DRIFT, not the
    // noise. 5% of RAM and 0.5 of load is far tighter than a method difference.
    expect(Math.abs(machine.memory.usedBytes - sampled.memory.usedBytes)).toBeLessThan(sampled.memory.totalBytes * 0.05)
    expect(Math.abs(machine.load.one - sampled.load.one)).toBeLessThan(0.5)
  })
})
