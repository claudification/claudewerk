/**
 * voice-mic-stream - Warm microphone stream cache + acquisition.
 *
 * Split out of use-voice-recording so the hook stays focused on the recording
 * state machine. This module owns the module-level mic stream that survives
 * across recording cycles: the first start() acquires it (cold ~2-3s on macOS),
 * subsequent starts reuse it instantly (0ms).
 * - Normal mode: released after 30s of inactivity
 * - keepMicOpen mode: released after 30min of inactivity + banner shown
 */

import { useConversationsStore } from '@/hooks/use-conversations'

const KEEP_MIC_IDLE_TTL = 30 * 60_000
let warmStream: MediaStream | null = null
let warmStreamTimer: ReturnType<typeof setTimeout> | null = null
let micExpiredFlag = false
const micExpiredListeners = new Set<() => void>()

/** True when the stream exists AND its audio track is actually live (not ended). */
export function isStreamLive(stream: MediaStream | null): stream is MediaStream {
  if (!stream) return false
  const track = stream.getAudioTracks()[0]
  return !!track && track.readyState === 'live'
}

export function setMicExpired(expired: boolean) {
  if (micExpiredFlag === expired) return
  micExpiredFlag = expired
  for (const fn of micExpiredListeners) fn()
}

export function subscribeMicExpired(fn: () => void): () => void {
  micExpiredListeners.add(fn)
  return () => micExpiredListeners.delete(fn)
}

export function getMicExpired() {
  return micExpiredFlag
}

export function dismissMicExpired() {
  setMicExpired(false)
}

export function releaseWarmStream() {
  const wasKeepOpen = useConversationsStore.getState().controlPanelPrefs.keepMicOpen
  if (warmStream) {
    for (const t of warmStream.getTracks()) t.stop()
    warmStream = null
    console.log(`[voice] warm stream released (${wasKeepOpen ? '30min' : '30s'} idle timeout)`)
  }
  warmStreamTimer = null
  if (wasKeepOpen) setMicExpired(true)
}

export function scheduleStreamRelease() {
  if (warmStreamTimer) clearTimeout(warmStreamTimer)
  const prefs = useConversationsStore.getState().controlPanelPrefs
  const ttl = prefs.keepMicOpen ? KEEP_MIC_IDLE_TTL : (prefs.voiceWarmStreamMs ?? 30_000)
  warmStreamTimer = setTimeout(releaseWarmStream, ttl)
  if (prefs.keepMicOpen) console.log('[voice] keepMicOpen: mic idle timer set (30min)')
}

function preferredDeviceId(): string {
  return useConversationsStore.getState().controlPanelPrefs.voiceDeviceId || ''
}

function micConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      // echoCancellation MUST stay off: on macOS, enabling it routes the input
      // through CoreAudio's VoiceProcessingIO unit, which flips the system into
      // "communication" mode and ducks/pauses all other media (Jonas's music
      // stopping). We capture a single close-talk voice, so OS AEC buys nothing.
      echoCancellation: false,
      noiseSuppression: true,
      // `exact` pins THIS physical mic so the same device is reused on every
      // attach and across reloads -- a bare/ideal deviceId silently falls back
      // to the OS default when it doesn't match (the "wrong mic" symptom).
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  }
}

/**
 * True for a REAL hardware mic id. False for Chrome's virtual aggregate entries
 * ('default' / 'communications') whose id tracks whatever the OS default is --
 * pinning one silently follows a Bluetooth headset when it connects. Used both
 * to skip auto-persisting virtual ids and to keep them out of the device picker.
 */
export function isPinnableDevice(id: string): boolean {
  return !!id && id !== 'default' && id !== 'communications'
}

/** Release the warm stream so the next recording picks up a new device. */
export function invalidateWarmStream() {
  if (warmStream) {
    for (const t of warmStream.getTracks()) t.stop()
    warmStream = null
  }
  if (warmStreamTimer) {
    clearTimeout(warmStreamTimer)
    warmStreamTimer = null
  }
}

/** Pre-warm the mic stream (fire-and-forget). Call on mount when keepMicOpen is enabled. */
export function prewarmMicStream() {
  setMicExpired(false)
  if (isStreamLive(warmStream)) return
  acquireMicStream().catch(err => console.warn('[voice] prewarm failed:', err))
}

/**
 * Reuse the cached warm stream if it's live AND matches the wanted device;
 * otherwise stop it and return null so the caller re-acquires. The "wrong mic"
 * symptom is avoided by re-acquiring on device mismatch.
 */
function reuseOrDropWarmStream(wantDevice: string): MediaStream | null {
  if (!isStreamLive(warmStream)) return null
  const activeDevice = warmStream.getAudioTracks()[0]?.getSettings().deviceId ?? ''
  if (!wantDevice || activeDevice === wantDevice) {
    console.log(`[voice] reusing warm stream (0ms, device=${activeDevice.slice(0, 8) || 'default'})`)
    return warmStream
  }
  console.log(
    `[voice] device mismatch (have=${activeDevice.slice(0, 8)}, want=${wantDevice.slice(0, 8)}), re-acquiring`,
  )
  for (const t of warmStream.getTracks()) t.stop()
  warmStream = null
  return null
}

/**
 * getUserMedia with a fallback: a pinned mic that's gone (unplugged / id rotated
 * after a permission reset) makes the `exact` constraint throw
 * OverconstrainedError. Fall back to the OS default this once but keep the saved
 * preference so the same mic re-pins when it's plugged back in.
 */
async function openMicStream(wantDevice: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(wantDevice))
  } catch (err) {
    if (wantDevice && (err as Error)?.name === 'OverconstrainedError') {
      console.warn(`[voice] pinned mic ${wantDevice.slice(0, 8)} unavailable, falling back to default`)
      return navigator.mediaDevices.getUserMedia(micConstraints(''))
    }
    throw err
  }
}

/**
 * Open a throwaway stream on the PREFERRED device for a transient grant (mic
 * permission probe, device-label unlock) -- never the OS default, so a selected
 * non-default mic is the only device touched and a Bluetooth headset isn't
 * yanked from A2DP into HFP. Honours the same `exact` pin + fallback as the
 * record path. Caller owns the stream and MUST stop its tracks. On true
 * first-run (nothing persisted yet) this opens the default once, unavoidably.
 */
export function openPreferredMicStream(): Promise<MediaStream> {
  return openMicStream(preferredDeviceId())
}

/**
 * Pin the resolved device the first time we acquire with no explicit choice, so
 * the SAME physical mic is reused on every later attach and after a reload --
 * even for users who never opened the device picker.
 */
function pinResolvedDevice(wantDevice: string, gotDevice: string) {
  if (!wantDevice && isPinnableDevice(gotDevice) && gotDevice !== preferredDeviceId()) {
    useConversationsStore.getState().updateControlPanelPrefs({ voiceDeviceId: gotDevice })
    console.log(`[voice] pinned default mic ${gotDevice.slice(0, 8)} for future attaches`)
  }
}

export async function acquireMicStream(): Promise<MediaStream> {
  if (warmStreamTimer) {
    clearTimeout(warmStreamTimer)
    warmStreamTimer = null
  }
  const wantDevice = preferredDeviceId()
  const reused = reuseOrDropWarmStream(wantDevice)
  if (reused) return reused

  const t0 = performance.now()
  const stream = await openMicStream(wantDevice)
  const gotDevice = stream.getAudioTracks()[0]?.getSettings().deviceId ?? ''
  console.log(
    `[voice] mic acquired in ${(performance.now() - t0).toFixed(0)}ms (device=${(gotDevice || 'unknown').slice(0, 8)})`,
  )
  pinResolvedDevice(wantDevice, gotDevice)
  warmStream = stream
  return stream
}
