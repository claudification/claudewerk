/**
 * Daemon-host local MCP server.
 *
 * Stands up the host MCP toolset for a daemon-backed conversation so a
 * daemon-hosted agent gets the SAME tool surface a claude-hosted agent gets
 * (Phase 3 of the MCP toolset unification). Mirrors `claude-agent-host`'s
 * local-server + MCP wiring, minus the hook/AskUserQuestion plumbing the daemon
 * does not own (the cc-daemon owns the worker process, so claudewerk's hooks
 * never fire).
 *
 * The endpoint is FIXED UP FRONT by the sentinel (see daemon-mcp-endpoint.ts):
 * the worker's `--mcp-config` already points at `127.0.0.1:<port>/mcp`, and the
 * sentinel hands us the same URL via `CLAUDWERK_MCP_ENDPOINT`. We bind exactly
 * that port -- deterministic, so a host restart re-binds the identical endpoint
 * the worker was launched against. When the env is unset (e.g. ATTACH mode, or
 * an older sentinel) we start nothing, leaving existing daemon spawns untouched.
 */

import type { PendingCallbacks } from '../agent-host-common/host-rpc'
import { setMcpHostDebug } from '../agent-host-common/mcp-host/debug'
import {
  closeMcpChannel,
  handleMcpRoute,
  initMcpChannel,
  setBrokerInfo,
  setDialogCwd,
} from '../agent-host-common/mcp-host/mcp-channel'
import { setBrokerRpcSender } from '../agent-host-common/mcp-host/mcp-tools/lib/broker-rpc'
import { DAEMON_MCP_ENDPOINT_ENV, parseDaemonMcpEndpointPort } from '../shared/daemon-mcp-endpoint'
import { buildDaemonMcpCallbacks, type DaemonMcpCallbackDeps } from './mcp-callbacks'

export interface DaemonMcpHandle {
  /** Pending-RPC registry the host's inbound dispatch resolves into. */
  pending: PendingCallbacks
  /** Tear down the HTTP server + MCP channel (best-effort, idempotent). */
  stop: () => void
}

export interface StartDaemonMcpDeps extends DaemonMcpCallbackDeps {
  /** CC version for the whoami identity, when known. */
  claudeVersion?: string
}

/** Route one local HTTP request: `/health`, `/mcp[...]`, else 404. Exported for tests. */
export async function handleDaemonHttp(req: Request): Promise<Response> {
  if (new URL(req.url).pathname === '/health') return new Response('ok', { status: 200 })
  return (await handleMcpRoute(req)) ?? new Response('Not found', { status: 404 })
}

/** Bind the loopback `/mcp` server, or return null on a bind failure (degraded,
 *  not fatal -- the conversation still runs, the worker's tool calls just 404). */
function bindMcpServer(port: number, log: (msg: string) => void): ReturnType<typeof Bun.serve> | null {
  try {
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1', // loopback only -- NEVER bind 0.0.0.0
      idleTimeout: 255, // max value (s) -- MCP SSE streams need long-lived connections
      fetch: handleDaemonHttp,
    })
    log(`[mcp] host MCP server listening on 127.0.0.1:${port}/mcp`)
    return server
  } catch (err) {
    log(`[mcp] FAILED to bind 127.0.0.1:${port}: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

/**
 * Start the daemon-host's local `/mcp` server and wire the host MCP channel.
 * Returns null (starts nothing) when `CLAUDWERK_MCP_ENDPOINT` is unset/malformed
 * so legacy daemon spawns keep working unchanged.
 */
export function startDaemonMcp(deps: StartDaemonMcpDeps): DaemonMcpHandle | null {
  const port = parseDaemonMcpEndpointPort(process.env[DAEMON_MCP_ENDPOINT_ENV])
  if (port === null) {
    deps.log(`[mcp] ${DAEMON_MCP_ENDPOINT_ENV} unset/invalid -- skipping host MCP server`)
    return null
  }

  // Route the shared host MCP server's debug logging through this host's logger.
  setMcpHostDebug(deps.diag.bind(null, 'mcp-host'))
  setBrokerInfo(deps.brokerUrl, deps.brokerSecret, false)
  setDialogCwd(deps.cwd)

  const { callbacks, pending } = buildDaemonMcpCallbacks(deps)
  setBrokerRpcSender(msg => deps.transport.send(msg))
  initMcpChannel(callbacks, {
    ccSessionId: deps.getCcSessionId() || deps.conversationId,
    conversationId: deps.conversationId,
    cwd: deps.cwd,
    headless: false,
    claudeVersion: deps.claudeVersion,
  })

  const server = bindMcpServer(port, deps.log)
  return {
    pending,
    stop() {
      setBrokerRpcSender(null)
      server?.stop(true)
      void closeMcpChannel()
    },
  }
}
