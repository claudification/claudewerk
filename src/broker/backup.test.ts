import { createHash } from 'node:crypto'
import { closeSync, createReadStream, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { sha256File } from './backup'

// Independent reference hash: stream via createReadStream (a different code path
// than sha256File's readSync loop) so the two can't share a bug.
function referenceHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-sha-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('sha256File matches reference across chunk boundaries', async () => {
  // 3 MiB + a few bytes: forces multiple full 1 MiB reads plus a short final
  // read, exercising the buf.subarray(0, bytesRead) tail path.
  const path = join(dir, 'multi-chunk.bin')
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 777, 0)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
  writeFileSync(path, bytes)
  expect(sha256File(path)).toBe(await referenceHash(path))
})

test('sha256File streams a >2GB file without ENOMEM', async () => {
  // The bug: readFileSync of store.db (grew to 7.6 GB) threw ENOMEM /
  // ERR_FS_FILE_TOO_LARGE past V8's ~2 GB single-buffer ceiling, silently
  // killing every backup. A sparse 2.1 GB file reproduces it with ~no disk
  // cost: the old readFileSync path throws here, the streaming path does not.
  const path = join(dir, 'huge-sparse.bin')
  const fd = openSync(path, 'w')
  ftruncateSync(fd, 2 * 1024 * 1024 * 1024 + 1024 * 1024) // 2 GiB + 1 MiB
  closeSync(fd)
  expect(sha256File(path)).toBe(await referenceHash(path))
}, 60_000)
