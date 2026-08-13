import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'

// Hash in 1 MiB chunks rather than slurping the whole file. store.db reached
// 7.6 GB, and readFileSync of that blows past V8's single-buffer ceiling with
// ENOMEM -- which silently broke every backup (the 2026-07 incident). Streaming
// keeps memory flat regardless of database size.
export function sha256File(path: string): string {
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const bytesRead = readSync(fd, buf, 0, buf.length, null)
      if (bytesRead <= 0) break
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}
