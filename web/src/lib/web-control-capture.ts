/**
 * Capture a DOM node to a PNG and upload it to the broker blob store, returning
 * a public URL. Shared by web_terminal_screenshot (an off-screen shell pane) and,
 * as a FALLBACK, web_screenshot when getDisplayMedia is unavailable (Safari PWA).
 * base64 never crosses the agent's context -- the browser uploads (same-origin
 * cookie + files permission) and only the URL travels back.
 *
 * NO cacheBust: appending `?<rand>` to every resource URL forced re-fetches that
 * hung in Safari, blocking the main thread to the op timeout (~70s). Without it,
 * resources resolve from cache instantly. skipFonts avoids embedding webfonts
 * (another Safari foreignObject failure mode).
 */

export async function captureNodeToUrl(el: HTMLElement, pixelRatio = 1): Promise<{ url?: string; error?: string }> {
  // Lazy-load html-to-image (heavy, off the hot path).
  const { toBlob } = await import('html-to-image')
  const bg = getComputedStyle(document.body).backgroundColor || '#0a0a0a'
  const blob = await toBlob(el, { pixelRatio, backgroundColor: bg, skipFonts: true })
  if (!blob) return { error: 'Screenshot capture returned no image' }
  const res = await fetch('/api/files', { method: 'POST', headers: { 'content-type': 'image/png' }, body: blob })
  if (!res.ok) return { error: `Upload failed: HTTP ${res.status}` }
  const data = (await res.json()) as { url?: string }
  if (!data.url) return { error: 'Upload returned no URL' }
  return { url: data.url }
}
