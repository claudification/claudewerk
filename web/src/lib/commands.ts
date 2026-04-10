import { useEffect, useRef } from 'react'
import { useKeyLayer } from './key-layers'

// ── Types ──────────────────────────────────────────────────────────────────

export interface Command {
  id: string
  label: string
  shortcut?: string
  action: () => void
  when?: () => boolean
  /** Group for palette display (e.g. 'Session', 'View', 'Navigation') */
  group?: string
}

interface UseCommandOptions {
  label?: string
  shortcut?: string
  when?: () => boolean
  group?: string
}

// ── Registry (module singleton) ──────────────────────────────────────────

const commands = new Map<string, Command>()
let generation = 0 // bumped on every change so React can detect updates

export function registerCommand(cmd: Command): () => void {
  commands.set(cmd.id, cmd)
  generation++
  return () => {
    commands.delete(cmd.id)
    generation++
  }
}

export function executeCommand(id: string): boolean {
  const cmd = commands.get(id)
  if (!cmd) return false
  if (cmd.when && !cmd.when()) return false
  cmd.action()
  return true
}

export function getCommands(): Command[] {
  return Array.from(commands.values()).filter(c => !c.when || c.when())
}

export function getCommandGeneration(): number {
  return generation
}

// ── useCommand hook ─────────────────────────────────────────────────────

export function useCommand(id: string, action: () => void, options: UseCommandOptions = {}) {
  const actionRef = useRef(action)
  const whenRef = useRef(options.when)
  actionRef.current = action
  whenRef.current = options.when

  // Register/unregister command on mount/unmount
  useEffect(() => {
    const cmd: Command = {
      id,
      label: options.label ?? id,
      shortcut: options.shortcut,
      group: options.group,
      action: () => actionRef.current(),
      when: whenRef.current ? () => whenRef.current!() : undefined,
    }
    const unregister = registerCommand(cmd)
    return unregister
    // Only re-register if identity-level props change (id, label, shortcut, group)
    // action/when are synced via refs
  }, [id, options.label, options.shortcut, options.group])

  // If the command has a shortcut, register it on the base key layer
  useKeyLayer(
    options.shortcut
      ? {
          [options.shortcut]: () => {
            if (whenRef.current && !whenRef.current()) return
            actionRef.current()
          },
        }
      : {},
    { base: true, id: `cmd:${id}` },
  )
}

// ── Formatting helpers ──────────────────────────────────────────────────

const isMac =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent))

/** Format a shortcut string for display (e.g. 'mod+k' -> '⌘K' on Mac, 'Ctrl+K' elsewhere) */
export function formatShortcut(shortcut: string): string {
  return shortcut
    .split(' ')
    .map(part =>
      part
        .split('+')
        .map(k => {
          if (k === 'mod') return isMac ? '⌘' : 'Ctrl'
          if (k === 'ctrl') return isMac ? '⌃' : 'Ctrl'
          if (k === 'alt') return isMac ? '⌥' : 'Alt'
          if (k === 'shift') return isMac ? '⇧' : 'Shift'
          if (k === 'meta') return isMac ? '⌘' : 'Win'
          if (k.length === 1) return k.toUpperCase()
          return k
        })
        .join(isMac ? '' : '+'),
    )
    .join(' ')
}
