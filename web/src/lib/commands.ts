import { useEffect, useRef } from 'react'
import { useKeyLayer } from './key-layers'

// ── Types ──────────────────────────────────────────────────────────────────

type CommandAction = (...args: string[]) => void

export interface Command {
  id: string
  label: string
  shortcut?: string
  action: CommandAction
  when?: () => boolean
  group?: string
  submenu?: string
}

interface UseCommandOptions {
  label?: string
  shortcut?: string
  when?: () => boolean
  group?: string
  submenu?: string
  /**
   * Opt this shortcut OUT of terminal-first ownership: a focused xterm normally
   * swallows every keystroke, but a captureTerminal shortcut still fires (e.g.
   * the command palette -- the universal escape hatch). Default false.
   */
  captureTerminal?: boolean
}

// ── Registry (module singleton) ──────────────────────────────────────────

const commands = new Map<string, Command>()
let generation = 0

function registerCommand(cmd: Command): () => void {
  commands.set(cmd.id, cmd)
  generation++
  return () => {
    commands.delete(cmd.id)
    generation++
  }
}

export function executeCommand(id: string, ...args: string[]): boolean {
  const cmd = commands.get(id)
  if (!cmd) return false
  if (cmd.when && !cmd.when()) return false
  cmd.action(...args)
  return true
}

export function getCommands(): Command[] {
  return Array.from(commands.values()).filter(c => !c.when || c.when())
}

export function getCommandGeneration(): number {
  return generation
}

// ── useCommand hook ─────────────────────────────────────────────────────

export function useCommand(id: string, action: CommandAction, options: UseCommandOptions = {}) {
  const actionRef = useRef(action)
  const whenRef = useRef(options.when)
  actionRef.current = action
  whenRef.current = options.when

  useEffect(() => {
    const cmd: Command = {
      id,
      label: options.label ?? id,
      shortcut: options.shortcut,
      group: options.group,
      submenu: options.submenu,
      action: (...args: string[]) => actionRef.current(...args),
      when: whenRef.current ? () => whenRef.current?.() ?? false : undefined,
    }
    return registerCommand(cmd)
  }, [id, options.label, options.shortcut, options.group, options.submenu])

  useKeyLayer(
    options.shortcut
      ? {
          [options.shortcut]: () => {
            if (whenRef.current && !whenRef.current()) return
            actionRef.current()
          },
        }
      : {},
    { base: true, id: `cmd:${id}`, captureTerminal: options.captureTerminal },
  )
}

// ── useChordCommand helper ──────────────────────────────────────────────

interface UseChordCommandOptions {
  label: string
  /** Chord key after the prefix, e.g. "t" for ⌘K T / ⌘G T. May include spaces for multi-key chords. */
  key: string
  when?: () => boolean
  group?: string
}

/**
 * Register a chord command under BOTH ⌘K and ⌘G prefixes. ⌘K is the
 * primary chord (VSCode-style), ⌘G is a transitional alias so existing
 * muscle memory keeps working during the migration.
 *
 * The palette dedupes commands by label and merges shortcuts into one
 * entry, so users see both bindings next to a single action.
 */
export function useChordCommand(id: string, action: CommandAction, options: UseChordCommandOptions) {
  useCommand(id, action, {
    label: options.label,
    shortcut: `mod+k ${options.key}`,
    when: options.when,
    group: options.group,
  })
  useCommand(`${id}-legacy`, action, {
    label: options.label,
    shortcut: `mod+g ${options.key}`,
    when: options.when,
    group: options.group,
  })
}

// ── Chord validation ───────────────────────────────────────────────────

export interface ChordConflict {
  /** `duplicate` = two commands on the same binding. `prefix` = a binding that
   *  is also the start of a longer chord, so it can never fire. */
  kind: 'duplicate' | 'prefix'
  /** The binding at fault. */
  binding: string
  /** Everyone claiming it (duplicate), or the single owner (prefix). */
  commands: Array<{ id: string; label: string }>
  /** Only for `prefix`: the longer chord(s) shadowing this binding. */
  shadowedBy?: Array<{ shortcut: string; label: string }>
}

type Bindable = { id: string; label: string; shortcut?: string }

/** useChordCommand registers `<id>` and `<id>-legacy` on two leaders. That is
 *  ONE command wearing two bindings, not a collision between two commands. */
const baseId = (id: string) => id.replace(/-legacy$/, '')

/**
 * Find every keybinding collision in a command set.
 *
 * Two kinds, and BOTH matter:
 *
 *   duplicate -- two commands claim the identical binding. Whichever registered
 *     last silently wins. This is how Pulse ended up shadowing the Kanban board
 *     on `mod+k p` (2026-08-18) with nothing complaining; the old version of
 *     this function only looked for prefixes and never saw it.
 *
 *   prefix -- "mod+g s" (spawn) vs "mod+g s e" (a sub-action): pressing S enters
 *     chord mode waiting for the next key instead of firing spawn.
 *
 * Pure and parameterised so it can be tested without a populated registry;
 * `validateChordBindings()` is the thin wrapper over the module singleton.
 */
export function findChordConflicts(all: Bindable[]): ChordConflict[] {
  const bound = all.filter((c): c is Bindable & { shortcut: string } => !!c.shortcut)
  const conflicts: ChordConflict[] = []

  // ── duplicates ──
  const byShortcut = new Map<string, typeof bound>()
  for (const cmd of bound) {
    const list = byShortcut.get(cmd.shortcut) ?? []
    list.push(cmd)
    byShortcut.set(cmd.shortcut, list)
  }
  for (const [binding, list] of byShortcut) {
    if (new Set(list.map(c => baseId(c.id))).size < 2) continue
    conflicts.push({
      kind: 'duplicate',
      binding,
      commands: list.map(c => ({ id: c.id, label: c.label })),
    })
  }

  // ── prefixes (chords only -- a plain shortcut has no continuation) ──
  for (const cmd of bound.filter(c => c.shortcut.includes(' '))) {
    const shadowedBy = bound
      .filter(o => baseId(o.id) !== baseId(cmd.id) && o.shortcut.startsWith(`${cmd.shortcut} `))
      .map(o => ({ shortcut: o.shortcut, label: o.label }))
    if (shadowedBy.length) {
      conflicts.push({
        kind: 'prefix',
        binding: cmd.shortcut,
        commands: [{ id: cmd.id, label: cmd.label }],
        shadowedBy,
      })
    }
  }

  return conflicts
}

/** Conflicts across the live command registry. */
export function validateChordBindings(): ChordConflict[] {
  return findChordConflicts(Array.from(commands.values()))
}

/**
 * One conflict as a human-readable warning. Separate from the toast so the
 * wording is testable -- a warning that says the wrong thing is worse than none.
 */
export function describeChordConflict(c: ChordConflict, format: (s: string) => string = formatShortcut): string {
  if (c.kind === 'duplicate') {
    const names = c.commands.map(cmd => `"${cmd.label}"`).join(', ')
    return `${format(c.binding)} is claimed by ${c.commands.length} commands: ${names} -- only the last one registered will fire`
  }
  const longer = (c.shadowedBy ?? []).map(l => format(l.shortcut)).join(', ')
  return `"${c.commands[0]?.label}" (${format(c.binding)}) is also a prefix of: ${longer} -- it will only fire on timeout`
}

// ── Formatting helpers ──────────────────────────────────────────────────

const isMac =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent))

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
