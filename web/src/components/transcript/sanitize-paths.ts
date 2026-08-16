/**
 * Path shortening for displayed commands and file paths.
 *
 * Gated by Settings -> Display -> "sanitize paths" (`sanitizePaths`, default on)
 * via `useConversationPath()`, which returns undefined when the pref is off so
 * every caller falls back to the raw text.
 *
 * DISPLAY ONLY. The project root collapses to `.`, which is correct to run only
 * if you are cd'd into the project root -- `ShellCommand` carries a copy button
 * that yields the untouched command for exactly that reason.
 */

/** What an occurrence of the project root collapses to. */
const ROOT_TOKEN = '.'

// Strip common home/project prefixes to show a useful relative-ish path
export function shortPath(fullPath: string): string {
  if (!fullPath) return fullPath
  const stripped = fullPath.replace(/^\/(?:Users|home)\/[^/]+\/(?:projects\/[^/]+\/)?/, '')
  if (stripped === fullPath && fullPath.startsWith('/')) {
    const parts = fullPath.split('/')
    return parts.length > 3 ? parts.slice(-3).join('/') : fullPath
  }
  return stripped
}

// Compute relative path from `from` to `to` (pure string, no fs)
function relativePath(from: string, to: string): string {
  const fromParts = from.replace(/\/$/, '').split('/')
  const toParts = to.replace(/\/$/, '').split('/')
  let common = 0
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++
  const ups = fromParts.length - common
  const rest = toParts.slice(common)
  return [...Array(ups).fill('..'), ...rest].join('/')
}

// Strip or shorten a LEADING `cd <path> && ` from a shell command.
// - Exact CWD match: strip entirely (it's a no-op)
// - Child/parent of CWD: replace with relative path -- strictly better than the
//   blanket substitution below, which would only shorten the prefix
// - Unrelated: leave as-is
const CD_PREFIX_RE = /^cd\s+(?:(['"])(.+?)\1|(\S+))\s*(?:&&|;)\s*/
function stripCdPrefix(text: string, normRoot: string): string {
  const m = text.match(CD_PREFIX_RE)
  if (!m) return text
  const cdPath = (m[2] || m[3]).replace(/\/$/, '')
  const rest = text.slice(m[0].length)
  if (cdPath === normRoot) return rest
  const rel = relativePath(normRoot, cdPath)
  if (rel && !rel.startsWith('/') && rel.length < cdPath.length) {
    return `cd ${rel} && ${rest}`
  }
  return text
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Collapse EVERY remaining occurrence of the project root -- assignments,
// arguments, redirects, later lines. The lookahead is the boundary guard: the
// root must be followed by a separator, never by another path-name character,
// so a sibling directory whose name merely starts with the root (`prox019`
// alongside `prox01`) is left alone.
function collapseRoot(text: string, normRoot: string): string {
  if (!normRoot || normRoot === '/') return text
  return text.replace(new RegExp(`${escapeRe(normRoot)}(?=/|[^A-Za-z0-9._-]|$)`, 'g'), ROOT_TOKEN)
}

// A `cd .` left behind by the substitution is a no-op statement -- drop it, so
// `set -o pipefail; cd <root> && cmd` reads as `set -o pipefail; cmd`.
const NOOP_CD_RE = /(^|[\n;]\s*|&&\s*)cd\s+\.\s*(?:&&|;)\s*/g
function dropNoopCd(text: string): string {
  return text.replace(NOOP_CD_RE, '$1')
}

/**
 * Shorten the project root wherever it appears in a displayed shell command.
 * Name kept for its original job (the leading `cd`), which still gets the
 * relative rewrite before the blanket substitution runs.
 */
export function cleanCdPrefix(text: string, root: string): string {
  const normRoot = root.replace(/\/$/, '')
  return dropNoopCd(collapseRoot(stripCdPrefix(text, normRoot), normRoot))
}

// Clean `sh('cd <path> && ...')` inside REPL JavaScript code
const SH_CD_RE = /sh\((['"`])(cd\s+(?:['"]?.+?['"]?\s*(?:&&|;)\s*))/g
// Strip `chdir('<path>')` / `chdir("<path>")` / `chdir(`<path>`)` lines that are no-ops
const CHDIR_LINE_RE = /^[ \t]*chdir\(\s*(['"`])(.+?)\1\s*\)\s*;?[ \t]*(\r?\n|$)/gm
export function cleanReplShCalls(code: string, root: string): string {
  const normRoot = root.replace(/\/$/, '')
  const withoutChdir = code.replace(CHDIR_LINE_RE, (full, _q, path) => {
    return path.replace(/\/$/, '') === normRoot ? '' : full
  })
  return withoutChdir.replace(SH_CD_RE, (full, quote, cdPart) => {
    const cleaned = cleanCdPrefix(cdPart, root)
    if (cleaned !== cdPart) return `sh(${quote}${cleaned}`
    return full
  })
}
