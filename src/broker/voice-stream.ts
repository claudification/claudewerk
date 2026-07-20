/**
 * Voice streaming - Deepgram live WebSocket relay
 *
 * Flow: Browser -> broker WS -> Deepgram live WS -> interim/final results -> browser
 * After final transcript, optional Haiku refinement pass cleans up the text.
 */

import type { ServerWebSocket } from 'bun'
import type { ConversationStore } from './conversation-store'
import { getGlobalSettings } from './global-settings'
import { getProjectSettings } from './project-settings'
import { chat } from './recap/shared/openrouter-client'

const VOICE_REFINER_MODEL = 'anthropic/claude-haiku-4.5'

const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen'
// The v1 streaming pipeline (webm/opus auto-detect, smart_format, interim_results,
// endpointing, Results-schema parsing) only works with the nova family. Flux is a
// different API entirely -- v2 endpoint, raw-PCM audio, turn-based TurnInfo events,
// and it REJECTS every v1 transcription param. Until that's a separate integration,
// any non-nova model falls back to nova-3 so a stale/unsupported setting can't brick
// voice. (Proven 2026-06-27: flux-general-en on v2 rejects smart_format/punctuate/
// interim_results/endpointing/vad_events/language at the WS handshake.)
const DEFAULT_DEEPGRAM_MODEL = 'nova-3'
function resolveDeepgramModel(configured: string | undefined): string {
  return configured?.startsWith('nova') ? configured : DEFAULT_DEEPGRAM_MODEL
}

/**
 * Build the Deepgram live-transcription query params. The client now streams raw
 * linear16 PCM (AudioWorklet, deterministic ~50ms cadence -- replaced
 * MediaRecorder whose Safari mp4 fallback lumped audio into ~1s fragments = the
 * lag). Raw PCM has NO container, so Deepgram can't auto-detect it: we MUST
 * declare encoding + sample_rate. When absent (older cached client streaming
 * webm/opus), fall through to container auto-detect.
 */
function buildDeepgramParams(
  model: string,
  keyterms: string[],
  encoding: string | undefined,
  sampleRate: number | undefined,
): URLSearchParams {
  const params = new URLSearchParams({
    model,
    smart_format: 'true',
    punctuate: 'true',
    filler_words: 'false',
    interim_results: 'true',
    endpointing: '500', // 500ms silence = speech_final (natural conversation pace)
    vad_events: 'true',
    language: 'en',
  })
  if (encoding === 'linear16') {
    params.set('encoding', 'linear16')
    params.set('sample_rate', String(sampleRate || 16000))
    params.set('channels', '1')
  }
  for (const kt of keyterms) {
    params.append('keyterm', `${kt}:3`)
  }
  return params
}
const VOICE_TIMEOUT_MS = 120_000 // Max 120s recording conversation
const KEEPALIVE_INTERVAL_MS = 5_000 // Deepgram kills connection after 10s of no audio

interface VoiceSession {
  dgWs: WebSocket
  dashboardWs: ServerWebSocket<unknown> | null // null = orphaned (WS died mid-recording)
  userId: string | null
  conversationId: string | null
  finalTranscript: string
  keyterms: string[]
  audioBuffer: Buffer[] // Buffer chunks while DG WS is connecting
  timeoutTimer: ReturnType<typeof setTimeout>
  keepaliveTimer: ReturnType<typeof setInterval>
  closed: boolean
  // Per-session audio accounting. These USED to be module-level globals, which
  // collided across concurrent sessions (multi-user broker) and got reset
  // mid-flight in dgWs.onopen -- either bug could fabricate a false "No audio
  // received" error. Now scoped to the session and counting EVERY chunk the
  // browser sends (buffered while DG dials, or live), never reset, so the
  // zero-chunk check reliably means "the browser's mic produced nothing".
  audioChunks: number
  audioBytes: number
}

// Active voice sessions keyed by dashboard WS identity
const voiceSessions = new Map<ServerWebSocket<unknown>, VoiceSession>()

// ─── Pending voice results (survive WS disconnect) ─────────────────
const PENDING_VOICE_TTL_MS = 5 * 60_000
interface PendingVoiceResult {
  raw: string
  refined: string
  conversationId: string | null
  ts: number
}
const pendingVoiceResults = new Map<string, PendingVoiceResult>()

function bufferVoiceResult(userId: string | null, raw: string, refined: string, conversationId: string | null) {
  if (!userId || !raw) return
  console.log(
    `[voice-stream] Buffering voice result for user=${userId} (${raw.length} chars raw, ${refined.length} chars refined, conv=${conversationId ?? 'none'}) -- will redeliver on reconnect`,
  )
  pendingVoiceResults.set(userId, { raw, refined, conversationId, ts: Date.now() })
}

/** Called by the subscribe handler when a dashboard WS reconnects. */
export function deliverPendingVoiceResult(userName: string, ws: ServerWebSocket<unknown>): boolean {
  const pending = pendingVoiceResults.get(userName)
  if (!pending) return false
  if (Date.now() - pending.ts > PENDING_VOICE_TTL_MS) {
    console.log(
      `[voice-stream] Pending voice result for ${userName} expired (${((Date.now() - pending.ts) / 1000).toFixed(0)}s old)`,
    )
    pendingVoiceResults.delete(userName)
    return false
  }
  console.log(
    `[voice-stream] Redelivering buffered voice result to ${userName} (${pending.raw.length} chars, age=${((Date.now() - pending.ts) / 1000).toFixed(1)}s)`,
  )
  safeSend(ws, JSON.stringify({ type: 'voice_done', raw: pending.raw, refined: pending.refined, recovered: true }))
  pendingVoiceResults.delete(userName)
  return true
}

function safeSend(ws: ServerWebSocket<unknown> | null, data: string): boolean {
  if (!ws) return false
  try {
    ws.send(data)
    return true
  } catch {
    return false
  }
}

export function handleVoiceStart(
  ws: ServerWebSocket<unknown>,
  data: { conversationId?: string; project?: string; accumulated?: string; encoding?: string; sampleRate?: number },
  conversationStore: ConversationStore,
) {
  const deepgramKey = process.env.DEEPGRAM_API_KEY
  if (!deepgramKey) {
    ws.send(JSON.stringify({ type: 'voice_error', error: 'DEEPGRAM_API_KEY not configured' }))
    return
  }

  // Clean up any existing voice session for this WS
  cleanupVoiceSession(ws)

  // Build keyterms from project settings
  const keyterms: string[] = []
  const project =
    data.project || (data.conversationId ? conversationStore.getConversation(data.conversationId)?.project : null)
  if (project) {
    const projSettings = getProjectSettings(project)
    if (projSettings?.keyterms?.length) {
      keyterms.push(...projSettings.keyterms)
    }
  }

  // Build Deepgram live WS URL with params.
  const globalSettings = getGlobalSettings()
  const model = resolveDeepgramModel(globalSettings.deepgramModel)
  if (globalSettings.deepgramModel && model !== globalSettings.deepgramModel) {
    console.warn(
      `[voice-stream] Unsupported model "${globalSettings.deepgramModel}" -- falling back to ${model} (v1 pipeline is nova-only)`,
    )
  }
  const params = buildDeepgramParams(model, keyterms, data.encoding, data.sampleRate)

  const dgUrl = `${DEEPGRAM_LIVE_URL}?${params}`
  const encodingDesc = data.encoding === 'linear16' ? `linear16@${data.sampleRate || 16000}Hz` : 'container-autodetect'
  console.log(
    `[voice-stream] Opening Deepgram live WS (model=${model}, encoding=${encodingDesc}, ${keyterms.length} keyterms)`,
  )

  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${deepgramKey}` },
  } as unknown as string)

  const wsData = ws.data as { userName?: string }
  const voiceSession: VoiceSession = {
    dgWs,
    dashboardWs: ws,
    userId: wsData?.userName || null,
    conversationId: data.conversationId || null,
    finalTranscript: data.accumulated || '',
    keyterms,
    audioBuffer: [],
    closed: false,
    audioChunks: 0,
    audioBytes: 0,
    timeoutTimer: setTimeout(() => {
      console.log(`[voice-stream] Session timed out (${VOICE_TIMEOUT_MS / 1000}s)`)
      stopVoiceSession(ws, 'timeout')
    }, VOICE_TIMEOUT_MS),
    // KeepAlive prevents Deepgram from killing the connection during silence
    keepaliveTimer: setInterval(() => {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: 'KeepAlive' }))
      }
    }, KEEPALIVE_INTERVAL_MS),
  }

  voiceSessions.set(ws, voiceSession)

  // Ack to the browser the instant we accept the start and begin dialing
  // Deepgram. This splits the chain into observable legs: if the client sent
  // voice_start but never sees voice_connecting, the browser->broker WS leg
  // dropped it; if it sees voice_connecting but never voice_ready, Deepgram is
  // the slow/failed leg. The client uses this to phrase honest errors and to
  // keep the UI in "connecting" (NOT "speak now") until the whole chain is up.
  safeSend(ws, JSON.stringify({ type: 'voice_connecting' }))

  dgWs.onopen = () => {
    // Flush any audio buffered during connection
    const flushedChunks = voiceSession.audioBuffer.length
    const flushedBytes = voiceSession.audioBuffer.reduce((sum, b) => sum + b.length, 0)
    if (flushedChunks > 0) {
      console.log(`[voice-stream] Deepgram WS connected, flushing ${flushedChunks} buffered chunks (${flushedBytes}B)`)
      for (const chunk of voiceSession.audioBuffer) {
        dgWs.send(chunk)
      }
      voiceSession.audioBuffer = []
    } else {
      console.log('[voice-stream] Deepgram WS connected, waiting for audio...')
    }
    // NOTE: do NOT reset the audio counters here. They count every chunk the
    // browser has sent so far (including the ones just flushed); zeroing them
    // would discount real audio and could fabricate a false "No audio" error.
    safeSend(voiceSession.dashboardWs, JSON.stringify({ type: 'voice_ready', flushedChunks, flushedBytes }))
  }

  dgWs.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')

      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0]
        if (!alt) return

        const transcript = alt.transcript || ''
        const isFinal = msg.is_final === true
        const speechFinal = msg.speech_final === true

        if (transcript) {
          if (isFinal) {
            // Accumulate final segments
            voiceSession.finalTranscript += (voiceSession.finalTranscript ? ' ' : '') + transcript
          }

          safeSend(
            voiceSession.dashboardWs,
            JSON.stringify({
              type: 'voice_transcript',
              transcript,
              isFinal,
              speechFinal,
              accumulated: voiceSession.finalTranscript,
            }),
          )
        }
      } else if (msg.type === 'UtteranceEnd') {
        safeSend(voiceSession.dashboardWs, JSON.stringify({ type: 'voice_utterance_end' }))
      } else if (msg.type === 'Metadata') {
        // Sent after CloseStream - connection is about to close
        console.log(`[voice-stream] Deepgram metadata: duration=${msg.duration}s`)
      }
    } catch (err) {
      console.error('[voice-stream] Failed to parse Deepgram message:', err)
    }
  }

  dgWs.onerror = (event: Event) => {
    console.error('[voice-stream] Deepgram WS error:', event)
    safeSend(
      voiceSession.dashboardWs,
      JSON.stringify({ type: 'voice_error', error: 'Deepgram connection failed. Check server logs.' }),
    )
    cleanupVoiceSession(ws)
  }

  dgWs.onclose = (event: CloseEvent) => {
    const reason = event.reason || 'no reason'
    const orphaned = !voiceSession.dashboardWs
    console.log(
      `[voice-stream] Deepgram WS closed (code: ${event.code}, reason: "${reason}", audioChunks: ${voiceSession.audioChunks}, totalBytes: ${voiceSession.audioBytes}, orphaned: ${orphaned})`,
    )

    if (!voiceSession.closed) {
      if (voiceSession.finalTranscript) {
        voiceSession.closed = true
        if (orphaned) {
          // WS died mid-recording -- buffer for redelivery, skip refinement
          bufferVoiceResult(
            voiceSession.userId,
            voiceSession.finalTranscript,
            voiceSession.finalTranscript,
            voiceSession.conversationId,
          )
        } else {
          refineAndSend(
            voiceSession.dashboardWs as ServerWebSocket<unknown>,
            voiceSession.finalTranscript,
            voiceSession.keyterms,
            voiceSession.userId,
            voiceSession.conversationId,
          )
        }
      } else if (voiceSession.audioChunks === 0) {
        console.error('[voice-stream] Deepgram closed with ZERO audio chunks received from browser')
        safeSend(
          voiceSession.dashboardWs,
          JSON.stringify({ type: 'voice_error', error: 'No audio data received. Check microphone permissions.' }),
        )
        voiceSession.closed = true
      } else if (voiceSession.audioBytes > 0 && !voiceSession.finalTranscript) {
        console.warn(`[voice-stream] Deepgram closed with ${voiceSession.audioBytes}B audio but no transcript`)
        safeSend(
          voiceSession.dashboardWs,
          JSON.stringify({
            type: 'voice_error',
            error: 'No speech detected. Try speaking louder or closer to the mic.',
          }),
        )
        voiceSession.closed = true
      }
    }
    cleanupTimers(voiceSession)
    if (voiceSession.dashboardWs) voiceSessions.delete(voiceSession.dashboardWs)
  }
}

// Throttle the no-session warning so a stuck/phantom recorder can't flood the log.
const noSessionWarned = new WeakSet<ServerWebSocket<unknown>>()

export function handleVoiceData(ws: ServerWebSocket<unknown>, audioBase64: string) {
  const session = voiceSessions.get(ws)
  if (!session) {
    // The browser is streaming audio but the broker has no session for this
    // socket -- voice_start never arrived (or was dropped). This is a real
    // discrepancy: the user is talking into the void. Tell them so the UI can
    // stop pretending it's recording, instead of silently swallowing audio.
    if (!noSessionWarned.has(ws)) {
      noSessionWarned.add(ws)
      const d = ws.data as { user?: string; userId?: string; conversationId?: string }
      console.warn(
        `[voice-stream] voice_data with NO session (voice_start missing) user=${d?.user ?? d?.userId ?? '?'} conv=${d?.conversationId ?? '?'} -- further drops from this socket silenced`,
      )
    }
    safeSend(
      ws,
      JSON.stringify({ type: 'voice_error', error: 'Voice session not started (lost connection). Try again.' }),
    )
    return
  }

  const bytes = Buffer.from(audioBase64, 'base64')
  session.audioChunks++
  session.audioBytes += bytes.length

  // Log first chunk and then every 20th chunk
  if (session.audioChunks === 1 || session.audioChunks % 20 === 0) {
    console.log(
      `[voice-stream] Audio chunk #${session.audioChunks}: ${bytes.length}B (total: ${session.audioBytes}B, DG state: ${session.dgWs.readyState})`,
    )
  }

  if (session.dgWs.readyState === WebSocket.OPEN) {
    session.dgWs.send(bytes)
  } else if (session.dgWs.readyState === WebSocket.CONNECTING) {
    // Buffer audio while Deepgram WS is still connecting -- flush on open
    session.audioBuffer.push(bytes)
    if (session.audioBuffer.length === 1) {
      console.log('[voice-stream] Buffering audio while DG WS connects...')
    }
  } else {
    console.warn(`[voice-stream] DG WS not open (state: ${session.dgWs.readyState}), dropping ${bytes.length}B audio`)
  }
}

export function handleVoiceReplay(ws: ServerWebSocket<unknown>, chunks: string[]) {
  const session = voiceSessions.get(ws)
  if (!session) {
    console.warn('[voice-stream] voice_replay received but no active session')
    return
  }

  let totalBytes = 0
  for (const base64 of chunks) {
    const bytes = Buffer.from(base64, 'base64')
    session.audioChunks++
    session.audioBytes += bytes.length
    totalBytes += bytes.length
    if (session.dgWs.readyState === WebSocket.OPEN) {
      session.dgWs.send(bytes)
    } else {
      session.audioBuffer.push(bytes)
    }
  }
  console.log(
    `[voice-stream] Replayed ${chunks.length} buffered chunks (${totalBytes}B, DG state: ${session.dgWs.readyState})`,
  )
}

export function handleVoiceStop(ws: ServerWebSocket<unknown>) {
  stopVoiceSession(ws, 'user')
}

/** Emit the final result if we captured a transcript, else an empty voice_done, then clean up. */
function completeVoiceSession(ws: ServerWebSocket<unknown>, session: VoiceSession) {
  if (session.finalTranscript) {
    refineAndSend(ws, session.finalTranscript, session.keyterms, session.userId, session.conversationId)
  } else {
    safeSend(ws, JSON.stringify({ type: 'voice_done', raw: '', refined: '' }))
    cleanupVoiceSession(ws)
  }
}

/** Ask Deepgram to flush (Finalize), close the stream, then complete once results settle. */
function flushFinalizeAndComplete(ws: ServerWebSocket<unknown>, session: VoiceSession, completeDelayMs: number) {
  session.dgWs.send(JSON.stringify({ type: 'Finalize' }))
  setTimeout(() => {
    if (session.dgWs.readyState === WebSocket.OPEN) {
      session.dgWs.send(JSON.stringify({ type: 'CloseStream' }))
    }
  }, 500)
  setTimeout(() => completeVoiceSession(ws, session), completeDelayMs)
}

function stopVoiceSession(ws: ServerWebSocket<unknown>, reason: string) {
  const session = voiceSessions.get(ws)
  if (!session) return

  console.log(`[voice-stream] Stopping session (reason: ${reason})`)
  session.closed = true
  clearTimeout(session.timeoutTimer)
  clearInterval(session.keepaliveTimer)

  if (session.dgWs.readyState === WebSocket.OPEN) {
    // DG connected - flush pending results, close, then complete (800ms catches
    // the last finals from Finalize).
    flushFinalizeAndComplete(ws, session, 800)
  } else if (session.dgWs.readyState === WebSocket.CONNECTING) {
    // DG still connecting - wait up to 3s for it, then flush or give up
    console.log(`[voice-stream] DG still connecting at stop time, waiting up to 3s...`)
    const bufferedChunks = session.audioBuffer.length
    let resolved = false

    const giveUp = setTimeout(() => {
      if (resolved) return
      resolved = true
      console.warn(`[voice-stream] DG WS never connected (had ${bufferedChunks} buffered chunks)`)
      safeSend(ws, JSON.stringify({ type: 'voice_error', error: 'Voice service connection timed out. Try again.' }))
      cleanupVoiceSession(ws)
    }, 3000)

    // If DG connects within the window, flush audio and do normal stop
    const origOnOpen = session.dgWs.onopen
    session.dgWs.onopen = (ev: Event) => {
      if (resolved) return
      resolved = true
      clearTimeout(giveUp)
      if (origOnOpen) (origOnOpen as (ev: Event) => void)(ev)
      flushFinalizeAndComplete(ws, session, 1500)
    }

    session.dgWs.onerror = () => {
      if (resolved) return
      resolved = true
      clearTimeout(giveUp)
      safeSend(ws, JSON.stringify({ type: 'voice_error', error: 'Voice service connection failed. Try again.' }))
      cleanupVoiceSession(ws)
    }
  } else {
    // DG already closed/closing
    completeVoiceSession(ws, session)
  }
}

/**
 * Two-Step ASR Post-Processing Refinement (APR)
 *
 * Inspired by Task-Activating Prompting (TAP) from:
 * "Generative Speech Recognition Error Correction with LLMs" (Yang et al., 2023)
 *
 * Step 1 - Context Extraction: Analyze the raw transcript to discover domain context,
 *   proper nouns, locations, and likely misrecognitions. Fast structured extraction.
 * Step 2 - Refinement: Clean the transcript using TAP multi-turn structure, enriched
 *   with both project keyterms AND dynamically extracted context from step 1.
 */
// fallow-ignore-next-line complexity
async function refineAndSend(
  ws: ServerWebSocket<unknown>,
  rawText: string,
  keyterms: string[],
  userId: string | null,
  conversationId: string | null,
) {
  const globalSettings = getGlobalSettings()
  const openrouterKey = process.env.OPENROUTER_API_KEY

  // Skip refinement if disabled in settings, no API key, or empty text
  if (!globalSettings.voiceRefinement || !openrouterKey || !rawText.trim()) {
    if (!safeSend(ws, JSON.stringify({ type: 'voice_done', raw: rawText, refined: rawText }))) {
      bufferVoiceResult(userId, rawText, rawText, conversationId)
    }
    cleanupVoiceSession(ws)
    return
  }

  console.log(`[voice-stream] Refining (${keyterms.length} keyterms):\n  RAW: "${rawText}"`)
  safeSend(ws, JSON.stringify({ type: 'voice_refining' }))

  try {
    // ── Step 1: Context Extraction ──────────────────────────────────
    const keytermHint = keyterms.length > 0 ? `\nKnown project terms: ${keyterms.join(', ')}` : ''

    let contextBlock = ''
    let contextJson = ''
    try {
      const contextRes = await chat({
        model: VOICE_REFINER_MODEL,
        apiKey: openrouterKey,
        system: `You analyze voice transcripts to extract context that helps correct ASR errors.${keytermHint}`,
        user: `Analyze this voice transcript and output a brief JSON object with these fields:
- "proper_nouns": names, brands, places, tools mentioned or likely intended (array of strings)
- "domain": the topic/domain (e.g. "software development", "Thai culture", "DevOps") (string)
- "corrections": any words that are likely ASR misrecognitions, with what they probably should be (array of {"heard": "x", "meant": "y"})
- "tone": the speaker's tone/register (e.g. "casual", "technical", "formal") (string)

Output ONLY valid JSON, nothing else.

${rawText}`,
        maxTokens: 512,
        temperature: 0.1,
        retries: 0,
      })
      contextJson = contextRes.content
      console.log(`[voice-stream] Step 1 context: ${contextJson.slice(0, 300)}`)
    } catch (err) {
      console.error('[voice-stream] Step 1 context failed:', err)
    }
    if (contextJson) {
      try {
        const cleanJson = contextJson.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
        const ctx = JSON.parse(cleanJson)
        const parts: string[] = []
        if (ctx.domain) parts.push(`Domain: ${ctx.domain}`)
        if (ctx.tone) parts.push(`Tone: ${ctx.tone}`)
        if (ctx.proper_nouns?.length) parts.push(`Proper nouns/names: ${ctx.proper_nouns.join(', ')}`)
        if (ctx.corrections?.length) {
          const fixes = ctx.corrections
            .map((c: { heard: string; meant: string }) => `"${c.heard}" -> "${c.meant}"`)
            .join(', ')
          parts.push(`Likely ASR misrecognitions: ${fixes}`)
        }
        if (parts.length > 0) {
          contextBlock = `\n\nExtracted context from this transcript:\n${parts.join('\n')}`
        }
      } catch {
        console.warn('[voice-stream] Step 1 returned non-JSON, proceeding with step 2 anyway')
      }
    }

    // ── Step 2: Refinement with enriched context ────────────────────
    const keytermBlock =
      keyterms.length > 0
        ? `\nDomain vocabulary (correct spellings for this project): ${keyterms.join(', ')}\nWhen the transcript contains words that sound similar to these terms, prefer the domain term.`
        : ''

    const defaultSystemPrompt = `You are an expert ASR (Automatic Speech Recognition) post-processor. You specialize in cleaning up voice-transcribed text that will be used as prompts for a coding AI assistant.

You understand common ASR failure modes:
- Homophones and near-homophones (e.g. "their/there/they're", "write/right", "new/knew")
- Word boundary errors where ASR splits or merges words incorrectly (e.g. "react server" vs "React Server", "type script" vs "TypeScript")
- Technical term misrecognition (API names, libraries, CLI tools often get mangled)
- Disfluencies: false starts, self-corrections, filler words, repetitions
- Spoken punctuation and syntax references`

    const systemPrompt = globalSettings.voiceRefinementPrompt || defaultSystemPrompt

    const messages = [
      {
        role: 'system' as const,
        content: `${systemPrompt}${keytermBlock}${contextBlock}`,
      },
      {
        role: 'user' as const,
        content: `Here's an example of a raw voice transcript and its corrected version:

Raw: "okay so um I want to add a new end point uh to the API that handles like user authentication no no wait not authentication I mean authorization slash permissions and it should use jason web tokens uh jwt for the for the token format"

Corrected: "I want to add a new endpoint to the API that handles authorization/permissions and it should use JSON Web Tokens (JWT) for the token format"

Notice how: filler words removed, self-correction applied ("not authentication, I mean authorization"), "end point" merged to "endpoint", "jason" corrected to "JSON", "slash" converted to "/", repeated words cleaned up, but the speaker's casual tone and intent are preserved exactly.`,
      },
      {
        role: 'assistant' as const,
        content:
          "Understood. I will clean the transcript by removing disfluencies, applying self-corrections, fixing ASR errors (especially technical terms and word boundaries), and converting spoken syntax to written form - while preserving the speaker's original intent and tone.",
      },
      {
        role: 'user' as const,
        content: `Clean this voice transcript. Apply all corrections. Output ONLY the cleaned text - no quotes, no explanation, no preamble, no "Here's the corrected version" prefix.

${rawText}`,
      },
    ]

    try {
      const res = await chat({
        model: VOICE_REFINER_MODEL,
        apiKey: openrouterKey,
        messages,
        maxTokens: 2048,
        temperature: 0.3,
        retries: 0,
      })
      const refined = stripPreamble(res.content || rawText)
      console.log(`[voice-stream] Refined:\n  OUT: "${refined}"`)
      if (!safeSend(ws, JSON.stringify({ type: 'voice_done', raw: rawText, refined }))) {
        bufferVoiceResult(userId, rawText, refined, conversationId)
      }
    } catch (err) {
      console.error('[voice-stream] Step 2 refinement failed:', err)
      if (!safeSend(ws, JSON.stringify({ type: 'voice_done', raw: rawText, refined: rawText }))) {
        bufferVoiceResult(userId, rawText, rawText, conversationId)
      }
    }
  } catch (err) {
    console.error('[voice-stream] Refinement error:', err)
    if (!safeSend(ws, JSON.stringify({ type: 'voice_done', raw: rawText, refined: rawText }))) {
      bufferVoiceResult(userId, rawText, rawText, conversationId)
    }
  }

  cleanupVoiceSession(ws)
}

/** Strip common LLM preamble patterns that leak through despite instructions */
function stripPreamble(text: string): string {
  // Remove leading patterns like "Here's the corrected version:" or "Corrected:" etc.
  const preamblePatterns = [
    /^(?:here(?:'s| is) (?:the )?(?:cleaned|corrected|refined|fixed)(?: version)?[:\s-]+)/i,
    /^(?:corrected|cleaned|refined|fixed)(?: (?:version|text|transcript))?[:\s-]+/i,
    /^(?:sure[,!.]?\s*)/i,
  ]
  let result = text
  for (const pattern of preamblePatterns) {
    result = result.replace(pattern, '')
  }
  return result.trim()
}

function cleanupTimers(session: VoiceSession) {
  clearTimeout(session.timeoutTimer)
  clearInterval(session.keepaliveTimer)
}

function closeDgWs(session: VoiceSession) {
  if (session.dgWs.readyState === WebSocket.OPEN || session.dgWs.readyState === WebSocket.CONNECTING) {
    try {
      session.dgWs.close()
    } catch {}
  }
}

function cleanupVoiceSession(ws: ServerWebSocket<unknown>) {
  const session = voiceSessions.get(ws)
  if (!session) return
  cleanupTimers(session)
  closeDgWs(session)
  voiceSessions.delete(ws)
}

/**
 * Dashboard WS disconnected mid-recording. Instead of nuking the session,
 * orphan it: let Deepgram finish processing and buffer the result for
 * redelivery when the user reconnects. (Origin: 2026-06-29, a full dictated
 * essay was lost because cleanupVoiceForWs nuked the session while Deepgram
 * was still transcribing.)
 */
export function cleanupVoiceForWs(ws: ServerWebSocket<unknown>) {
  const session = voiceSessions.get(ws)
  if (!session) return

  voiceSessions.delete(ws)

  // If we already have a transcript, buffer it immediately
  if (session.finalTranscript) {
    console.log(
      `[voice-stream] WS disconnected, buffering existing transcript for user=${session.userId} (${session.finalTranscript.length} chars)`,
    )
    bufferVoiceResult(session.userId, session.finalTranscript, session.finalTranscript, session.conversationId)
    session.closed = true
    cleanupTimers(session)
    closeDgWs(session)
    return
  }

  // Deepgram may still be processing -- orphan the session (dashboardWs=null)
  // so the dgWs.onclose callback will buffer the result instead of trying to
  // send to a dead socket.
  session.dashboardWs = null
  console.log(
    `[voice-stream] WS disconnected mid-recording, orphaning session for user=${session.userId} (DG state=${session.dgWs.readyState}, chunks=${session.audioChunks})`,
  )

  // If DG is open, trigger a graceful flush so we get the final transcript
  if (session.dgWs.readyState === WebSocket.OPEN) {
    try {
      session.dgWs.send(JSON.stringify({ type: 'Finalize' }))
    } catch {}
    setTimeout(() => {
      if (session.dgWs.readyState === WebSocket.OPEN) {
        try {
          session.dgWs.send(JSON.stringify({ type: 'CloseStream' }))
        } catch {}
      }
    }, 500)
  }

  // Safety timeout: kill DG if it hasn't closed on its own
  setTimeout(() => {
    if (!session.closed) {
      console.warn(`[voice-stream] Orphaned DG session still open after 5s, force-closing (user=${session.userId})`)
      closeDgWs(session)
      cleanupTimers(session)
    }
  }, 5000)
}
