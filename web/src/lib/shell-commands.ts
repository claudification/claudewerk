/**
 * Host-shell wire commands + pure helpers.
 *
 * One place for every `shell_*` message the dashboard sends, plus the small
 * pure functions (id generation, title/uri derivation) the dock/pane/chord all
 * share. Keeping the senders here -- rather than scattering `wsSend('shell_...')`
 * across components -- means the wire contract has a single, testable surface.
 *
 * Routing keys are `projectUri` / `shellId` only. The broker derives the
 * sentinel + permission boundary from `projectUri`; the frontend never needs a
 * sentinelId to drive a shell.
 */

import type { ShellRosterEntry } from '@shared/protocol'
import { wsSend } from '@/hooks/use-conversations'
import { projectPath } from '@/lib/types'

/** Fresh, collision-resistant shell id. `sh_` + 10 base36 chars. */
export function generateShellId(): string {
  const rand = Math.random().toString(36).slice(2, 12).padEnd(10, '0')
  return `sh_${rand}`
}

/** Human title for a shell tile: explicit title, else the path basename, else
 *  a short id. Pure -- shared by the dock tile + popout document.title. */
export function shellTitle(entry: Pick<ShellRosterEntry, 'title' | 'path' | 'shellId'>): string {
  if (entry.title?.trim()) return entry.title.trim()
  const base = basename(entry.path)
  if (base) return base
  return entry.shellId.slice(0, 8)
}

/** Last path segment (basename), '' for empty/root. Pure. */
export function basename(path: string | undefined): string {
  if (!path) return ''
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Display path for a shell (the cwd / project root it runs in). */
export function shellDisplayPath(entry: Pick<ShellRosterEntry, 'path' | 'projectUri'>): string {
  return entry.path || projectPath(entry.projectUri) || ''
}

/** Tailwind background class for a shell's activity light. Pure -- factored out
 *  of the component so the (branchy) precedence is unit-tested:
 *  flash (just emitted) > subscribed (watching) > idle-with-history > never. */
export function shellLightClass(flash: boolean, subscribed: boolean, hasActivity: boolean): string {
  if (flash) return 'bg-amber-300'
  if (subscribed) return 'bg-emerald-500/60'
  if (hasActivity) return 'bg-amber-500/50'
  return 'bg-white/20'
}

// ─── wire senders ─────────────────────────────────────────────────────────────

export interface OpenShellArgs {
  projectUri: string
  cols: number
  rows: number
  title?: string
  /** UI-grouping + transcript-receipt only; the shell is NOT owned by it. */
  conversationId?: string
  /** Override the generated id (tests / deterministic flows). */
  shellId?: string
}

/** Open a host shell. Returns the shellId used so the caller can optimistically
 *  expand it once the roster `shell_added` lands. */
export function openShell(args: OpenShellArgs): string {
  const shellId = args.shellId ?? generateShellId()
  wsSend('shell_open', {
    projectUri: args.projectUri,
    shellId,
    cols: args.cols,
    rows: args.rows,
    ...(args.title ? { title: args.title } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
  })
  return shellId
}

/** Expand == subscribe. Broker replays the ring buffer, then streams live. */
export function subscribeShell(shellId: string, cols: number, rows: number): void {
  wsSend('shell_subscribe', { shellId, cols, rows })
}

/** Minimize / detach == unsubscribe. Bytes stop; tile + light remain. */
export function unsubscribeShell(shellId: string): void {
  wsSend('shell_unsubscribe', { shellId })
}

/** Keystrokes. Broker write-gates before forwarding to the sentinel. */
export function inputShell(shellId: string, data: string): void {
  wsSend('shell_input', { shellId, data })
}

/** Your viewport size; broker reduces to the min across all viewers. */
export function resizeShell(shellId: string, cols: number, rows: number): void {
  wsSend('shell_resize', { shellId, cols, rows })
}

/** Kill the shell. Broker write-gates before routing to the sentinel. */
export function closeShell(shellId: string): void {
  wsSend('shell_close', { shellId })
}
