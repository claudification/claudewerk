import { createHash, type Hash } from 'node:crypto'
import { isAvailable } from '../backup/compress'

/** Streaming NDJSON <-> zstd.
 *
 *  Everything here streams. A month of transcript is 2.5 GB of text and 566k
 *  rows; materialising either side in memory is how you turn an archive job
 *  into an OOM kill. Rows go out through a spawned zstd's stdin in batches, and
 *  come back in through its stdout a chunk at a time. */

const BATCH_BYTES = 4 * 1024 * 1024

function requireZstd(): void {
  if (!isAvailable('zstd')) {
    throw new Error('zstd is required for cold archives but is not on PATH (rebuild the broker image)')
  }
}

export interface NdjsonWriterResult {
  plaintextSha256: string
  plaintextBytes: number
}

/** Writes newline-delimited JSON into `outPath`, compressed with zstd, while
 *  hashing the UNCOMPRESSED bytes. The hash is the integrity anchor: it does
 *  not change if we ever re-compress at a different level. */
export class NdjsonZstdWriter {
  private proc: Bun.Subprocess<'pipe', 'ignore', 'pipe'>
  private hash: Hash = createHash('sha256')
  private bytes = 0
  private pending: string[] = []
  private pendingBytes = 0

  constructor(outPath: string, level: number) {
    requireZstd()
    this.proc = Bun.spawn(['zstd', '-T0', `-${level}`, '--long=27', '-q', '-f', '-o', outPath], {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'pipe',
    }) as Bun.Subprocess<'pipe', 'ignore', 'pipe'>
  }

  async writeRow(row: unknown): Promise<void> {
    const line = `${JSON.stringify(row)}\n`
    this.pending.push(line)
    this.pendingBytes += Buffer.byteLength(line)
    if (this.pendingBytes >= BATCH_BYTES) await this.flushBatch()
  }

  private async flushBatch(): Promise<void> {
    if (this.pendingBytes === 0) return
    const chunk = Buffer.from(this.pending.join(''))
    this.pending = []
    this.pendingBytes = 0
    this.hash.update(chunk)
    this.bytes += chunk.length
    this.proc.stdin.write(chunk)
    await this.proc.stdin.flush()
  }

  async close(): Promise<NdjsonWriterResult> {
    await this.flushBatch()
    this.proc.stdin.end()
    const exit = await this.proc.exited
    if (exit !== 0) {
      throw new Error(`zstd compress failed (exit ${exit}): ${await new Response(this.proc.stderr).text()}`)
    }
    return { plaintextSha256: this.hash.digest('hex'), plaintextBytes: this.bytes }
  }
}

export interface NdjsonReadResult {
  rows: number
  plaintextSha256: string
  plaintextBytes: number
}

/** Streams `archivePath` back through zstd -d, hands each parsed row to
 *  `onRow`, and recomputes the plaintext hash as it goes. */
export async function readNdjsonZstd(
  archivePath: string,
  onRow: (row: Record<string, unknown>, index: number) => void | Promise<void>,
): Promise<NdjsonReadResult> {
  requireZstd()
  const proc = Bun.spawn(['zstd', '-d', '--long=27', '-q', '-c', archivePath], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const hash = createHash('sha256')
  // A streaming decoder is mandatory, not a nicety. Chunk boundaries land
  // mid-character constantly on real transcript text, and a per-chunk
  // buf.toString('utf-8') turns every straddling multi-byte character into
  // U+FFFD. The file stays byte-perfect, so the sha256 still matches and the
  // corruption only shows up when the decoded rows are compared against the
  // database -- which is exactly the check that guards deletion.
  const decoder = new TextDecoder('utf-8')
  let bytes = 0
  let rows = 0
  let carry = ''

  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    const buf = Buffer.from(chunk)
    hash.update(buf)
    bytes += buf.length

    // Rows straddle chunk boundaries too, so the tail after the last newline is
    // carried forward rather than parsed.
    const text = carry + decoder.decode(buf, { stream: true })
    const lines = text.split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      await onRow(JSON.parse(line) as Record<string, unknown>, rows)
      rows++
    }
  }

  carry += decoder.decode()
  if (carry.trim()) {
    await onRow(JSON.parse(carry) as Record<string, unknown>, rows)
    rows++
  }

  const exit = await proc.exited
  if (exit !== 0) {
    throw new Error(`zstd decompress failed (exit ${exit}): ${await new Response(proc.stderr).text()}`)
  }

  return { rows, plaintextSha256: hash.digest('hex'), plaintextBytes: bytes }
}
