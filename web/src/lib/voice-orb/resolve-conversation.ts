/**
 * Turning a SPOKEN conversation name into an actual conversation.
 *
 * One matcher for both client-local verbs (`control_screen` navigate and
 * `say_to_conversation`), because "which conversation did he mean" must not
 * have two answers -- navigating to one and talking to another would be the
 * worst possible bug here.
 *
 * Speech loses punctuation and case, so matching is loose; but a TIE refuses
 * rather than picking, and the caller turns that into a spoken question.
 *
 * A PROJECT is matched by the name the user SAYS -- its display label, or the
 * URI's last path segment when it has none. The raw `claude://` URI is never a
 * haystack: every conversation's URI shares the scheme, the authority and the
 * home path, so matching it made "claude", "default", "jonas" and "projects"
 * hit the entire fleet at once (the matcher then refused every one of them as
 * ambiguous), while the only name he has ever said out loud -- "CLAUDEWERK",
 * "Scratch/Temp" -- scored zero.
 */

import { rankSpoken } from './rank-spoken'

export interface Candidate {
  conversationId: string
  title: string
  project: string
  /** The project's display label, when it has one. Absent = fall back to the URI basename. */
  projectLabel?: string
}

export type Resolution = { ok: true; conversation: Candidate } | { ok: false; error: string; candidates: Candidate[] }

/** Speech drops punctuation, spacing and case: "Scratch/Temp" is said "scratch temp". */
function spoken(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Last path segment of a project URI -- the human name when the project is unlabeled. */
function uriBasename(uri: string): string {
  const segments = uri.split('/').filter(Boolean)
  const last = segments.pop() ?? ''
  // A URI with an empty path splits to just the "scheme:" token -- not a name.
  return last.endsWith(':') ? '' : last
}

/** The name(s) this conversation's project actually goes by. */
function projectNames(c: Candidate): string[] {
  return [c.projectLabel ?? '', uriBasename(c.project)].filter(Boolean)
}

/** Rank a conversation against a spoken target. 0 = no match. */
function score(c: Candidate, needle: string, loose: string): number {
  if (c.conversationId === needle) return 100
  const title = c.title.toLowerCase()
  if (title === needle) return 90
  if (title.includes(needle)) return 70
  // Spoken titles lose punctuation ("transcript perf" vs "transcript-perf").
  if (loose && spoken(title).includes(loose)) return 60
  if (loose && projectNames(c).some(name => spoken(name).includes(loose))) return 50
  return 0
}

/** Resolve a spoken name against the live conversations. */
export function resolveSpokenConversation(spokenName: string, live: Candidate[]): Resolution {
  const needle = spokenName.trim().toLowerCase()
  if (!needle) return { ok: false, error: 'no conversation named', candidates: live.slice(0, 5) }
  const loose = spoken(needle)

  // Same refusal rule as the option matcher -- a tie is not a decision.
  const { ranked, winner, tied } = rankSpoken(live, c => score(c, needle, loose))
  if (tied) return { ok: false, error: `"${spokenName}" is ambiguous -- ask which one`, candidates: ranked.slice(0, 4) }
  if (!winner) return { ok: false, error: `nothing live matches "${spokenName}"`, candidates: live.slice(0, 5) }
  return { ok: true, conversation: winner }
}
