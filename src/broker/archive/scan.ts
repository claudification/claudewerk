/** Line-at-a-time streaming over a compressed archive, with early abort.
 *
 *  Deliberately NOT `readNdjsonZstd`: that one parses every row and hashes the
 *  whole stream, which is right for verification and ruinous for search. A
 *  search reads raw lines, tests them as text, and parses only the ones that
 *  matched -- on a month where three rows hit out of 566k, that is the whole
 *  difference between seconds and minutes.
 */

import { isAvailable } from '../backup/compress'
import { LineSplitter } from './line-stream'

export interface ScanStats {
  bytes: number
  lines: number
  /** True when `onLine` asked to stop before the file ran out. */
  aborted: boolean
}

/** Stream `archivePath` through `zstd -d`, handing each line to `onLine`.
 *
 *  Return `false` from `onLine` to stop: the decompressor is killed on the spot
 *  rather than left to finish a month nobody is reading. */
export async function scanNdjsonZstd(archivePath: string, onLine: (line: string) => boolean): Promise<ScanStats> {
  if (!isAvailable('zstd')) {
    throw new Error('zstd is required to search cold archives but is not on PATH (rebuild the broker image)')
  }
  const proc = Bun.spawn(['zstd', '-d', '--long=27', '-q', '-c', archivePath], { stdout: 'pipe', stderr: 'pipe' })

  const splitter = new LineSplitter()
  const stats: ScanStats = { bytes: 0, lines: 0, aborted: false }

  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    stats.bytes += chunk.length
    for (const line of splitter.push(chunk)) {
      stats.lines++
      if (onLine(line)) continue
      stats.aborted = true
      proc.kill()
      return stats
    }
  }

  const last = splitter.flush()
  if (last !== null) {
    stats.lines++
    if (!onLine(last)) {
      stats.aborted = true
      return stats
    }
  }

  const exit = await proc.exited
  if (exit !== 0) {
    throw new Error(`zstd decompress failed (exit ${exit}): ${await new Response(proc.stderr).text()}`)
  }
  return stats
}
