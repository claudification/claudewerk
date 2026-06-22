/**
 * Concierge briefing (the `converse` disposition's answer).
 *
 * When the classifier decides the user is talking TO the front desk -- a
 * greeting, "what's going on?", a quick status question -- the dispatcher does
 * not spawn or route. It ANSWERS. This is that answer: one cheap LLM call over
 * the live roster + the dispatcher's near-memory threads, returning a short,
 * spoken-feeling reply.
 *
 * Pure + injectable (the `ChatFn` comes in), so it unit-tests without network.
 * The runtime wires the real `chat` + threads source.
 */

import type { DispatchThread } from '../../shared/protocol'
import type { ChatFn, DispatchRosterEntry } from './classify'

export const BRIEF_MODEL = 'anthropic/claude-haiku-4.5'

export interface BriefInput {
  intent: string
  roster: DispatchRosterEntry[]
  threads: DispatchThread[]
}

const BRIEF_SYSTEM = [
  "You are the user's front-desk concierge for a fleet of coding conversations.",
  'The user is talking to you directly -- greeting you, asking what is going on,',
  'or asking a quick status question. Answer in 1-3 short sentences: warm, plain,',
  'and terse, the way a good assistant speaks out loud. Ground every claim in the',
  'ROSTER (live/ended conversations) and THREADS (your near-memory) below. If',
  'nothing is active, say so plainly and invite them to start something. Never',
  'invent conversations or work. No markdown headers or lists -- just talk.',
].join('\n')

/** Generate the concierge's spoken reply for a `converse` decision. */
export async function generateBriefing(input: BriefInput, chat: ChatFn): Promise<string> {
  const roster = input.roster.slice(0, 30).map(e => ({
    project: e.project,
    title: e.title,
    state: e.ended ? 'ended' : (e.liveState ?? 'live'),
    idleMin: e.idleMs !== undefined ? Math.round(e.idleMs / 60000) : undefined,
  }))
  const threads = input.threads.slice(0, 20).map(t => ({ title: t.title, summary: t.summary }))

  const user = [
    `USER SAID:\n${input.intent}`,
    `ROSTER (active/ended conversations):\n${JSON.stringify(roster, null, 2)}`,
    `THREADS (your near-memory):\n${JSON.stringify(threads, null, 2)}`,
  ].join('\n\n')

  const res = await chat({
    model: BRIEF_MODEL,
    system: BRIEF_SYSTEM,
    user,
    maxTokens: 300,
    temperature: 0.3,
    timeoutMs: 20_000,
    timeoutRetries: 1,
  })
  return res.content.trim()
}

/** Deterministic fallback when no LLM briefer is wired (tests / chat down). */
export function briefFallback(roster: DispatchRosterEntry[]): string {
  const live = roster.filter(r => !r.ended).length
  if (live === 0) {
    return "Nothing's on my desk right now -- no active conversations. Tell me what you'd like to start."
  }
  return `I'm holding ${live} active conversation${live === 1 ? '' : 's'} right now. Ask me about any of them, or tell me what's next.`
}
