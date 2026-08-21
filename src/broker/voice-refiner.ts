/**
 * voice-refiner - optional LLM cleanup pass over a finished voice transcript.
 *
 * Two-Step ASR Post-Processing Refinement (APR), inspired by Task-Activating
 * Prompting (TAP) from "Generative Speech Recognition Error Correction with LLMs"
 * (Yang et al., 2023):
 *   Step 1 - Context Extraction: analyze the raw transcript for domain, proper
 *     nouns and likely misrecognitions (voice-refiner-context.ts, OPTIONAL --
 *     it is a second sequential call and doubles the latency).
 *   Step 2 - Refinement: clean the transcript with TAP multi-turn structure,
 *     enriched by project keyterms AND step 1's findings.
 *
 * OPT-IN, AND IT MEANS IT (2026-07-22): this used to run off a hardcoded default
 * system prompt whenever the checkbox was on, with no keyterms and no user
 * prompt. That is an LLM rewriting the user's words against NO ground truth --
 * step 1 literally invents `heard -> meant` pairs from the transcript alone and
 * step 2 then obeys them. Unconfigured now means OFF, not "improvise".
 * RECOMMENDED_VOICE_PROMPT is offered as a one-click starting point in settings;
 * it is deliberately NOT the schema default, which stays ''.
 *
 * THE DEADLINE (2026-08-18): refinement sits between the user finishing a
 * sentence and seeing their text, so it is latency, not throughput. It races a
 * wall-clock deadline covering BOTH steps and falls back to the raw transcript
 * on expiry. Timing out is a normal outcome, logged and moved past -- never an
 * error the user has to see.
 *
 * THE OUTPUT CONTRACT (2026-08-21): a refinement that does not look like a
 * refinement is DISCARDED. This function used to end in `result || rawText`,
 * which only defends against an EMPTY answer -- so when the model replied
 * "Please provide the transcript you would like me to clean." to a one-word
 * dictation, that sentence was sent to the agent as the user's own words. The
 * prompt-side fix is the <TRANSCRIPT> envelope; this is the part that does not
 * depend on a model obeying anything. See voice-refiner-guard.ts.
 *
 * Deliberately socket-free: it returns text and never touches the WebSocket, so
 * it stays testable and cannot import voice-stream back.
 */

import { isTrivialTranscript, refinementRejectReason } from '../shared/voice-refiner-guard'
import { resolveVoiceRefinerSpec, type VoiceRefinerModelSpec } from '../shared/voice-refiner-models'
import { buildMessages, stripPreamble } from '../shared/voice-refiner-prompt'
import { getGlobalSettings } from './global-settings'
import { chat } from './recap/shared/openrouter-client'
import { contextBlockFrom, extractContext } from './voice-refiner-context'

export { RECOMMENDED_VOICE_PROMPT, stripPreamble } from '../shared/voice-refiner-prompt'
export { contextBlockFrom } from './voice-refiner-context'

/**
 * Whether a refinement pass would do anything. Checked by the caller before it
 * announces `voice_refining` to the browser, and again inside refineTranscript.
 * Every falsy answer is a deliberate no-op, not a failure.
 */
export function refinementSkipReason(rawText: string): string | null {
  const settings = getGlobalSettings()
  if (!settings.voiceRefinement) return 'disabled in settings'
  if (!process.env.OPENROUTER_API_KEY) return 'no OPENROUTER_API_KEY'
  if (!rawText.trim()) return 'empty transcript'
  if (!settings.voiceRefinementPrompt?.trim()) return 'no refinement prompt configured'
  // A handful of words has no disfluencies an LLM can improve, and a short
  // utterance is exactly what a model mistakes for an aside to itself -- "Okay."
  // came back as "Please provide the transcript you would like me to clean."
  // Skipping is also free latency on the acks that fill a lot of real dictation.
  if (isTrivialTranscript(rawText)) return 'transcript too short to refine'
  return null
}

/** Sentinel resolved by the deadline timer. Never conflates with a real result:
 *  the refine path only ever resolves to a string. */
const DEADLINE = Symbol('voice-refiner-deadline')

/**
 * Refine `rawText`, or return it untouched. NEVER throws and never returns
 * empty: every failure path -- API error, malformed response, blown deadline --
 * falls back to the raw transcript, because losing the user's words to a refiner
 * hiccup is far worse than a rough transcript.
 */
export async function refineTranscript(rawText: string, keyterms: string[]): Promise<string> {
  const skip = refinementSkipReason(rawText)
  if (skip) {
    console.log(`[voice-refiner] skipped (${skip})`)
    return rawText
  }
  const settings = getGlobalSettings()
  const spec = resolveVoiceRefinerSpec(settings.voiceRefinementModel)
  const model = spec.id
  const deadlineMs = settings.voiceRefinementDeadlineMs ?? 2000
  const started = Date.now()

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline =
    deadlineMs > 0
      ? new Promise<typeof DEADLINE>(resolve => {
          timer = setTimeout(() => resolve(DEADLINE), deadlineMs)
        })
      : null

  try {
    const work = runRefinement(rawText, keyterms, spec, settings.voiceRefinementContextPass !== false)
    const result = deadline ? await Promise.race([work, deadline]) : await work
    if (result === DEADLINE) {
      // The in-flight call is abandoned, not cancelled -- it still bills and
      // still logs its own spend. Shortening the deadline does not save money,
      // it saves the USER's time. Say so in the log so a future reader does not
      // "optimise" this into a cancellation that races the socket.
      console.warn(`[voice-refiner] deadline blown after ${deadlineMs}ms (model=${model}) -- returning raw transcript`)
      return rawText
    }
    if (!result) {
      console.warn(`[voice-refiner] empty result (model=${model}) -- returning raw transcript`)
      return rawText
    }
    // The guard runs LAST, on the final string, so nothing -- not a refusal, not
    // an answered question, not a summary -- can reach the agent as the user's
    // words. Rejecting costs the user a rough transcript; accepting costs them a
    // sentence they never said.
    const reject = refinementRejectReason(rawText, result)
    if (reject) {
      console.warn(
        `[voice-refiner] REJECTED refinement (model=${model}): ${reject}\n  RAW: "${rawText}"\n  BAD: "${result}"`,
      )
      return rawText
    }
    console.log(`[voice-refiner] refined in ${Date.now() - started}ms (model=${model})\n  OUT: "${result}"`)
    return result
  } catch (err) {
    console.error('[voice-refiner] refinement failed:', err)
    return rawText
  } finally {
    clearTimeout(timer)
  }
}

/** Both steps, in order. Throws on a step-2 failure; step 1 failing is survivable
 *  and degrades to an empty context block. */
async function runRefinement(
  rawText: string,
  keyterms: string[],
  spec: VoiceRefinerModelSpec,
  contextPass: boolean,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY as string
  const systemPrompt = getGlobalSettings().voiceRefinementPrompt as string
  console.log(`[voice-refiner] refining (${keyterms.length} keyterms, context=${contextPass}):\n  RAW: "${rawText}"`)

  let contextJson = ''
  if (contextPass) {
    try {
      contextJson = await extractContext(rawText, apiKey, keyterms, spec)
      console.log(`[voice-refiner] step 1 context: ${contextJson.slice(0, 300)}`)
    } catch (err) {
      console.error('[voice-refiner] step 1 context failed:', err)
    }
  }

  const res = await chat({
    feature: 'voice-refiner-refine',
    model: spec.id,
    apiKey,
    messages: buildMessages(systemPrompt, keyterms, contextBlockFrom(contextJson), rawText),
    maxTokens: 2048,
    temperature: 0.3,
    retries: 0,
    ...(spec.providerOrder ? { provider: { order: spec.providerOrder } } : {}),
  })
  return stripPreamble(res.content || rawText)
}
