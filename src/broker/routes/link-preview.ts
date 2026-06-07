/**
 * Link preview fetcher for the mobile in-app preview pane.
 *
 * The control panel intercepts external link taps on mobile (a standalone PWA
 * has no back button, so a real navigation traps the user) and opens them in a
 * contained pane instead. To render that pane well we need two things the
 * browser can't get cross-origin itself (CORS hides response headers and bodies):
 *
 *   1. Whether the site permits being framed (X-Frame-Options / CSP
 *      frame-ancestors). If not, the pane shows a rich link card instead of a
 *      blank iframe.
 *   2. OpenGraph metadata (title / description / image / favicon) for that card.
 *
 * SSRF NOTE: this endpoint fetches arbitrary URLs on the broker's behalf. It is
 * gated behind requireAuth (only authenticated control-panel users reach it),
 * and isSafePreviewUrl() rejects non-http(s) schemes and private/loopback hosts.
 * Redirects are followed by fetch(); a redirect that bounces to an internal host
 * is the residual gap (we validate the input host, not every hop) -- acceptable
 * for a single-tenant personal deployment, flagged here for whoever widens it.
 */

export interface LinkPreview {
  /** The URL we fetched (the input; redirects are followed transparently). */
  url: string
  /** True when the site allows being embedded in an <iframe>. */
  frameable: boolean
  title?: string
  description?: string
  image?: string
  favicon?: string
  siteName?: string
}

const FETCH_TIMEOUT_MS = 6000
// Cap how much HTML we read for OG parsing -- metadata lives in <head>, so the
// first chunk is plenty and a 200MB page won't OOM the broker.
const MAX_HTML_BYTES = 512 * 1024

/**
 * Reject schemes and hosts that have no business being fetched server-side:
 * non-http(s), localhost, link-local, and RFC1918 private ranges. Hostname-based
 * (no DNS resolution), so it stops the obvious cases without a resolver round-trip.
 */
export function isSafePreviewUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.endsWith('.local') || host.endsWith('.internal')) return false
  // Bare single-label hostnames (no dot) are intranet names -- skip.
  if (!host.includes('.') && !host.includes(':')) return false
  // IPv6 loopback / unspecified
  if (host === '::1' || host === '::') return false
  // IPv4 literal private / loopback / link-local ranges
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127 || a === 10 || a === 0) return false
    if (a === 169 && b === 254) return false
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
  }
  return true
}

/** Parse `<meta>` attributes tolerantly (attribute order varies wildly). */
export function parseMetaTags(html: string): Map<string, string> {
  const out = new Map<string, string>()
  const metaRe = /<meta\b[^>]*>/gi
  for (const tag of html.match(metaRe) ?? []) {
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1]
    if (key && content != null && !out.has(key.toLowerCase())) {
      out.set(key.toLowerCase(), decodeEntities(content))
    }
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x2f;/gi, '/')
}

function absolutize(maybeRelative: string | undefined, base: string): string | undefined {
  if (!maybeRelative) return undefined
  try {
    return new URL(maybeRelative, base).toString()
  } catch {
    return undefined
  }
}

/**
 * A site is NOT frameable when it sends X-Frame-Options DENY/SAMEORIGIN, or a
 * CSP frame-ancestors that excludes us. We can't know "us" matches their
 * allow-list cross-origin, so any restrictive frame-ancestors is treated as
 * not-frameable (conservative -> show the card, never a blank iframe).
 */
export function computeFrameable(headers: Headers): boolean {
  const xfo = headers.get('x-frame-options')?.toLowerCase() ?? ''
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return false
  const csp = headers.get('content-security-policy')?.toLowerCase() ?? ''
  const fa = csp.match(/frame-ancestors([^;]*)/)?.[1]?.trim()
  if (fa != null) {
    // 'none' or any restrictive list -> not frameable. Only a bare `*` permits all.
    if (fa === "'none'" || fa === '') return false
    if (!fa.split(/\s+/).includes('*')) return false
  }
  return true
}

export async function fetchLinkPreview(url: string): Promise<LinkPreview> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // Identify honestly + ask for HTML so servers return the OG-bearing page.
        'user-agent': 'ClaudewerkLinkPreview/1.0 (+https://concentrator.frst.dev)',
        accept: 'text/html,application/xhtml+xml',
      },
    })
    const frameable = computeFrameable(res.headers)
    const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
    // Only parse HTML for OG tags; non-HTML (PDF, image direct link) has none.
    let meta = new Map<string, string>()
    if (contentType.includes('html')) {
      const html = await readCapped(res, MAX_HTML_BYTES)
      meta = parseMetaTags(html)
      const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      if (titleTag && !meta.has('og:title')) meta.set('og:title', decodeEntities(titleTag.trim()))
      const iconHref = html
        .match(/<link\b[^>]*\brel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/i)?.[0]
        ?.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
      if (iconHref) meta.set('__favicon', iconHref)
    } else {
      try {
        await res.body?.cancel()
      } catch {
        /* already consumed/closed */
      }
    }

    const finalUrl = res.url || url
    return {
      url,
      frameable,
      title: meta.get('og:title') || meta.get('twitter:title'),
      description: meta.get('og:description') || meta.get('twitter:description') || meta.get('description'),
      image: absolutize(meta.get('og:image') || meta.get('twitter:image'), finalUrl),
      siteName: meta.get('og:site_name'),
      favicon: absolutize(meta.get('__favicon') || '/favicon.ico', finalUrl),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Read a response body as text, stopping once `maxBytes` is reached. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* stream already done */
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks, total))
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    if (off + c.length > total) {
      out.set(c.subarray(0, total - off), off)
      break
    }
    out.set(c, off)
    off += c.length
  }
  return out
}
