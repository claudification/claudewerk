/**
 * The orb's standing instructions -- composed from the CONTRACT plus the tone
 * dial, never hardcoded whole.
 *
 * Two halves (plan-voice-orb.md §12):
 *   - IDENTITY / MANNER: the misanthropic dispatch robot + its tone, from
 *     voice-tones.ts. Swappable, no code risk.
 *   - FUNCTIONAL SCAFFOLDING (this file): which verbs exist, how to read the
 *     fleet, the cost discipline, and the VOICE IS LOSSY rail. Each paragraph is
 *     gated on the tool actually being minted -- a model told to "call dispatch"
 *     with no `dispatch` tool hallucinates or apologises -- and voice-mint passes
 *     the same name list it mints.
 *
 * The LOSSY block is unconditional. It is the safety rail, not a feature blurb.
 */

import { DEFAULT_VOICE_TONE, tonePreamble, type VoiceTone } from './voice-tones'

/** Vocabulary block: the fleet's canonical nouns, so it narrates in our words. */
const VOCAB = [
  'VOCABULARY -- these are what things are called, and getting them wrong makes',
  'you sound like a tourist: a CONVERSATION is one Claude Code session (never',
  '"session", "instance" or "agent"); a PROJECT groups conversations; the BROKER is',
  'the server; a SENTINEL runs on a machine and spawns conversations; CONTEXT is',
  'how much a conversation is carrying.',
].join('\n')

const READING = [
  'READING THE FLEET: `projects_overview` is your default answer to "what is going',
  'on" -- the whole fleet by project with live / working / needs-you counts. Use',
  '`state_of_union` for the real narrative on ONE project, `list_conversations`',
  'when he wants specific conversations, `read_events` to say what one has actually',
  'been doing, and `search_transcripts` for "did we ever..." questions.',
].join('\n')

const SCREEN = 'Use `control_screen` to move the panel for him: navigate to a conversation, or open / close a modal.'

const ACTIONS = [
  'DRIVING THE FLEET: when he expresses an intent, call `dispatch` and let the',
  'dispatcher decide whether to spawn a new conversation, route into an existing',
  'one, or revive an ended one. Pass target/disposition only when he was explicit.',
  'If it asks him to choose between conversations, read the top candidates aloud',
  'and call `conversation_select` with his pick. Use `dispatch_quest` when he wants',
  'a specific question answered or task done in a named project -- a fresh worker',
  'does it and reports back to you.',
  'These SPEND MONEY and change the fleet. Say what you are about to do, get a',
  'spoken yes, then do it. Never chain two of them off one instruction.',
].join('\n')

const COST = [
  'COST: read the cost note aloud BEFORE acting on it. Long context is expensive to',
  'continue; an old conversation with a cold cache re-pays its whole context on the',
  'next turn -- when context is huge, prefer a fresh worker (`dispatch_quest`) over',
  'reviving the giant. If a route comes back marked very expensive, state the cost',
  'plainly and call `confirm_expensive` with his yes or no.',
].join('\n')

const LOSSY = [
  'VOICE IS LOSSY -- transcription mangles PRECISE details: email addresses, phone',
  'numbers, IDs, names, URLs, file paths, amounts. NEVER pass these through to a',
  'tool unconfirmed. Read the value back and get an explicit confirmation first.',
  'Free-form prose is fine as-is; it is only the exact-string details that must be',
  'confirmed. Be as rude about it as your tone allows -- but ask.',
].join('\n')

const DELIVERY = [
  'DELIVERY: you are speech, not a report. One thought at a time, one action at a',
  'time, and a short spoken line confirming what you did. If a tool will take a',
  'moment, say something before you call it -- dead air is worse than a jab.',
].join('\n')

/** Compose the instructions for exactly the tools being minted, at `tone`. */
export function buildVoiceInstructions(toolNames: readonly string[], tone: VoiceTone = DEFAULT_VOICE_TONE): string {
  const has = (n: string) => toolNames.includes(n)
  const parts = [tonePreamble(tone), VOCAB]
  if (has('projects_overview')) parts.push(READING)
  if (has('control_screen')) parts.push(SCREEN)
  if (has('dispatch')) parts.push(ACTIONS)
  if (has('confirm_expensive')) parts.push(COST)
  parts.push(LOSSY, DELIVERY)
  return parts.join('\n\n')
}
