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
 */

export interface Candidate {
  conversationId: string
  title: string
  project: string
}

export type Resolution = { ok: true; conversation: Candidate } | { ok: false; error: string; candidates: Candidate[] }

/** Rank a conversation against a spoken target. 0 = no match. */
function score(c: Candidate, needle: string): number {
  if (c.conversationId === needle) return 100
  const title = c.title.toLowerCase()
  const project = c.project.toLowerCase()
  if (title === needle) return 90
  if (title.includes(needle)) return 70
  // Spoken titles lose punctuation ("transcript perf" vs "transcript-perf").
  const loose = needle.replace(/[\s\-_]+/g, '')
  if (loose && title.replace(/[\s\-_]+/g, '').includes(loose)) return 60
  if (project.includes(needle)) return 50
  return 0
}

/** Resolve a spoken name against the live conversations. */
export function resolveSpokenConversation(spoken: string, live: Candidate[]): Resolution {
  const needle = spoken.trim().toLowerCase()
  if (!needle) return { ok: false, error: 'no conversation named', candidates: live.slice(0, 5) }

  const ranked = live
    .map(c => ({ c, s: score(c, needle) }))
    .filter(r => r.s > 0)
    .sort((a, b) => b.s - a.s)

  const best = ranked[0]
  if (!best) return { ok: false, error: `nothing live matches "${spoken}"`, candidates: live.slice(0, 5) }

  const runnerUp = ranked[1]
  if (runnerUp && runnerUp.s === best.s) {
    return {
      ok: false,
      error: `"${spoken}" is ambiguous -- ask which one`,
      candidates: ranked.slice(0, 4).map(r => r.c),
    }
  }
  return { ok: true, conversation: best.c }
}
