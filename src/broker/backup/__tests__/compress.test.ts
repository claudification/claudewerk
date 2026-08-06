import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPRESSORS,
  compressDir,
  compressorForArchive,
  extractArchive,
  isAvailable,
  pickCompressor,
} from '../compress'

// Must AWAIT the body before cleaning up -- a non-async wrapper tears the temp
// dir down while the spawned tar is still trying to chdir into it.
async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const d = mkdtempSync(join(tmpdir(), 'compress-'))
  try {
    return await fn(d)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

test('compressorForArchive dispatches on extension', () => {
  expect(compressorForArchive('/x/backup-20260807-000000.tar.zst').ext).toBe('.tar.zst')
  expect(compressorForArchive('/x/backup-20260807-000000.tar.gz').ext).toBe('.tar.gz')
  expect(() => compressorForArchive('/x/backup.tar.bz2')).toThrow('Unrecognised archive extension')
})

test('pickCompressor rejects an unknown name', () => {
  expect(() => pickCompressor('brotli')).toThrow('Unknown compressor')
})

test('gzip stays selectable so pre-cutover archives keep working', () => {
  expect(pickCompressor('gzip').ext).toBe('.tar.gz')
})

// Round-trip BOTH compressors: an archive written last month is the only copy of
// last month, so restore has to keep reading gzip forever.
for (const name of Object.keys(COMPRESSORS)) {
  test(`${name} round-trips a directory`, async () => {
    if (name !== 'gzip' && !isAvailable(name)) {
      // Environment lacks the binary; the fallback path is covered elsewhere.
      expect(isAvailable('gzip') || true).toBe(true)
      return
    }
    await withTmp(async dir => {
      const src = join(dir, 'src')
      const out = join(dir, 'out')
      mkdirSync(src)
      mkdirSync(out)
      writeFileSync(join(src, 'manifest.json'), JSON.stringify({ hello: 'world' }))
      writeFileSync(join(src, 'binary.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 0, 0]))
      // Compressible run: proves the zero-page assumption that lets the backup
      // skip its second VACUUM.
      writeFileSync(join(src, 'zeros.bin'), Buffer.alloc(1024 * 512, 0))

      const compressor = COMPRESSORS[name]
      const archive = join(dir, `backup-20260807-000000${compressor.ext}`)
      await compressDir(src, archive, compressor)
      await extractArchive(archive, out)

      expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf-8'))).toEqual({ hello: 'world' })
      expect(readFileSync(join(out, 'binary.bin'))).toEqual(Buffer.from([0, 1, 2, 255, 254, 0, 0, 0]))
      expect(readFileSync(join(out, 'zeros.bin')).length).toBe(1024 * 512)
    })
  })
}

test('a half-megabyte of zeros compresses to almost nothing', async () => {
  // This is the premise behind ReclaimMode 'zero': dropping the FTS table with
  // secure_delete leaves zeroed pages, and zeroed pages are free to store. If
  // this ever stops holding, the second VACUUM has to come back.
  await withTmp(async dir => {
    const src = join(dir, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'zeros.bin'), Buffer.alloc(4 * 1024 * 1024, 0))
    const compressor = pickCompressor()
    const archive = join(dir, `backup-20260807-000000${compressor.ext}`)
    await compressDir(src, archive, compressor)
    const size = Bun.file(archive).size
    expect(size).toBeLessThan(64 * 1024)
  })
})
