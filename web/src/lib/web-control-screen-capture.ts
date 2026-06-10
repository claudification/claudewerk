/**
 * Screen capture for web_screenshot via getDisplayMedia.
 *
 * Why not html-to-image: cloning the whole DOM + inlining every computed style
 * is synchronous and blocked the main thread for ~70s on Safari (then failed --
 * Safari refuses the foreignObject->img step). getDisplayMedia is a compositor
 * capture: NO DOM walk, no freeze, real pixels (even canvas/WebGL).
 *
 * Why not ImageCapture/grabFrame: still unsupported in WebKit (2026). We draw the
 * live <video> to a 2D canvas instead -- the Safari-correct path.
 *
 * Platform constraint: getDisplayMedia REQUIRES a transient user activation, so we
 * CANNOT call it from an agent-triggered op. The stream is acquired from a "Share
 * screen" click (a user gesture) and CACHED for the grant; agent screenshots then
 * draw frames from the cached stream -- no re-prompt, no gesture.
 */

let stream: MediaStream | null = null
let video: HTMLVideoElement | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

export function subscribeScreenShare(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** True while a live shared stream exists (useSyncExternalStore snapshot). */
export function hasScreenShare(): boolean {
  return !!stream && stream.getVideoTracks().some(t => t.readyState === 'live')
}

/** Whether getDisplayMedia exists at all. FALSE in a Safari standalone PWA (WebKit
 *  does not expose screen capture to installed web apps) -- the caller then falls
 *  back to a DOM rasterizer instead of offering a Share-screen button that errors. */
export function isScreenShareSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
}

function describeMediaError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'NotAllowedError') return 'Screen-share permission was denied or dismissed.'
    return e.message || e.name
  }
  return String(e)
}

/** User-gesture entry: prompt once, cache the stream + a playing <video>. */
export async function startScreenShare(): Promise<{ ok: boolean; error?: string }> {
  if (hasScreenShare()) return { ok: true }
  const md = navigator.mediaDevices
  if (!md?.getDisplayMedia) return { ok: false, error: 'getDisplayMedia is not supported in this browser.' }
  try {
    const opts: DisplayMediaStreamOptions = { video: { displaySurface: 'browser' }, audio: false }
    const s = await md.getDisplayMedia(opts)
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.srcObject = s
    await v.play().catch(() => {})
    // The user can stop sharing from the browser's own UI -> drop our cache.
    for (const t of s.getVideoTracks()) t.addEventListener('ended', () => stopScreenShare())
    stream = s
    video = v
    notify()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: describeMediaError(e) }
  }
}

export function stopScreenShare(): void {
  if (!stream) return
  for (const t of stream.getTracks()) t.stop()
  stream = null
  video = null
  notify()
}

/** Map a CSS-pixel element rect into the captured frame's pixel space. */
function cropRect(el: HTMLElement, vw: number, vh: number): { sx: number; sy: number; sw: number; sh: number } | null {
  const r = el.getBoundingClientRect()
  const scaleX = vw / window.innerWidth
  const scaleY = vh / window.innerHeight
  const sx = Math.max(0, r.left * scaleX)
  const sy = Math.max(0, r.top * scaleY)
  const sw = Math.min(vw - sx, r.width * scaleX)
  const sh = Math.min(vh - sy, r.height * scaleY)
  if (sw <= 0 || sh <= 0) return null
  return { sx, sy, sw, sh }
}

/**
 * Draw the current frame (optionally cropped to a DOM element's viewport rect) to
 * a canvas, then upload the PNG to the broker blob store and return its URL. The
 * base64 never crosses the agent's context -- only the URL travels back.
 */
export async function captureScreenToUrl(cropEl?: HTMLElement | null): Promise<{ url?: string; error?: string }> {
  if (!stream || !video) {
    return { error: 'Screen sharing is not armed. Ask the user to click "Share screen" in Settings > System > Debug.' }
  }
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return { error: 'Screen share has no frame yet -- try again in a moment.' }

  let src = { sx: 0, sy: 0, sw: vw, sh: vh }
  if (cropEl) {
    const r = cropRect(cropEl, vw, vh)
    if (!r) return { error: 'The selector element is scrolled off-screen or has no size.' }
    src = r
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(src.sw)
  canvas.height = Math.round(src.sh)
  const ctx = canvas.getContext('2d')
  if (!ctx) return { error: 'Could not acquire a 2D canvas context.' }
  ctx.drawImage(video, src.sx, src.sy, src.sw, src.sh, 0, 0, canvas.width, canvas.height)

  const blob = await new Promise<Blob | null>(res => canvas.toBlob(b => res(b), 'image/png'))
  if (!blob) return { error: 'Canvas produced no image.' }
  const res = await fetch('/api/files', { method: 'POST', headers: { 'content-type': 'image/png' }, body: blob })
  if (!res.ok) return { error: `Upload failed: HTTP ${res.status}` }
  const data = (await res.json()) as { url?: string }
  return data.url ? { url: data.url } : { error: 'Upload returned no URL.' }
}
