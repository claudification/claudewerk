/**
 * CM6 autocomplete for slash commands, @ mentions, and : session refs.
 *
 * Triggers:
 *   - `/` at start of doc OR after whitespace -> builtin commands + CC's slashCommands
 *   - `@` at start of doc OR after whitespace -> skills + agents
 *   - `:` at start of doc OR after whitespace -> session slugs (live sessions)
 *
 * Source data is read live from the sessions store at completion time, so the
 * extension doesn't need rebuilding when sessionInfo changes.
 *
 * Also handles `/model <variant>` argument completion via a shared helper.
 * Other sub-command arg completers (e.g. /workon <task>) stay legacy-only
 * for now — they require React-scoped context (project tasks, selected
 * session) and side-effecting onSelect callbacks.
 *
 * Colon trigger rules (parity with `text: prose` natural usage):
 *   - `:` + slug-chars -> popup active, narrows as you type
 *   - `: ` (space after) -> dismisses, natural "foo: bar" prose works
 *   - `::` (double colon) -> dismisses, "::" would never be a session ref
 *   - Accepting a session replaces the whole `:query` with just the slug
 *     (e.g. typing `:arr<Tab>` yields `arr`, not `:arr`).
 */

import {
  acceptCompletion,
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  completionStatus,
} from '@codemirror/autocomplete'
import { type Extension, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { useSessionsStore } from '@/hooks/use-sessions'
import { lastPathSegments, projectDisplayName, sessionAddressableSlug } from '@/lib/utils'
import { BUILTIN_COMMAND_NAMES, BUILTIN_SCORE_BOOST, completeModelArg, fuzzyScore } from '../../autocomplete-shared'

interface SourceInfo {
  slashCommands: string[]
  skills: string[]
  agents: string[]
}

const EMPTY_INFO: SourceInfo = { slashCommands: [], skills: [], agents: [] }

function readSourceInfo(): SourceInfo {
  const state = useSessionsStore.getState()
  const sid = state.selectedSessionId
  return (sid ? state.sessionInfo[sid] : null) ?? EMPTY_INFO
}

function isInsideCodeFence(text: string): boolean {
  if ((text.match(/`/g) || []).length % 2 !== 0) return true
  if (text.includes('```') && (text.match(/```/g) || []).length % 2 !== 0) return true
  return false
}

function buildCompletions(trigger: '/' | '@', query: string, atDocStart: boolean, info: SourceInfo) {
  const scored: Array<{ label: string; detail?: string; score: number }> = []

  function add(name: string, detail: string | undefined, boost = 1) {
    const s = fuzzyScore(query, name) * boost
    if (s > 0) scored.push({ label: name, detail, score: s })
  }

  if (trigger === '/') {
    // Builtins only suggested at start of input (parity with legacy).
    // Boosted so they rank above CC's slashCommands at otherwise-equal scores.
    if (atDocStart) {
      for (const name of BUILTIN_COMMAND_NAMES) add(name, 'builtin', BUILTIN_SCORE_BOOST)
    }
    for (const name of info.slashCommands) {
      if (BUILTIN_COMMAND_NAMES.includes(name as (typeof BUILTIN_COMMAND_NAMES)[number])) continue
      add(name, undefined)
    }
  } else {
    for (const name of info.skills) add(name, 'skill')
    for (const name of info.agents) add(name, 'agent')
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 12).map(x => ({ label: x.label, detail: x.detail }))
}

/**
 * Sub-command argument completion: `/model <variant>` at start of doc.
 *
 * Matches legacy semantics (markdown-input.tsx SUB_COMMANDS['model']):
 * - query is everything after `/model\s+` up to end of doc
 * - selecting a value replaces the whole arg region with the chosen id
 * - exact match suppresses the popup so Enter submits `/model <id>` as-is
 */
function subCommandArgCompletion(text: string, docLength: number): CompletionResult | null {
  const m = text.match(/^\/(\S+)(\s+)/)
  if (!m) return null
  if (m[1].toLowerCase() !== 'model') return null // only /model for now
  const prefixLen = m[0].length
  const rest = text.slice(prefixLen)
  if (rest.includes('\n')) return null

  const query = rest.trim()
  const options = completeModelArg(query)
  if (options.length === 0) return null

  // Exact match: drop popup so Enter submits `/model <id>` verbatim.
  if (options.some(o => o.toLowerCase() === query.toLowerCase())) return null

  return {
    from: prefixLen,
    to: docLength,
    options: options.map(label => ({ label, detail: 'model' })),
    filter: false,
  }
}

/**
 * Scan backwards for a `:` session trigger. Uses a stricter char class than
 * the /-and-@ scanner (no `:`, no `.`) so that `::` and `foo:bar` don't
 * accidentally activate the session popup — only `:slug` does.
 */
function scanColonTrigger(text: string, pos: number): { start: number; query: string } | null {
  let start = pos - 1
  while (start >= 0 && /[a-zA-Z0-9_-]/.test(text[start])) start--
  if (start < 0) return null
  if (text[start] !== ':') return null
  // Must be at doc start or preceded by whitespace (prose like "note: foo" stays inert).
  if (start > 0 && !/\s/.test(text[start - 1])) return null
  const query = text.slice(start + 1, pos)
  if (query.includes(' ') || query.includes('\n')) return null
  return { start, query }
}

interface SessionCompletion {
  label: string // what gets inserted (the session id)
  displayLabel: string // what the user sees (project label or id)
  detail: string // right-aligned: session name + status
  info: string // hover tooltip: full cwd
}

function sessionCompletions(query: string): SessionCompletion[] {
  const state = useSessionsStore.getState()
  const { sessions, projectSettings } = state
  const q = query.toLowerCase()
  const scored: Array<{ opt: SessionCompletion; score: number }> = []

  // Pre-count sessions per cwd so the addressable-slug helper knows when to
  // use the bare project slug vs the compound `project:name` form.
  const cwdCounts: Record<string, number> = {}
  for (const s of sessions) if (s.status !== 'ended') cwdCounts[s.cwd] = (cwdCounts[s.cwd] || 0) + 1

  for (const session of sessions) {
    if (session.status === 'ended') continue
    // For un-labelled projects, fall back to the cwd tail (same convention
    // the sidebar + command-palette session rows use). session.id is a UUID,
    // so never display it as a name.
    const displayLabel = projectDisplayName(session.cwd, projectSettings[session.cwd]?.label)
    const name = session.title || session.agentName || ''
    // The insertable slug — approximates list_sessions' addressable ID,
    // e.g. `arr` (bare) or `arr:viral-zebra` (compound) when the project
    // hosts multiple live sessions.
    const slug = sessionAddressableSlug(session, projectSettings, cwdCounts[session.cwd] || 1)
    // Match against display name, the slug, and agent/title so "ola",
    // "OLA", "raccoon", and "arr:viral" all find the expected session.
    const haystack = `${displayLabel} ${slug} ${name}`
    const score = fuzzyScore(q, haystack)
    if (score <= 0) continue
    scored.push({
      opt: {
        label: slug,
        displayLabel,
        detail: name ? `${name} · ${session.status}` : session.status,
        info: lastPathSegments(session.cwd, 3),
      },
      score,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 12).map(s => s.opt)
}

function sessionArgCompletion(text: string, pos: number): CompletionResult | null {
  const hit = scanColonTrigger(text, pos)
  if (!hit) return null
  if (isInsideCodeFence(text.slice(0, hit.start))) return null
  const options = sessionCompletions(hit.query)
  if (options.length === 0) return null
  return {
    from: hit.start, // replace the leading `:` too — inserted text is the bare slug
    to: pos,
    options,
    filter: false,
  }
}

function completionSource(context: CompletionContext): CompletionResult | null {
  const pos = context.pos
  const doc = context.state.doc
  const text = doc.toString()

  // Sub-command arg completion takes precedence when the doc is `/cmd <args>`.
  const subResult = subCommandArgCompletion(text, doc.length)
  if (subResult) return subResult

  // `:` session trigger — independent scan (different char class).
  const sessionResult = sessionArgCompletion(text, pos)
  if (sessionResult) return sessionResult

  // Scan backwards from cursor to find a word starting with / or @
  let start = pos - 1
  while (start >= 0 && /[a-zA-Z0-9_:-]/.test(text[start])) start--
  if (start < 0) return null

  const ch = text[start]
  if (ch !== '/' && ch !== '@') return null

  // Trigger char must be at start of doc or preceded by whitespace
  if (start > 0 && !/[\s\n]/.test(text[start - 1])) return null

  // Skip if inside code fence (preserves intent when typing markdown code)
  if (isInsideCodeFence(text.slice(0, start))) return null

  const query = text.slice(start + 1, pos)
  if (query.includes(' ') || query.includes('\n')) return null

  // Don't pop up unless explicitly triggered or actively typing identifier chars
  if (!context.explicit && query.length === 0 && pos !== start + 1) return null

  const trigger = ch as '/' | '@'
  const atDocStart = start === 0
  const info = readSourceInfo()

  // Exact-match short-circuit: if the query already is a full command name,
  // accepting would be a no-op (CM backend doesn't do arg completers, per
  // Phase 2b scope). Suppressing the popup lets Enter fall through to our
  // submit keymap so `/exit`, `/clear`, `/model` etc. submit as typed.
  if (trigger === '/' && query.length > 0) {
    const q = query.toLowerCase()
    const builtinMatch = atDocStart && BUILTIN_COMMAND_NAMES.some(n => n === q)
    const ccMatch = info.slashCommands.some(n => n.toLowerCase() === q)
    if (builtinMatch || ccMatch) return null
  }

  const options = buildCompletions(trigger, query, atDocStart, info)

  if (options.length === 0) return null

  return {
    from: start + 1, // replace just the query, leave the trigger char in place
    to: pos,
    options,
    filter: false, // we already scored + sorted
  }
}

/**
 * Explicit Tab -> acceptCompletion at high precedence. The autocompletion
 * extension's defaultKeymap already binds Tab, but our extensions array
 * also includes @codemirror/commands' defaultKeymap which binds Tab to
 * indentMore. Pinning our binding above both guarantees Tab accepts when
 * the popup is showing, and falls through (false) otherwise so indent
 * still works in code-fenced contexts.
 */
const tabAcceptKeymap = Prec.highest(
  keymap.of([
    {
      key: 'Tab',
      run: view => {
        if (completionStatus(view.state) === 'active') return acceptCompletion(view)
        return false
      },
    },
  ]),
)

export function autocompleteExtension(): Extension {
  return [
    tabAcceptKeymap,
    autocompletion({
      override: [completionSource],
      activateOnTyping: true,
      closeOnBlur: true,
      icons: false,
      defaultKeymap: true, // arrows + enter + tab to accept (we re-pin Tab above for safety)
    }),
  ]
}
