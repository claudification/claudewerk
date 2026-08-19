#!/usr/bin/env bun

/**
 * node-stats-reporter -- a node that reports vitals and can do NOTHING else.
 *
 * The whole binary is: open one WebSocket with an `rpt_` key, run the SHARED
 * cadence runner, reconnect on drop. No Claude Code, no spawn path, no
 * credential store, no filesystem access beyond reading its own disk usage.
 * Droppable on any box, including one you would never hand an `snt_` to.
 *
 * It implements the contract in `src/shared/node-stats*` and nothing more --
 * the payload, the cadence, the sampler, the host fingerprint and the
 * validation are the SAME code the sentinel runs. This file contains no shape
 * of its own.
 */

import { hostId } from '../shared/host-id'
import { NODE_STATS_INTERVAL_MS } from '../shared/node-stats'
import { createNodeStatsReporter, type NodeStatsReporter } from '../shared/node-stats-reporting'
import { buildNodeIdentity } from '../shared/node-stats-sample'
import { BUILD_VERSION } from '../shared/version'
import { backoffMs, parseReporterArgs, type ReporterConfig } from './config'

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function connect(config: ReporterConfig, attempt: number): void {
  // Never log the URL: it carries the secret.
  log(`Connecting to ${config.brokerUrl} ...`)
  const ws = new WebSocket(`${config.brokerUrl}?secret=${encodeURIComponent(config.secret)}`)
  let reporter: NodeStatsReporter | null = null
  let reconnected = false

  const reconnect = (why: string): void => {
    if (reconnected) return
    reconnected = true
    reporter?.stop()
    reporter = null
    const delay = backoffMs(attempt)
    log(`Disconnected (${why}). Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}).`)
    setTimeout(() => connect(config, attempt + 1), delay)
  }

  ws.onopen = () => {
    log(`Connected. Reporting every ${NODE_STATS_INTERVAL_MS / 1000}s.`)
    reporter = createNodeStatsReporter({
      // `nodeId` is advisory -- the broker stamps the id it resolved from the
      // key. `hostId` is NOT: it is the machine dedupe key, and it is computed
      // by the same shared function the sentinel uses, so a sentinel and this
      // reporter on one box collapse to one machine row instead of two.
      identity: buildNodeIdentity({
        nodeId: `reporter@${hostId()}`,
        hostId: hostId(),
        agentVersion: BUILD_VERSION.gitHashShort,
        sender: 'reporter',
      }),
      diskMount: config.diskMount,
      send: report => {
        if (ws.readyState !== WebSocket.OPEN) return false
        ws.send(JSON.stringify(report))
        if (config.verbose) {
          const { machine } = report
          log(
            `sample cpu=${machine.cpuPercent.toFixed(1)}% ` +
              `load=${machine.load.one.toFixed(2)}/${machine.load.cores} ` +
              `mem=${machine.memory.usedBytes}/${machine.memory.totalBytes} ` +
              `disk=${machine.disk.usedBytes}/${machine.disk.totalBytes}@${machine.disk.mount}`,
          )
        }
        return true
      },
      log,
    })
    reporter.start()
  }

  // The broker refuses everything a reporter is not allowed to send, with a
  // reason. Surface it -- a silent reporter the broker is rejecting is the worst
  // possible failure mode.
  ws.onmessage = event => {
    try {
      const msg = JSON.parse(String(event.data)) as { type?: string; ok?: boolean; error?: string }
      if (msg.ok === false && msg.error) log(`Broker refused ${msg.type ?? 'a message'}: ${msg.error}`)
    } catch {
      // Non-JSON from the broker is not this binary's problem.
    }
  }

  ws.onerror = () => reconnect('socket error')
  ws.onclose = (event: CloseEvent) => {
    // A 409 at upgrade means another connection already holds this key. Say so
    // plainly: one connection per key is a RULE, not a transient failure.
    if (event.code === 1006) {
      log('Upgrade refused. If this key is already connected elsewhere, that is the rule: one connection per key.')
    }
    reconnect(`code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`)
  }
}

function main(): void {
  const parsed = parseReporterArgs(process.argv.slice(2), process.env)
  if (!parsed.ok || !parsed.config) {
    console.error(parsed.error)
    process.exit(1)
  }
  log(`node-stats-reporter ${BUILD_VERSION.gitHashShort} starting (vitals only). host=${hostId()}`)

  const shutdown = (signal: string): void => {
    log(`${signal} received. Exiting.`)
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  connect(parsed.config, 0)
}

main()
