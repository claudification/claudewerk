/**
 * Web Debug Control -- host-shell terminal ops (client side).
 *
 * The agent drives host shells DETACHED: terminal_start/attach mount the shell
 * off-screen (AgentShellHost) so it subscribes + becomes readable without ever
 * popping the fullscreen overlay. write goes straight over the wire (no pane
 * needed); read/screenshot use the off-screen xterm via the registry.
 *
 * Each op returns a plain { ok, result?, error? }; the dispatcher sends it back
 * as a web_control_response.
 */

import { useShellsStore } from '@/hooks/use-shells'
import { inputShell, openShell } from '@/lib/shell-commands'
import { captureNodeToUrl } from './web-control-capture'
import { useAgentShellsStore } from './web-control-shells'
import { getXterm } from './xterm-registry'

export interface TermResult {
  ok: boolean
  result?: unknown
  error?: string
}

/** Give a freshly-mounted off-screen pane time to subscribe + receive replay. */
const ATTACH_SETTLE_MS = 1200

function arg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string) : ''
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function terminalList(): TermResult {
  const { roster, subscribed } = useShellsStore.getState()
  const agentAttached = useAgentShellsStore.getState().attached
  const shells = Object.values(roster).map(s => ({
    shellId: s.shellId,
    title: s.title,
    path: s.path,
    projectUri: s.projectUri,
    status: s.status,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    subscribed: !!subscribed[s.shellId],
    agentAttached: !!agentAttached[s.shellId],
    readable: !!getXterm(s.shellId),
  }))
  return { ok: true, result: { shells } }
}

export async function terminalStart(args: Record<string, unknown>): Promise<TermResult> {
  const projectUri = arg(args, 'projectUri')
  if (!projectUri) {
    return {
      ok: false,
      error:
        'terminal_start requires projectUri (claude://sentinel/path). Discover via list_hosts / list_conversations.',
    }
  }
  const cols = Number(args.cols) || 120
  const rows = Number(args.rows) || 32
  const label = arg(args, 'title') || projectUri.split('/').filter(Boolean).pop() || 'shell'
  const title = `[debug] ${label}`
  const shellId = openShell({ projectUri, cols, rows, title })
  useAgentShellsStore.getState().attach(shellId)
  await wait(ATTACH_SETTLE_MS)
  return {
    ok: true,
    result: { shellId, title, note: 'Started detached (off-screen). Use terminal_read / terminal_write by shellId.' },
  }
}

export async function terminalAttach(args: Record<string, unknown>): Promise<TermResult> {
  const shellId = arg(args, 'shellId')
  if (!shellId) return { ok: false, error: 'terminal_attach requires shellId' }
  if (!useShellsStore.getState().roster[shellId]) {
    return { ok: false, error: `Unknown shellId '${shellId}' (not in roster). Use terminal_list.` }
  }
  useAgentShellsStore.getState().attach(shellId)
  await wait(ATTACH_SETTLE_MS)
  return { ok: true, result: { shellId, readable: !!getXterm(shellId), note: 'Attached detached. terminal_read now.' } }
}

export function terminalDetach(args: Record<string, unknown>): TermResult {
  const shellId = arg(args, 'shellId')
  if (!shellId) return { ok: false, error: 'terminal_detach requires shellId' }
  useAgentShellsStore.getState().detach(shellId)
  return { ok: true, result: { shellId, note: 'Detached (off-screen pane unmounted; shell keeps running).' } }
}

export function terminalWrite(args: Record<string, unknown>): TermResult {
  const shellId = arg(args, 'shellId')
  const data = arg(args, 'data')
  if (!shellId) return { ok: false, error: 'terminal_write requires shellId' }
  // Raw write -- the agent appends \n / \r itself to submit (no auto-enter).
  inputShell(shellId, data)
  return { ok: true, result: { shellId, bytes: data.length } }
}

export function terminalRead(args: Record<string, unknown>): TermResult {
  const shellId = arg(args, 'shellId')
  if (!shellId) return { ok: false, error: 'terminal_read requires shellId' }
  const entry = getXterm(shellId)
  if (!entry) {
    return {
      ok: false,
      error: `Shell '${shellId}' is not attached/readable. Call terminal_attach (or terminal_start) first.`,
    }
  }
  const maxLines = Number(args.maxLines) || undefined
  return { ok: true, result: { shellId, text: entry.read({ maxLines }) } }
}

export async function terminalScreenshot(args: Record<string, unknown>): Promise<TermResult> {
  const shellId = arg(args, 'shellId')
  if (!shellId) return { ok: false, error: 'terminal_screenshot requires shellId' }
  const node = getXterm(shellId)?.node()
  if (!node) {
    return { ok: false, error: `Shell '${shellId}' is not attached. Call terminal_attach first.` }
  }
  const { url, error } = await captureNodeToUrl(node, 2)
  if (!url) return { ok: false, error: error ?? 'screenshot failed' }
  return { ok: true, result: { shellId, url } }
}
