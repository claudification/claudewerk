import { resolve } from 'node:path'
import { parseProjectUri } from '../shared/project-uri'

/**
 * Resolve a spawn/RPC target to an absolute filesystem path. The SENTINEL owns
 * URI<->path (CWD-IS-INFORMATIONAL): callers may hand us EITHER a raw path
 * (`/abs`, `~/x`, `rel`) OR a project URI (`claude://host/abs/path`). A URI is
 * resolved to its path segment FIRST, then the normal path rules apply. This is
 * the single seam where a `claude://` target becomes a real directory, so the
 * broker never has to extract `.path` from a URI itself.
 *
 * - `claude://host/abs/path` -> the URI's path segment, resolved absolute
 * - `~/x` / `~`              -> expanded against $HOME
 * - `rel`                    -> resolved against `spawnRoot`
 * - `/abs`                   -> resolved absolute
 */
export function expandPath(p: string, spawnRoot: string): string {
  if (p.includes('://')) {
    try {
      p = parseProjectUri(p).path
    } catch {
      // Not a parseable project URI -- fall through and treat verbatim.
    }
  }
  const home = process.env.HOME || '/root'
  if (p.startsWith('~/')) return resolve(home, p.slice(2))
  if (p === '~') return home
  if (!p.startsWith('/')) return resolve(spawnRoot, p)
  return resolve(p)
}
