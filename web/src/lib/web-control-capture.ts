/**
 * Capture a DOM node to a PNG and upload it to the broker blob store, returning
 * a public URL. Shared by web_screenshot (whole app / selector) and
 * web_terminal_screenshot (an off-screen shell pane). base64 never crosses the
 * agent's context -- the browser uploads (same-origin cookie + files permission)
 * and only the URL travels back.
 */

export async function captureNodeToUrl(el: HTMLElement, pixelRatio = 1): Promise<{ url?: string; error?: string }> {
  // Lazy-load html-to-image (heavy, off the hot path).
  const { toBlob } = await import('html-to-image')
  const bg = getComputedStyle(document.body).backgroundColor || '#0a0a0a'
  const blob = await toBlob(el, { pixelRatio, backgroundColor: bg, cacheBust: true })
  if (!blob) return { error: 'Screenshot capture returned no image' }
  const res = await fetch('/api/files', { method: 'POST', headers: { 'content-type': 'image/png' }, body: blob })
  if (!res.ok) return { error: `Upload failed: HTTP ${res.status}` }
  const data = (await res.json()) as { url?: string }
  if (!data.url) return { error: 'Upload returned no URL' }
  return { url: data.url }
}
