#!/usr/bin/env bun
/**
 * S1's live probe: real machine -> real broker pipe -> the numbers a `wall_frame`
 * actually carries, printed beside what `top` / `df` / `sysctl` say about the
 * same box at the same moment.
 *
 * WHY THIS EXISTS. The card's first acceptance line is "real numbers from a real
 * sentinel, verified against `top` on that box". A unit test proves the
 * projection is self-consistent; it cannot prove the number is TRUE. This runs
 * the SAME collector the sentinel runs (`createMachineSampler`), pushes each
 * sample through the SAME producer the broker handler calls
 * (`recordWallHostVitals`), reads the frame off a real `createWallHub`
 * subscriber socket, and diffs the result against the system tools.
 *
 * It is an instrument, not a test: it measures THIS box and prints a table.
 * Re-run it on any node whose vitals look wrong.
 *
 *   bun scripts/wall-host-vitals-probe.ts [samples]
 */

import { execFileSync } from 'node:child_process'
import { hostname, totalmem } from 'node:os'
import { recordWallHostVitals } from '../src/broker/wall/host-vitals'
import { wallHub } from '../src/broker/wall/index'
import { NODE_STATS_INTERVAL_MS } from '../src/shared/node-stats'
import { buildNodeIdentity, buildNodeStatsReport, createMachineSampler } from '../src/shared/node-stats-sample'
import type { WallFrame, WallHostVitals } from '../src/shared/wall'

const SAMPLES = Math.max(2, Number(process.argv[2] ?? 4))

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return '(unavailable)'
  }
}

/**
 * `top` measuring THE SAME WINDOW as our samples, started alongside them.
 *
 * Two things make a naive comparison worthless. `top -l 1` reports usage
 * cumulative since boot, so only the SECOND reading is an interval -- the same
 * reason the sampler holds a previous total. And a `top` run AFTER the samples
 * measures a different five seconds, which on a busy box is a different number
 * entirely. So: one `top` spanning the whole run, read at the end.
 */
function startTop(windowSec: number): Promise<string> {
  const proc = Bun.spawn(['top', '-l', '2', '-n', '0', '-s', String(windowSec)], { stdout: 'pipe', stderr: 'ignore' })
  return new Response(proc.stdout).text().then(out => {
    const lines = out.split('\n').filter(l => l.startsWith('CPU usage'))
    return lines.at(-1)?.trim() ?? '(no CPU usage line)'
  })
}

/** The busy percentage `top` reported, parsed out of its idle figure. */
function topBusyPercent(line: string): number | null {
  const idle = /([\d.]+)%\s+idle/.exec(line)
  return idle?.[1] ? Math.round((100 - Number(idle[1])) * 10) / 10 : null
}

function dfLine(dir: string): string {
  return sh('df', ['-Ph', dir]).split('\n').at(-1) ?? '(no df line)'
}

/** Collect the frames a real hub delivers to a real subscriber socket. */
function collector(): { socket: { send(data: string): void }; frames: WallFrame[] } {
  const frames: WallFrame[] = []
  return {
    socket: {
      send(data: string) {
        frames.push(JSON.parse(data) as WallFrame)
      },
    },
    frames,
  }
}

function fmt(pct: number | undefined): string {
  return pct === undefined ? '  --  ' : `${pct.toFixed(1).padStart(5)}%`
}

// PERMANENT suppression, and it says so on purpose (overseer ruling, gen 17).
// Cyclomatic 11 and cognitive 9 are both UNDER threshold; only CRAP trips, and
// CRAP is complexity weighted by coverage. This is a hand-run probe that opens a
// real hub socket and diffs the frame against `top` on a live box -- its coverage
// is 0 by construction and always will be. Nothing here names a card to delete it.
// fallow-ignore-next-line complexity
async function main(): Promise<void> {
  const sampler = createMachineSampler(process.cwd())
  const identity = buildNodeIdentity({
    nodeId: `probe-${process.pid}`,
    hostId: `probe-host-${hostname()}`,
    agentVersion: 'probe',
    sender: 'sentinel',
  })

  const { socket, frames } = collector()
  wallHub.subscribe(socket)

  console.log(`\nS1 HOST VITALS -- live probe on ${identity.hostname} (${identity.osArch})`)
  console.log(`${SAMPLES} samples at the shared ${NODE_STATS_INTERVAL_MS}ms cadence\n`)

  // Spans the whole run so its interval is OUR interval. The sampler's very
  // first frame is excluded from the comparison below: its CPU delta is measured
  // over ~zero elapsed time and is noise, not a reading (card
  // `node-stats-first-tick-is-noise`).
  const topLine = startTop((SAMPLES - 1) * (NODE_STATS_INTERVAL_MS / 1000))

  const seen: WallHostVitals[] = []
  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) await Bun.sleep(NODE_STATS_INTERVAL_MS)
    const report = buildNodeStatsReport(identity, sampler.sample(), Date.now(), { conversationCount: i })
    recordWallHostVitals(report)
    wallHub.tick()
    const row = frames.at(-1)?.hosts?.at(-1)
    if (row) {
      seen.push(row)
      console.log(
        `  sample ${String(i + 1).padStart(2)}  cpu ${fmt(row.cpuPct)}  ram ${fmt(row.memPct)}  ` +
          `disk ${fmt(row.diskPct)}  load ${row.load1?.toFixed(2)}/${row.cores}  series=${row.cpuHistory?.length}`,
      )
    }
  }

  const last = seen.at(-1)
  wallHub.unsubscribe(socket)

  const top = await topLine
  console.log('\n-- what the box says over THE SAME window --')
  console.log(`  ${top}`)
  console.log(`  df:  ${dfLine(process.cwd())}`)
  console.log(`  mem: total ${(totalmem() / 1024 ** 3).toFixed(1)} GiB   ${sh('sysctl', ['-n', 'hw.ncpu'])} cores`)
  console.log(`  uptime: ${sh('uptime', [])}`)

  console.log('\n-- what the frame carried --')
  console.log(`  ${JSON.stringify(last, null, 2)?.split('\n').join('\n  ')}`)

  // Mean of the REAL samples (frame one excluded, see above) against `top`'s
  // busy figure for the same seconds. They will not be identical -- `top`
  // averages the whole window and we sampled it in 5s steps -- but a projection
  // that had the units or the direction wrong would be nowhere near.
  const real = seen.slice(1).map(r => r.cpuPct ?? 0)
  const mine = real.length ? Math.round((real.reduce((a, b) => a + b, 0) / real.length) * 10) / 10 : null
  const theirs = topBusyPercent(top)
  console.log('\n-- cpu, cross-checked --')
  console.log(`  frame mean (samples 2-${seen.length}): ${mine}%`)
  console.log(`  top busy over the same window:  ${theirs}%`)

  // The one invariant worth asserting rather than eyeballing: the ring is a
  // series, it grew, and its last point IS the meter's number.
  const history = last?.cpuHistory ?? []
  const rolled = history.length === seen.length && history.at(-1) === last?.cpuPct
  console.log(`\n  series length ${history.length} of ${seen.length} samples, tail matches cpuPct: ${rolled}`)
  if (!rolled) process.exitCode = 1
}

await main()
