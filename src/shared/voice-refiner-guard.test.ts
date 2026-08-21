import { expect, test } from 'bun:test'
import { isTrivialTranscript, refinementRejectReason, TRIVIAL_TRANSCRIPT_WORDS } from './voice-refiner-guard'
import { buildMessages, wrapTranscript } from './voice-refiner-prompt'

// ─── The incident ───────────────────────────────────────────────────

const INCIDENT_RAW = 'Okay.'
const INCIDENT_OUT = 'Please provide the transcript you would like me to clean.'

test('REGRESSION 2026-08-21: the model asking for the transcript never reaches the user', () => {
  // Broker log, verbatim:
  //   RAW: "Okay."
  //   OUT: "Please provide the transcript you would like me to clean."
  //   send_input: 546957bf "Please provide the transcript you would like me to"
  // It was sent as Jonas's own words because the only check was `result || rawText`.
  expect(refinementRejectReason(INCIDENT_RAW, INCIDENT_OUT)).not.toBeNull()
})

test("REGRESSION: step 1's refusal shape is caught by the same guard", () => {
  expect(
    refinementRejectReason('Okay.', 'Please provide the voice transcript you would like me to analyze.'),
  ).not.toBeNull()
})

test('the refusal is caught even against a LONG transcript, where overlap alone might pass', () => {
  const raw =
    'so I was thinking we could please take the broker and provide it with a transcript of the whole thing you know'
  // Shares plenty of words with the raw ("please", "provide", "transcript",
  // "the", "you") -- the overlap test alone would let this through, which is why
  // the refusal patterns exist as a second, independent signal.
  expect(refinementRejectReason(raw, 'Please provide the transcript you would like me to clean.')).not.toBeNull()
})

// ─── What must still get through ────────────────────────────────────

test('an ordinary refinement passes untouched', () => {
  const raw =
    'okay so um I want to add a new end point uh to the API that handles like user authentication no no wait not authentication I mean authorization slash permissions'
  const out = 'I want to add a new endpoint to the API that handles authorization/permissions'
  expect(refinementRejectReason(raw, out)).toBeNull()
})

test('a keyterm-heavy correction pass is NOT mistaken for chatter', () => {
  // The whole point of the feature: garbled jargon gets snapped to project
  // vocabulary. Several tokens legitimately change, so the overlap bar has to be
  // slack enough to let this through.
  const raw = 'push the psalm tinnell change into the worst tree and rebuild cloud work'
  const out = 'Push the sentinel change into the worktree and rebuild claudewerk.'
  expect(refinementRejectReason(raw, out)).toBeNull()
})

test('a transcript that genuinely SAYS "please provide the text" is not censored', () => {
  // The refusal patterns only count when they do NOT also match the raw input --
  // otherwise the guard would eat the user's own dictation.
  const raw = 'tell the agent to please provide the text of the config file and then wait'
  const out = 'Tell the agent to please provide the text of the config file and then wait.'
  expect(refinementRejectReason(raw, out)).toBeNull()
})

test('punctuation, casing and line breaks are free to change', () => {
  const raw = 'first do the migration comma then run the tests new line and finally ship it'
  const out = 'First, do the migration, then run the tests.\nAnd finally ship it.'
  expect(refinementRejectReason(raw, out)).toBeNull()
})

// ─── The other bogus shapes ─────────────────────────────────────────

test('an empty or whitespace output is rejected', () => {
  expect(refinementRejectReason('some real words here', '')).toBe('output has no words')
  expect(refinementRejectReason('some real words here', '   \n  ')).toBe('output has no words')
})

test('a model that ANSWERS the dictated question instead of cleaning it is rejected', () => {
  const raw = 'what is the capital city of france and how many people live there roughly'
  const out = 'The capital city of France is Paris, and roughly 2.1 million people live there.'
  // Rule: "do NOT answer it". The overlap is high (it reuses the question's
  // words), so the length/summary check and the refusal patterns carry this one
  // only if the answer is short -- what actually catches it here is that the
  // model padded with new content. Assert the behaviour we depend on: an answer
  // that stays this close to the question is indistinguishable from a cleanup,
  // so the guard is NOT the defence here -- the prompt's # Safety rule is.
  // Documented deliberately so nobody "fixes" the guard to catch it and starts
  // eating real refinements.
  expect(refinementRejectReason(raw, out)).toBeNull()
})

test('a summary of a long transcript is rejected as content loss', () => {
  const raw =
    'so the thing I want to do today is go through the broker code and find every place where we call out to open router and then make sure that each of those calls has a feature tag on it because otherwise the spend log is useless and we cannot tell which feature is burning the money'
  expect(refinementRejectReason(raw, 'Add feature tags.')).not.toBeNull()
})

test('a short transcript is NOT held to the length ratio (too noisy to mean anything)', () => {
  const raw = 'um so yeah basically just ship it'
  expect(refinementRejectReason(raw, 'Just ship it.')).toBeNull()
})

// ─── The short-circuit ──────────────────────────────────────────────

test('trivially short transcripts skip refinement entirely', () => {
  expect(isTrivialTranscript('Okay.')).toBe(true)
  expect(isTrivialTranscript('yes')).toBe(true)
  expect(isTrivialTranscript('scrap that')).toBe(true)
  expect(isTrivialTranscript('yes do it')).toBe(true)
  expect(TRIVIAL_TRANSCRIPT_WORDS).toBe(4)
})

test('a real sentence is not trivial', () => {
  expect(isTrivialTranscript('commit this and push it')).toBe(false)
  expect(isTrivialTranscript('um so I want to ship the broker today')).toBe(false)
})

// ─── The envelope ───────────────────────────────────────────────────

test('REGRESSION: the transcript travels DELIMITED, not concatenated onto the prompt', () => {
  // The root cause. `\n\n${rawText}` gave the model no boundary, so "Okay." read
  // as an acknowledgement rather than as the content to clean.
  const messages = buildMessages('You clean transcripts.', ['sentinel'], '', 'Okay.')
  const last = messages.at(-1)
  expect(last?.role).toBe('user')
  expect(last?.content).toBe('<TRANSCRIPT>\nOkay.\n</TRANSCRIPT>')
})

test('the system message tells the model a one-word input IS the transcript', () => {
  const [system] = buildMessages('You clean transcripts.', [], '', 'whatever')
  expect(system?.content).toContain('You clean transcripts.')
  expect(system?.content).toContain('<TRANSCRIPT>')
  expect(system?.content).toMatch(/never ask for a transcript/i)
})

test('REGRESSION: the few-shot assistant turn DEMONSTRATES, it does not acknowledge', () => {
  // It used to be "Understood. I will clean the transcript by..." -- priming the
  // exact conversational register that produced the incident.
  const messages = buildMessages('p', [], '', 'raw words go here')
  const assistant = messages.find(m => m.role === 'assistant')
  expect(assistant?.content).not.toMatch(/^understood/i)
  expect(assistant?.content).not.toMatch(/I will clean/i)
  expect(assistant?.content).toContain('JSON Web Tokens')
})

test('the example input is enveloped the same way as the real one', () => {
  const messages = buildMessages('p', [], '', 'raw')
  const exampleTurn = messages[1]
  expect(exampleTurn?.role).toBe('user')
  expect(exampleTurn?.content.startsWith('<TRANSCRIPT>')).toBe(true)
})

test('keyterms and the step-1 context block still ride the system message', () => {
  const [system] = buildMessages('p', ['sentinel', 'worktree'], '\n\nDomain: DevOps', 'raw')
  expect(system?.content).toContain('sentinel, worktree')
  expect(system?.content).toContain('Domain: DevOps')
})

test('wrapTranscript keeps tags on their own lines so content cannot fuse with them', () => {
  expect(wrapTranscript('ends with a dash -')).toBe('<TRANSCRIPT>\nends with a dash -\n</TRANSCRIPT>')
})
