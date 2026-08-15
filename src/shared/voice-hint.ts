/**
 * The reading hint attached to a DICTATED prompt, and the matching strip used to
 * take it back off for display.
 *
 * Provenance travels the wire as a structured `source` field (`InputSource` in
 * protocol.ts) -- that is what the agent host reads and it is the only thing that
 * decides BEHAVIOUR. This module is the one place the flag turns into words, at
 * the last hop before the prompt reaches the model.
 *
 * WHY THE TEXT MARKER EXISTS AT ALL, given the wire field is structured: the
 * rendered transcript is not ours. It is Claude Code's own JSONL, replayed, and
 * that file only ever contains text -- there is nowhere in it to hang a
 * structured field, and no id to join a broker-side record back to. So for a
 * dictation to still LOOK dictated after a reload, the marker has to survive
 * inside the prompt. The control panel strips it again on the way out
 * (`stripInputSourceHint`), which is also how it knows to render the bubble as
 * speech.
 *
 * WHY IT HAS TO EXIST AT ALL: the filler strip (web/src/lib/voice-defluff.ts)
 * deletes the "uh"s that were previously the ONLY way to tell a dictation from
 * typing. Cleaned-up speech reads exactly like a written spec, and a written spec
 * is read far more literally than someone thinking out loud deserves.
 */

import type { InputSource } from './protocol'

/**
 * The attribute the control panel matches on. It lives on the opening tag rather
 * than in the prose so the detector cannot be tripped by a user who merely
 * QUOTES the hint text back (paste a bug report containing it and a plain
 * substring match on the wording would misread the message as dictated).
 */
export const VOICE_HINT_ATTR = 'data-input-source="voice"'

/**
 * Wrapped in `<system-reminder>` rather than prepended as plain text so it reads
 * as harness context and never as the user's own words -- otherwise the model can
 * quote it back or treat the guidance itself as part of the request.
 */
const VOICE_HINT = `<system-reminder ${VOICE_HINT_ATTR}>
The message below was DICTATED -- it is a speech-to-text transcript, not typed text. Read it accordingly:
- SELF-CORRECTIONS: when the speaker restates something ("the drop UI... sorry, not the drop UI"), the LAST version is what they meant. Follow it silently; do not ask which they meant.
- LENGTH IS NOT EMPHASIS. Speech rambles: a long meandering passage is often thinking out loud, and a short clause can carry the actual request. Weigh intent, not word count. (This is the opposite of written text, where length signals care.)
- PROPER NOUNS AND ACRONYMS MAY BE MIS-TRANSCRIBED. An unfamiliar term that does not fit the context is more likely a transcription error than a real thing -- ask instead of searching for it or acting on it.
- PUNCTUATION AND PARAGRAPH BREAKS were guessed by the speech model, not chosen by the speaker. Do not read meaning into sentence boundaries.
Do not mention or refer to this note in your reply.
</system-reminder>

`

/**
 * Returns the prompt unchanged for anything not dictated, so every pre-existing
 * caller keeps its exact behaviour and a future `InputSource` member cannot
 * accidentally inherit the voice hint.
 */
export function applyInputSourceHint(input: string, source?: InputSource): string {
  return source === 'voice' ? VOICE_HINT + input : input
}

/**
 * Anchored at the START only: a hint the agent host prepended is always the first
 * thing in the message, so an unanchored match would also fire on a block the
 * user pasted into the middle of their own text.
 */
const VOICE_HINT_BLOCK = new RegExp(String.raw`^\s*<system-reminder ${VOICE_HINT_ATTR}>[\s\S]*?</system-reminder>\s*`)

/**
 * Takes the hint back off for display and reports whether it was there. The
 * control panel calls this on every user entry: `source` drives the mic icon and
 * the italics, `text` is what actually gets rendered.
 */
export function stripInputSourceHint(text: string): { text: string; source?: InputSource } {
  if (!text.includes(VOICE_HINT_ATTR)) return { text }
  const stripped = text.replace(VOICE_HINT_BLOCK, '')
  return stripped === text ? { text } : { text: stripped, source: 'voice' }
}
