/** Chunk bytes -> whole lines, shared by the archive reader and the scanner.
 *
 *  Two things go wrong if this is hand-rolled per call site, and both did:
 *
 *  1. Decoding each chunk on its own (`buf.toString('utf-8')`) turns every
 *     multi-byte character that straddles a chunk boundary into U+FFFD. That
 *     happens constantly on real transcript text, the file stays byte-perfect,
 *     and the corruption only surfaces when decoded rows are compared against
 *     the database -- the very check that guards deletion.
 *  2. Rows straddle chunk boundaries too, so the tail after the last newline
 *     has to be carried forward rather than parsed.
 */
export class LineSplitter {
  private decoder = new TextDecoder('utf-8')
  private carry = ''

  /** Complete lines from this chunk. Blank lines are dropped -- NDJSON has none
   *  and a trailing newline would otherwise yield one every time. */
  push(buf: Uint8Array): string[] {
    const text = this.carry + this.decoder.decode(buf, { stream: true })
    const lines = text.split('\n')
    this.carry = lines.pop() ?? ''
    return lines.filter(Boolean)
  }

  /** Whatever is left after the last chunk, or null when the stream ended on a
   *  newline. */
  flush(): string | null {
    const rest = this.carry + this.decoder.decode()
    this.carry = ''
    return rest.trim() ? rest : null
  }
}
