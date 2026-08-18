/**
 * voice-refine-request - the direct path's call into the broker's refiner.
 *
 * The relay path gets refinement for free: the transcript is already on the
 * broker, so voice-stream refines it in place and pushes `voice_done`. The
 * direct path (browser -> stt-proxy Worker -> Deepgram) never sends the
 * transcript anywhere, so it has to ask. This is that ask.
 *
 * NEVER REJECTS, NEVER RETURNS EMPTY. Refinement is a nice-to-have sitting
 * directly between the user releasing the key and seeing their words; a broker
 * that is down, slow, or 500ing must cost them a polish pass, never a sentence.
 * Every failure resolves to the raw text.
 *
 * TWO DEADLINES, AND THEY ARE NOT THE SAME DEADLINE. The broker owns the real
 * one (`voiceRefinementDeadlineMs`, default 2s) because only the broker's clock
 * sees model latency without the user's network in it. The abort here is a pure
 * NETWORK backstop, deliberately slack, and exists so a dead socket cannot hang
 * the recorder forever. If this one is ever the one firing, the setting to
 * change is the broker's.
 */

/** Broker deadline (2s) plus room for a bad connection. Not a tuning knob. */
const NETWORK_BACKSTOP_MS = 8000

interface RefineResponse {
  raw?: string
  refined?: string
  skipped?: string
  keyterms?: number
}

export async function requestRefine(text: string, conversationId: string | null): Promise<string> {
  if (!text.trim()) return text
  const controller = new AbortController()
  const abort = setTimeout(() => controller.abort(), NETWORK_BACKSTOP_MS)
  const started = performance.now()
  try {
    // Same-origin, matching lib/push.ts -- the panel is served by the broker.
    const res = await fetch('/api/voice/refine', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, conversationId }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn(`[voice-refine] broker returned ${res.status} -- using raw transcript`)
      return text
    }
    const data = (await res.json()) as RefineResponse
    const ms = Math.round(performance.now() - started)
    if (data.skipped) {
      console.log(`[voice-refine] skipped (${data.skipped}) in ${ms}ms`)
      return text
    }
    console.log(`[voice-refine] refined in ${ms}ms (${data.keyterms ?? 0} keyterms)`)
    return data.refined?.trim() || text
  } catch (err) {
    // AbortError included: a blown backstop is a network problem, and the raw
    // transcript is still a perfectly good message.
    console.warn('[voice-refine] request failed -- using raw transcript', err)
    return text
  } finally {
    clearTimeout(abort)
  }
}
