/**
 * Secure temp-file helpers.
 *
 * Secrets (OAuth tokens, MCP/broker secrets, system prompts) and user content
 * (prompts, transcripts, dialog logs) must never land on a world-readable
 * predictable path where another local user can read them. These helpers funnel
 * such files into an owner-only (0700) per-uid base dir and write them 0600.
 *
 * Precedent: the Claude Code daemon already isolates its sockets under a per-uid
 * `/tmp/cc-daemon-<uid>/` 0700 tree (see src/shared/cc-daemon/socket-path.ts).
 * We mirror that layout for rclaude's own temp files.
 */
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER_ONLY_DIR = 0o700
const OWNER_ONLY_FILE = 0o600

/** Current uid, or null off Unix (Windows has no getuid). */
function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/** `true` if the path exists (symlink-aware), `false` otherwise. */
function lstatSafe(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Owner-only per-uid base temp dir: `<tmpdir>/rclaude-<uid>`. Namespacing by
 * uid keeps the path stable across same-user processes (sentinel writes, agent
 * host reads) while denying other users a foothold -- the dir itself is 0700,
 * so files inside are unreachable to others regardless of their own mode.
 */
export function secureTmpBase(): string {
  const uid = currentUid()
  return join(tmpdir(), uid == null ? 'rclaude' : `rclaude-${uid}`)
}

/**
 * Ensure `dir` exists as an owner-only directory we actually own, then return
 * it. Defends against the classic /tmp pre-create / symlink attack: if the path
 * already exists it must be a real directory (not a symlink) owned by the
 * current uid; loose modes are tightened back to 0700. Throws if the existing
 * entry is unsafe (symlink, foreign owner, non-dir) so a secret is never written
 * through an attacker-controlled handle.
 */
export function ensureSecureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR })
  } catch (err) {
    // recursive mkdir still throws EEXIST when the path is a non-directory
    // (file/symlink). Let the lstat validation below produce the clear error;
    // only rethrow if the path genuinely isn't there.
    if (!lstatSafe(dir)) throw err
  }
  // mkdirSync's `mode` is masked by umask and is a no-op when the dir already
  // exists, so always re-stat and re-assert.
  const st = lstatSync(dir)
  if (st.isSymbolicLink()) throw new Error(`secure dir is a symlink: ${dir}`)
  if (!st.isDirectory()) throw new Error(`secure dir is not a directory: ${dir}`)
  const uid = currentUid()
  if (uid != null && st.uid !== uid) {
    throw new Error(`secure dir not owned by uid ${uid}: ${dir} (owner ${st.uid})`)
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, OWNER_ONLY_DIR)
  return dir
}

/** Ensure the per-uid base dir exists (0700) and return a path inside it. */
export function secureTmpPath(name: string): string {
  return join(ensureSecureDir(secureTmpBase()), name)
}

/**
 * Ensure a (possibly nested) 0700 subdir of the per-uid base exists; return its
 * path. Intermediate segments are created 0700 by the recursive mkdir, and the
 * leaf is owner-verified.
 */
export function secureTmpSubdir(sub: string): string {
  ensureSecureDir(secureTmpBase())
  return ensureSecureDir(join(secureTmpBase(), sub))
}

/**
 * `writeFileSync` that always lands 0600. The `mode` option only applies when
 * CREATING the file, so an attacker-pre-created file would keep its old mode --
 * we chmod afterwards too. (Inside a 0700 dir this is belt-and-suspenders, but
 * the helper is also used for in-place config files whose dir stays traversable.)
 */
export function writeSecureFileSync(path: string, data: string | NodeJS.ArrayBufferView): void {
  writeFileSync(path, data, { mode: OWNER_ONLY_FILE })
  try {
    chmodSync(path, OWNER_ONLY_FILE)
  } catch {
    /* file may have been removed underneath us; the write itself is what matters */
  }
}

/**
 * Async write that lands 0600. The drop-in replacement for `Bun.write` at our
 * secret/user-content call sites (Bun.write defaults to 0644 and has no mode
 * option). Uses node fs so the helper stays runtime-agnostic.
 */
export async function writeSecureFile(path: string, data: string | NodeJS.ArrayBufferView): Promise<void> {
  await writeFile(path, data, { mode: OWNER_ONLY_FILE })
  try {
    chmodSync(path, OWNER_ONLY_FILE)
  } catch {
    /* ignore */
  }
}

/** chmod an existing file to 0600, best-effort (file may be gone). */
export function tightenFile(path: string): void {
  try {
    chmodSync(path, OWNER_ONLY_FILE)
  } catch {
    /* ignore */
  }
}
