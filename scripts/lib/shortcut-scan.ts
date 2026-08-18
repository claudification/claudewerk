/**
 * Static scanner for keybinding declarations -- the pure half of
 * `scripts/lint-shortcuts.ts`, split out so it can be tested without executing
 * the CLI (which walks the repo and calls process.exit on import).
 *
 * WHY IT EXISTS (2026-08-18): Pulse shipped bound to `mod+k p`, a chord the
 * Kanban board already owned, and nothing complained. The runtime check only
 * looked for prefix conflicts, and a runtime warning nobody reads is not a gate.
 */

/** useChordCommand registers the modern leader AND a legacy one -- see
 *  web/src/lib/commands.ts. A collision on either is a real collision. */
export const CHORD_LEADERS = ['mod+k', 'mod+g'] as const

export interface Binding {
  shortcut: string
  commandId: string
  file: string
  line: number
}

export interface DuplicateCollision {
  kind: 'duplicate'
  shortcut: string
  bindings: Binding[]
}

export interface PrefixCollision {
  kind: 'prefix'
  shortcut: string
  binding: Binding
  shadowedBy: Binding[]
}

export type Collision = DuplicateCollision | PrefixCollision

/** `useCommand` + its own `-legacy` twin are ONE command, not a collision. */
const baseId = (id: string) => id.replace(/-legacy$/, '')

/**
 * Substring of `src` covering the balanced parens of a call whose opening paren
 * is at `from`. Quote-aware, so a paren inside a string literal (and there are
 * plenty -- shortcut values, labels) cannot unbalance the scan.
 */
// fallow-ignore-next-line complexity -- a character scanner is branchy by nature; covered by shortcut-scan.test.ts (bun), which fallow's coverage estimate does not see for scripts/
export function callBody(src: string, from: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return src.slice(from, i + 1)
  }
  return src.slice(from)
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

/** Every binding declared by `useCommand` / `useChordCommand` in one source file. */
// fallow-ignore-next-line complexity -- source parser; 7 cases pinned in shortcut-scan.test.ts (bun), invisible to fallow's coverage estimate for scripts/
export function scanBindings(src: string, file = '<source>'): Binding[] {
  const found: Binding[] = []
  const callRe = /\b(useCommand|useChordCommand)\s*\(/g

  let m: RegExpExecArray | null = callRe.exec(src)
  while (m) {
    const body = callBody(src, callRe.lastIndex - 1)
    const line = lineOf(src, m.index)
    const commandId = /^\(\s*['"]([^'"]+)['"]/.exec(body)?.[1] ?? '<dynamic>'

    if (m[1] === 'useChordCommand') {
      const key = /\bkey:\s*['"]([^'"]+)['"]/.exec(body)?.[1]
      // One declaration, two registrations -- both can collide.
      if (key) for (const leader of CHORD_LEADERS) found.push({ shortcut: `${leader} ${key}`, commandId, file, line })
    } else {
      const shortcut = /\bshortcut:\s*['"]([^'"]+)['"]/.exec(body)?.[1]
      if (shortcut) found.push({ shortcut, commandId, file, line })
    }
    m = callRe.exec(src)
  }
  return found
}

export interface KnownCollisions {
  duplicates?: Set<string>
  prefixes?: Set<string>
}

/**
 * Every collision in a binding set.
 *
 *   duplicate -- two commands claim the identical binding; the last registered
 *                silently wins.
 *   prefix    -- a binding that is also the start of a longer chord, so it can
 *                only fire on timeout.
 */
// fallow-ignore-next-line complexity -- two collision kinds in one pass; 8 cases pinned in shortcut-scan.test.ts (bun), invisible to fallow's coverage estimate for scripts/
export function findCollisions(bindings: Binding[], known: KnownCollisions = {}): Collision[] {
  const collisions: Collision[] = []

  const byShortcut = new Map<string, Binding[]>()
  for (const b of bindings) {
    const list = byShortcut.get(b.shortcut) ?? []
    list.push(b)
    byShortcut.set(b.shortcut, list)
  }

  for (const [shortcut, list] of byShortcut) {
    if (known.duplicates?.has(shortcut)) continue
    if (new Set(list.map(b => baseId(b.commandId))).size < 2) continue
    collisions.push({ kind: 'duplicate', shortcut, bindings: list })
  }

  for (const binding of bindings) {
    if (known.prefixes?.has(binding.shortcut)) continue
    const shadowedBy = bindings.filter(
      o => baseId(o.commandId) !== baseId(binding.commandId) && o.shortcut.startsWith(`${binding.shortcut} `),
    )
    if (shadowedBy.length) collisions.push({ kind: 'prefix', shortcut: binding.shortcut, binding, shadowedBy })
  }

  return collisions
}

/** Human-readable failure report. */
// fallow-ignore-next-line complexity -- report rendering; covered by shortcut-scan.test.ts (bun), invisible to fallow's coverage estimate for scripts/
export function formatCollisions(collisions: Collision[]): string {
  const out: string[] = []
  for (const c of collisions) {
    if (c.kind === 'duplicate') {
      out.push(`  DUPLICATE  ${c.shortcut}`)
      for (const b of c.bindings) out.push(`    ${b.commandId.padEnd(28)} ${b.file}:${b.line}`)
    } else {
      out.push(`  PREFIX     ${c.shortcut} (${c.binding.commandId}) can never fire -- shadowed by:`)
      for (const s of c.shadowedBy) out.push(`    ${s.shortcut.padEnd(14)} ${s.commandId}`)
    }
    out.push('')
  }
  return out.join('\n')
}
