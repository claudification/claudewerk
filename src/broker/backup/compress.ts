/** Archive compression strategy.
 *
 * gzip is single-threaded and was the whole reason a backup run pinned a core
 * for minutes while streaming ~9 GB through the guest page cache. zstd -T0
 * saturates every core and finishes several times faster, which shrinks the
 * page-cache pressure *window* -- that is the actual RAM fix, not the ~20%
 * smaller output.
 *
 * Both compressors stay readable forever: an archive written last month is the
 * only copy of last month, so `restore` and `list` dispatch on the extension
 * rather than on whatever the current default happens to be.
 */

export interface Compressor {
  /** Archive suffix, including `.tar`. */
  ext: string
  /** argv that reads a tar stream on stdin and writes the archive body to stdout. */
  compressArgv: string[]
  /** argv that reads the archive body on stdin and writes a tar stream to stdout. */
  decompressArgv: string[]
}

const ZSTD_LEVEL = process.env.CLAUDWERK_ZSTD_LEVEL || '10'

export const COMPRESSORS: Record<string, Compressor> = {
  zstd: {
    ext: '.tar.zst',
    // -T0 = one worker per core. --long=27 widens the match window to 128 MB,
    // which matters a lot on a database snapshot full of repeated page headers.
    compressArgv: ['zstd', '-T0', `-${ZSTD_LEVEL}`, '--long=27', '-q', '-c'],
    decompressArgv: ['zstd', '-d', '--long=27', '-q', '-c'],
  },
  gzip: {
    ext: '.tar.gz',
    compressArgv: ['gzip', '-c'],
    decompressArgv: ['gzip', '-dc'],
  },
}

const EXT_TO_COMPRESSOR: Record<string, string> = {
  '.tar.zst': 'zstd',
  '.tar.gz': 'gzip',
}

let cachedAvailable: string | null = null

/** True when the binary is on PATH. zstd is NOT in debian:bookworm-slim -- the
 *  Dockerfile installs it -- so a broker running an older image must silently
 *  keep working on gzip rather than failing every backup. */
export function isAvailable(name: string): boolean {
  try {
    const probe = Bun.spawnSync([name, '--version'], { stdout: 'ignore', stderr: 'ignore' })
    return probe.exitCode === 0
  } catch {
    return false
  }
}

/** Preferred compressor, honouring an explicit override and falling back to
 *  gzip when zstd is missing from the image. Result is cached per process. */
export function pickCompressor(explicit?: string): Compressor {
  if (explicit) {
    const chosen = COMPRESSORS[explicit]
    if (!chosen) throw new Error(`Unknown compressor: ${explicit} (have: ${Object.keys(COMPRESSORS).join(', ')})`)
    if (explicit !== 'gzip' && !isAvailable(explicit)) {
      throw new Error(`Compressor '${explicit}' requested but its binary is not on PATH`)
    }
    return chosen
  }
  if (cachedAvailable === null) cachedAvailable = isAvailable('zstd') ? 'zstd' : 'gzip'
  return COMPRESSORS[cachedAvailable]
}

/** Resolve the compressor an existing archive was written with. Throws rather
 *  than guessing -- a wrong guess produces a corrupt-looking restore. */
export function compressorForArchive(archivePath: string): Compressor {
  for (const [ext, name] of Object.entries(EXT_TO_COMPRESSOR)) {
    if (archivePath.endsWith(ext)) return COMPRESSORS[name]
  }
  throw new Error(
    `Unrecognised archive extension: ${archivePath} (expected ${Object.keys(EXT_TO_COMPRESSOR).join(' or ')})`,
  )
}

/** POSIX single-quote escaping, so a path with a space or a quote in it cannot
 *  turn into extra shell words. */
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** Run a shell pipeline and fail loudly on ANY stage, not just the last.
 *
 *  The pipe is handed to `sh` on purpose. Chaining these processes in-process
 *  (`Bun.spawn(b, { stdin: a.stdout })`, draining `b.stdout` into a FileSink)
 *  LOOKS equivalent and passes at 200 MB, but silently truncates a 9.3 GB
 *  stream -- the archive lists fine with `tar -t` up to the cut and the database
 *  inside comes out `SQLITE_CORRUPT`. A truncated backup that reports success is
 *  the worst failure this module can have, so the pipe belongs to the kernel.
 *
 *  `pipefail` is what makes a mid-pipeline failure (tar dying while the
 *  compressor happily finishes on a short stream) a non-zero exit instead of a
 *  quietly short archive. */
async function shellPipeline(pipe: string, what: string): Promise<void> {
  const proc = Bun.spawn(['sh', '-c', `set -o pipefail; ${pipe}`], { stdout: 'ignore', stderr: 'pipe' })
  const exit = await proc.exited
  if (exit !== 0) {
    throw new Error(`${what} failed (exit ${exit}): ${await new Response(proc.stderr).text()}`)
  }
}

/** tar + compress `srcDir`'s contents into `archivePath`. */
export async function compressDir(srcDir: string, archivePath: string, compressor: Compressor): Promise<void> {
  const zip = compressor.compressArgv.map(shq).join(' ')
  await shellPipeline(`tar -cf - -C ${shq(srcDir)} . | ${zip} > ${shq(archivePath)}`, 'archive create')
}

/** Decompress + untar `archivePath` into `destDir`, dispatching on extension. */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const compressor = compressorForArchive(archivePath)
  const unzip = compressor.decompressArgv.map(shq).join(' ')
  await shellPipeline(`${unzip} ${shq(archivePath)} | tar -xf - -C ${shq(destDir)}`, 'archive extract')
}

/** Stream the archive through `tar -t` and return the member names.
 *
 *  Reads the ENTIRE compressed stream, so a truncated archive fails here rather
 *  than months later at restore time. This is the check that stands between a
 *  corrupt archive and a `.last-success.json` that would let the maintenance job
 *  delete rows against it. */
export async function listArchiveMembers(archivePath: string): Promise<string[]> {
  const compressor = compressorForArchive(archivePath)
  const unzip = compressor.decompressArgv.map(shq).join(' ')
  const proc = Bun.spawn(['sh', '-c', `set -o pipefail; ${unzip} ${shq(archivePath)} | tar -tf -`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const exit = await proc.exited
  if (exit !== 0) {
    throw new Error(`archive is unreadable or truncated (exit ${exit}): ${await new Response(proc.stderr).text()}`)
  }
  return out
    .split('\n')
    .map(l => l.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean)
}

/** Throw unless every expected member is present in a fully-readable archive. */
export async function assertArchiveComplete(archivePath: string, expected: string[]): Promise<void> {
  const members = new Set(await listArchiveMembers(archivePath))
  const missing = expected.filter(e => !members.has(e.replace(/\/$/, '')))
  if (missing.length > 0) {
    throw new Error(`archive is missing ${missing.length} expected member(s): ${missing.join(', ')}`)
  }
}
