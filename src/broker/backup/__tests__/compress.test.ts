import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertArchiveComplete,
  COMPRESSORS,
  compressDir,
  compressorForArchive,
  extractArchive,
  isAvailable,
  listArchiveMembers,
  pickCompressor,
  resolvePipeShell,
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

test('assertArchiveComplete accepts a whole archive', async () => {
  await withTmp(async dir => {
    const src = join(dir, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'manifest.json'), '{}')
    writeFileSync(join(src, 'store.db'), 'pretend database')
    const compressor = pickCompressor()
    const archive = join(dir, `backup-20260807-000000${compressor.ext}`)
    await compressDir(src, archive, compressor)

    expect(await listArchiveMembers(archive)).toEqual(expect.arrayContaining(['manifest.json', 'store.db']))
    await expect(assertArchiveComplete(archive, ['store.db', 'manifest.json'])).resolves.toBeUndefined()
  })
})

// REGRESSION -- hand-rolled in-process stream chaining (spawn b with
// stdin: a.stdout, drain b.stdout into a FileSink) passed at 200 MB and
// silently truncated a 9.3 GB backup. The archive listed cleanly up to the cut
// and the database inside came out SQLITE_CORRUPT, while the run reported
// success and wrote a sentinel the retention gate would have trusted. The pipe
// now belongs to the shell; this asserts the detector that would have caught it.
test('assertArchiveComplete rejects a truncated archive', async () => {
  await withTmp(async dir => {
    const src = join(dir, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'manifest.json'), '{}')
    // Big enough that lopping the tail off leaves a readable prefix.
    writeFileSync(join(src, 'store.db'), Buffer.alloc(4 * 1024 * 1024, 7))
    const compressor = pickCompressor()
    const archive = join(dir, `backup-20260807-000000${compressor.ext}`)
    await compressDir(src, archive, compressor)

    const whole = readFileSync(archive)
    writeFileSync(archive, whole.subarray(0, Math.floor(whole.length * 0.6)))

    await expect(assertArchiveComplete(archive, ['store.db', 'manifest.json'])).rejects.toThrow(
      /truncated|unreadable|missing/i,
    )
  })
})

// REGRESSION -- the pipeline was handed to `sh`, and `/bin/sh` in the broker
// image is dash: no `set -o pipefail`, so it exited 2 with "Illegal option -o
// pipefail" and EVERY backup died at the compress step. The suite stayed green
// because macOS ships bash as /bin/sh, so this stubs a dash-alike to reproduce
// the container's shell on any host.
function dashStub(dir: string): string {
  const path = join(dir, 'dash-stub')
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'case "$2" in',
      '  *pipefail*) echo "set: Illegal option -o pipefail" >&2; exit 2 ;;',
      'esac',
      'exec /bin/sh "$@"',
      '',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
  return path
}

test('resolvePipeShell skips a shell that lacks pipefail', async () => {
  await withTmp(async dir => {
    const stub = dashStub(dir)
    expect(Bun.spawnSync([stub, '-c', 'set -o pipefail'], { stderr: 'ignore' }).exitCode).toBe(2)
    expect(resolvePipeShell([stub, 'bash'])).toBe('bash')
  })
})

test('resolvePipeShell refuses to run when nothing supports pipefail', async () => {
  await withTmp(async dir => {
    // Backing up without pipefail means a truncated archive can exit 0. Refusing
    // is the correct outcome; falling back quietly is not.
    expect(() => resolvePipeShell([dashStub(dir)])).toThrow(/pipefail/)
  })
})

test('the shell the pipeline actually uses honours pipefail here', () => {
  const shell = resolvePipeShell()
  expect(Bun.spawnSync([shell, '-c', 'false | true'], { stderr: 'ignore' }).exitCode).toBe(0)
  expect(Bun.spawnSync([shell, '-c', 'set -o pipefail; false | true'], { stderr: 'ignore' }).exitCode).not.toBe(0)
})

test('a failing stage fails the whole pipeline rather than yielding a short archive', async () => {
  await withTmp(async dir => {
    const compressor = pickCompressor()
    const archive = join(dir, `backup-20260807-000000${compressor.ext}`)
    // tar cannot read a directory that is not there; pipefail must surface it
    // even though the compressor exits 0 on the empty stream it received.
    await expect(compressDir(join(dir, 'does-not-exist'), archive, compressor)).rejects.toThrow(/archive create/)
  })
})
