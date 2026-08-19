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
 * the payload, the cadence, the sampler and the validation are the SAME code
 * the sentinel runs. That is the point of the contract: this file contains no
 * shape of its own.
 */

import { NODE_STATS_INTERVAL_MS } from '../shared/node-stats'
import { createNodeStatsReporter, type NodeStatsReporter } from '../shared/node-stats-reporting'
import { BUILD_VERSION } from '../shared/version'
import { backoffMs, parseReporterArgs, type ReporterConfig } from './config'

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function connect(config: ReporterConfig, attempt: number): void {
  const url = `${config.brokerUrl}?secret=${encodeURIComponent(config.secret)}`
  // Never log the secret. The URL carries it, so the URL is never logged either.
  log(`Connecting to ${config.brokerUrl} ...`)

  const ws = new WebSocket(url)
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
    // `nodeId` is advisory: the broker stamps the id it resolved from the key.
    // We send the hostname so a misconfigured key is greppable in broker logs.
    reporter = createNodeStatsReporter({
      nodeId: `reporter@${Bun.env.HOSTNAME || 'unknown'}`,
      agentVersion: BUILD_VERSION.gitHashShort,
      diskMount: config.diskMount,
      send: frame => {
        if (ws.readyState !== WebSocket.OPEN) return false
        ws.send(JSON.stringify(frame))
        if (config.verbose) {
          log(
            `sample cpu=${frame.machine.cpuPercent.toFixed(1)}% ` +
              `load=${frame.machine.load.avg1.toFixed(2)}/${frame.machine.load.cores} ` +
              `mem=${frame.machine.memory.usedBytes}/${frame.machine.memory.totalBytes}`,
          )
        }
        return true
      },
      log,
    })
    reporter.start()
  }

  // The broker rejects everything a reporter is not allowed to send, with a
  // reason. Surface it rather than swallowing it -- a silent reporter that the
  // broker is refusing is the worst possible failure mode.
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
    // 409 at upgrade = another connection already holds this key. Say so
    // plainly: "one connection per key" is a rule, not a transient failure.
    if (event.code === 1006)
      log('Upgrade refused. If the key is already connected elsewhere, that is the rule: one per key.')
    reconnect(`code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`)
  }
}

function main(): void {
  const parsed = parseReporterArgs(process.argv.slice(2), process.env)
  if (!parsed.ok || !parsed.config) {
    console.error(parsed.error)
    process.exit(1)
  }
  const config = parsed.config
  log(`node-stats-reporter ${BUILD_VERSION.gitHashShort} starting (vitals only).`)

  const shutdown = (signal: string): void => {
    log(`${signal} received. Exiting.`)
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  connect(config, 0)
}

main()
