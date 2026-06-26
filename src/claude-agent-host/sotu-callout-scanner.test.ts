import { describe, expect, it } from 'bun:test'
import { CalloutScanner } from './sotu-callout-scanner'

describe('CalloutScanner', () => {
  it('emits a callout from a single complete chunk', () => {
    const s = new CalloutScanner()
    const out = s.feed('prefix <callout type="insight">x is dead code</callout> suffix')
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('insight')
    expect(out[0].payload).toBe('x is dead code')
  })

  it('emits a lock callout with its claim path', () => {
    const s = new CalloutScanner()
    const out = s.feed('<callout type="lock" path="src/x.ts">refactor</callout>')
    expect(out[0].type).toBe('lock')
    expect(out[0].path).toBe('src/x.ts')
  })

  it('emits multiple callouts in one feed, in document order', () => {
    const s = new CalloutScanner()
    const out = s.feed('a <callout type="insight">one</callout> b <callout type="blocked">two</callout> c')
    expect(out.map(c => c.payload)).toEqual(['one', 'two'])
  })

  // THE HARD CASE: a single callout split across stream chunks at every position.
  it('handles a tag spanning two stream chunks (split mid-open-tag)', () => {
    const s = new CalloutScanner()
    expect(s.feed('before <callout type="ins')).toEqual([])
    const out = s.feed('ight">spanned body</callout> after')
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('insight')
    expect(out[0].payload).toBe('spanned body')
  })

  it('handles a split right at the <callout token boundary', () => {
    const s = new CalloutScanner()
    expect(s.feed('text then <cal')).toEqual([])
    const out = s.feed('lout type="focus">parked here</callout>')
    expect(out[0].type).toBe('focus')
    expect(out[0].payload).toBe('parked here')
  })

  it('handles a split inside the body and inside the close tag', () => {
    const s = new CalloutScanner()
    expect(s.feed('<callout type="dead-end">tried ')).toEqual([])
    expect(s.feed('X, gave up</call')).toEqual([])
    const out = s.feed('out> moving on')
    expect(out[0].type).toBe('dead-end')
    expect(out[0].payload).toBe('tried X, gave up')
  })

  it('reassembles a callout streamed one character at a time', () => {
    const s = new CalloutScanner()
    const src = 'go <callout type="lock" path="a/b.ts">~1h</callout> done'
    const collected = []
    for (const ch of src) collected.push(...s.feed(ch))
    expect(collected).toHaveLength(1)
    expect(collected[0].type).toBe('lock')
    expect(collected[0].path).toBe('a/b.ts')
    expect(collected[0].payload).toBe('~1h')
  })

  it('does not wedge on a false start (<calloutx) before a real callout', () => {
    const s = new CalloutScanner()
    const out = s.feed('<calloutx nope> then <callout type="insight">real</callout>')
    expect(out).toHaveLength(1)
    expect(out[0].payload).toBe('real')
  })

  it('skips a closed-but-invalid-type tag and resyncs on the next valid one', () => {
    const s = new CalloutScanner()
    const out = s.feed('<callout type="bogus">nope</callout><callout type="focus">yes</callout>')
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('focus')
  })

  it('keeps waiting on an unterminated tag without emitting', () => {
    const s = new CalloutScanner()
    expect(s.feed('<callout type="insight">never closes')).toEqual([])
    expect(s.feed(' and still going')).toEqual([])
  })

  it('reset() discards a buffered partial tag', () => {
    const s = new CalloutScanner()
    expect(s.feed('<callout type="insight">partial')).toEqual([])
    s.reset()
    // The dangling open tag is gone; only the new complete callout emits.
    const out = s.feed('</callout> <callout type="lock">fresh</callout>')
    expect(out).toHaveLength(1)
    expect(out[0].payload).toBe('fresh')
  })

  it('does not re-emit an already-emitted callout on the next feed', () => {
    const s = new CalloutScanner()
    expect(s.feed('<callout type="insight">once</callout>')).toHaveLength(1)
    expect(s.feed(' more prose with no callouts')).toEqual([])
  })
})
