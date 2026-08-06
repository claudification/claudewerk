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

/** Run `producer | consumer` and fail loudly if either end does.
 *
 *  Deliberately an explicit pipe rather than tar's `--use-compress-program`:
 *  that flag is GNU-only, and macOS ships bsdtar, so the convenient form works
 *  in the Debian container and blows up on a developer's laptop. Piping also
 *  keeps full control of the zstd flags (`-T0`, `--long=27`), which `--zstd`
 *  would not give us. */
async function pipeline(producer: string[], consumer: string[], what: string): Promise<void> {
  const src = Bun.spawn(producer, { stdout: 'pipe', stderr: 'pipe' })
  const dst = Bun.spawn(consumer, { stdin: src.stdout, stdout: 'pipe', stderr: 'pipe' })

  const [srcExit, dstExit] = await Promise.all([src.exited, dst.exited])
  if (srcExit !== 0) {
    throw new Error(`${what} failed: ${producer[0]} exit ${srcExit}: ${await new Response(src.stderr).text()}`)
  }
  if (dstExit !== 0) {
    throw new Error(`${what} failed: ${consumer[0]} exit ${dstExit}: ${await new Response(dst.stderr).text()}`)
  }
}

/** tar + compress `srcDir`'s contents into `archivePath`.
 *
 *  The output is drained through an explicit FileSink. `Bun.write(path, stream)`
 *  looks like it would do this but does NOT -- it stringifies the stream object
 *  and leaves a 23-byte ASCII file behind, which then fails to decompress. */
export async function compressDir(srcDir: string, archivePath: string, compressor: Compressor): Promise<void> {
  const src = Bun.spawn(['tar', '-cf', '-', '-C', srcDir, '.'], { stdout: 'pipe', stderr: 'pipe' })
  const zip = Bun.spawn([...compressor.compressArgv], { stdin: src.stdout, stdout: 'pipe', stderr: 'pipe' })

  const sink = Bun.file(archivePath).writer()
  try {
    for await (const chunk of zip.stdout as ReadableStream<Uint8Array>) sink.write(chunk)
  } finally {
    await sink.end()
  }

  const [tarExit, zipExit] = await Promise.all([src.exited, zip.exited])
  if (tarExit !== 0) throw new Error(`tar create failed (exit ${tarExit}): ${await new Response(src.stderr).text()}`)
  if (zipExit !== 0) {
    throw new Error(`${compressor.compressArgv[0]} failed (exit ${zipExit}): ${await new Response(zip.stderr).text()}`)
  }
}

/** Decompress + untar `archivePath` into `destDir`, dispatching on extension. */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const compressor = compressorForArchive(archivePath)
  await pipeline([...compressor.decompressArgv, archivePath], ['tar', '-xf', '-', '-C', destDir], 'extract')
}
