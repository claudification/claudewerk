/**
 * Unit tests for the link-preview helpers. The SSRF guard (isSafePreviewUrl) is
 * the security-critical one -- the endpoint fetches arbitrary URLs server-side,
 * so the private/loopback rejections must hold. computeFrameable + parseMetaTags
 * cover the "blank iframe vs rich card" decision and OG extraction.
 */
import { describe, expect, it } from 'bun:test'
import { computeFrameable, isSafePreviewUrl, parseMetaTags } from './link-preview'

describe('isSafePreviewUrl', () => {
  it('accepts public http(s) hosts', () => {
    expect(isSafePreviewUrl('https://brain.frst.dev/notes/x')).toBe(true)
    expect(isSafePreviewUrl('http://example.com')).toBe(true)
    expect(isSafePreviewUrl('https://8.8.8.8/')).toBe(true)
  })

  it('rejects non-http(s) schemes', () => {
    expect(isSafePreviewUrl('file:///etc/passwd')).toBe(false)
    expect(isSafePreviewUrl('ftp://example.com')).toBe(false)
    expect(isSafePreviewUrl('data:text/html,<h1>x')).toBe(false)
    expect(isSafePreviewUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects localhost and bare intranet names', () => {
    expect(isSafePreviewUrl('http://localhost:9999')).toBe(false)
    expect(isSafePreviewUrl('http://broker.localhost')).toBe(false)
    expect(isSafePreviewUrl('http://intranet')).toBe(false)
    expect(isSafePreviewUrl('http://printer.local')).toBe(false)
    expect(isSafePreviewUrl('http://db.internal')).toBe(false)
  })

  it('rejects private / loopback / link-local IPv4', () => {
    expect(isSafePreviewUrl('http://127.0.0.1')).toBe(false)
    expect(isSafePreviewUrl('http://10.0.0.5')).toBe(false)
    expect(isSafePreviewUrl('http://192.168.1.1')).toBe(false)
    expect(isSafePreviewUrl('http://172.20.7.12')).toBe(false) // our Synology
    expect(isSafePreviewUrl('http://169.254.1.1')).toBe(false)
    expect(isSafePreviewUrl('http://0.0.0.0')).toBe(false)
  })

  it('allows public ranges adjacent to private ones', () => {
    expect(isSafePreviewUrl('http://172.15.0.1')).toBe(true)
    expect(isSafePreviewUrl('http://172.32.0.1')).toBe(true)
    expect(isSafePreviewUrl('http://11.0.0.1')).toBe(true)
  })

  it('rejects garbage', () => {
    expect(isSafePreviewUrl('not a url')).toBe(false)
    expect(isSafePreviewUrl('')).toBe(false)
  })
})

describe('computeFrameable', () => {
  const h = (init: Record<string, string>) => new Headers(init)

  it('is frameable with no framing headers', () => {
    expect(computeFrameable(h({}))).toBe(true)
  })

  it('rejects X-Frame-Options DENY / SAMEORIGIN', () => {
    expect(computeFrameable(h({ 'x-frame-options': 'DENY' }))).toBe(false)
    expect(computeFrameable(h({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(false)
  })

  it('rejects restrictive CSP frame-ancestors', () => {
    expect(computeFrameable(h({ 'content-security-policy': "frame-ancestors 'none'" }))).toBe(false)
    expect(computeFrameable(h({ 'content-security-policy': "frame-ancestors 'self' https://x.com" }))).toBe(false)
    expect(computeFrameable(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }))).toBe(false)
  })

  it('allows wildcard frame-ancestors', () => {
    expect(computeFrameable(h({ 'content-security-policy': 'frame-ancestors *' }))).toBe(true)
  })

  it('ignores unrelated CSP directives', () => {
    expect(computeFrameable(h({ 'content-security-policy': "default-src 'self'" }))).toBe(true)
  })
})

describe('parseMetaTags', () => {
  it('extracts OG tags regardless of attribute order', () => {
    const html = `
      <meta property="og:title" content="Hello &amp; World">
      <meta content="A description" name="description">
      <meta property="og:image" content="https://x.com/i.png" />
    `
    const m = parseMetaTags(html)
    expect(m.get('og:title')).toBe('Hello & World')
    expect(m.get('description')).toBe('A description')
    expect(m.get('og:image')).toBe('https://x.com/i.png')
  })

  it('keeps the first occurrence of a duplicate key', () => {
    const html = `<meta property="og:title" content="first"><meta property="og:title" content="second">`
    expect(parseMetaTags(html).get('og:title')).toBe('first')
  })
})
