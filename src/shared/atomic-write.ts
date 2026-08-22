/**
 * WRITE A FILE THE WAY A KILLED PROCESS CANNOT TEAR -- write a sibling, rename
 * over the target.
 *
 * `writeFileSync` opens the target with `O_TRUNC` and then writes: for anything
 * bigger than one `write(2)` the target is EMPTY, then a PREFIX, then finally
 * whole. A sentinel killed inside that window leaves a file that still exists,
 * still parses as SOMETHING, and no longer says what it said a moment ago. On a
 * `run.md` that read back as a healthy run at generation zero and dispatched a
 * planning generation over a live board (`epic-artifact-writes-not-atomic`).
 *
 * `renameSync` replaces a directory entry in one step, so every reader sees the
 * OLD file or the NEW one and never a prefix of either. The tmp sibling lives in
 * the target's own directory on purpose -- rename is only atomic WITHIN a
 * filesystem, and a `/tmp` staging file would silently degrade to a copy the
 * moment `.rclaude/` sat on a different mount.
 *
 * WHAT THIS DOES NOT BUY, so nobody reads more into it than is here: durability
 * against POWER LOSS. That needs `fsync` on the file and on its directory, and
 * costs a real disk round trip on every write. The failure this project actually
 * has is a killed or crashed process -- a restart, a deploy, an OOM -- and
 * rename covers that completely. Power loss can still lose the last write
 * ENTIRELY; what it can no longer do is leave half of one behind.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

/** The sibling. Deliberately not `.md`, so nothing that globs an artifact
 *  directory for markdown can ever pick a half-written staging file up. */
const TMP_SUFFIX = '.tmp'

/**
 * Write `content` to `file`, atomically with respect to a crash of this process.
 *
 * Throws whatever the underlying write or rename throws -- a caller that wants
 * a failure to be a value rather than an exception wraps it, exactly as
 * `writeProjectFile` already does.
 */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}${TMP_SUFFIX}`
  try {
    writeFileSync(tmp, content, 'utf8')
  } catch (err) {
    // THE STAGING FILE IS GARBAGE at this point -- a partial write or nothing at
    // all -- so it goes. A rename failure is the other case and deliberately
    // leaves the tmp standing: there the bytes are COMPLETE and are the only
    // copy of the new content there is, which is what a human debugging an
    // EXDEV or a read-only mount wants to find.
    try {
      unlinkSync(tmp)
    } catch {
      // Best effort. The original error is the one worth reporting.
    }
    throw err
  }
  renameSync(tmp, file)
}

/**
 * Is the last byte on disk a newline? A file that is absent or empty counts as
 * yes -- there is nothing for the next entry to collide with.
 *
 * One byte read, never the file: this is asked on every append, and the file it
 * guards for `epic-the-wall` reached 1.0 MB.
 */
function endsWithNewline(file: string): boolean {
  if (!existsSync(file)) return true
  const size = statSync(file).size
  if (size === 0) return true
  const fd = openSync(file, 'r')
  try {
    const byte = Buffer.alloc(1)
    readSync(fd, byte, 0, 1, size - 1)
    return byte[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

/**
 * Append `content` to `file`, first repairing a missing final newline.
 *
 * THE OTHER HALF OF THE DURABILITY STORY, and for an accumulating log it is the
 * better half. `writeFileAtomic` on a read-whole-rewrite-whole log rewrites every
 * byte of it per entry, and while a kill can no longer TEAR it, a rename still
 * makes the whole file the unit at risk. An `appendFileSync` of one entry is a
 * single write past the end: a killed process cannot damage it at all, and the
 * worst a power loss can do is leave a partial TAIL.
 *
 * The newline guard is what keeps that damage to one entry. Every reader in this
 * codebase splits sections on `/^### /m`, so a torn tail with no final newline
 * would put the next `### ` mid-line where the regex cannot see it -- and the
 * GOOD entry that followed the bad one would vanish along with it.
 *
 * Callers that need the file to exist with a header first write that header with
 * `writeFileAtomic`: creating a file is a whole-file write, not an extension.
 */
export function appendFileGuarded(file: string, content: string): void {
  const gap = endsWithNewline(file) ? '' : '\n'
  appendFileSync(file, `${gap}${content}`, 'utf8')
}
