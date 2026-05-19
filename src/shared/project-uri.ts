/**
 * Name of the implicit local sentinel -- used as the URI authority when no
 * explicit sentinel host is specified.
 *
 * Every Claude project URI has the shape `claude://{sentinel}/{absolute_path}`.
 * The authority slot IS the sentinel name: today there's one sentinel (the
 * local install, named `default`); when multi-sentinel lands, other hosts use
 * their own names (e.g. `claude://laptop/...`, `claude://workstation/...`).
 *
 * Legacy forms still accepted on input:
 *   - `claude:///path`       (sentinel-less -- upgraded to `default` on normalize)
 *   - `claude:////path`      (quad-slash concat scar -- collapsed on normalize)
 *
 * Both forms round-trip through `normalizeProjectUri()` to the canonical
 * `claude://default/{path}` form, and `matchProjectUri()` treats
 * empty authority as equivalent to `default` so pre-migration grants keep
 * matching post-migration session scopes.
 *
 * Profile slot (sentinel-profiles plan): the URI userinfo (`work@beast`) names
 * the sentinel PROFILE that hosts the conversation. Profile is preserved by
 * parse/build/normalize (it pins which CLAUDE_CONFIG_DIR a revive lands in),
 * but PROFILE IS NOT IDENTITY -- compareProjectUri / matchProjectUri /
 * isSameProject all strip profile before comparing. See `stripProfile()`.
 */
export const DEFAULT_SENTINEL_NAME = 'default'

/** Valid profile-name shape -- enforced at validate time and at parse time
 *  (out-of-shape userinfo is dropped on the manual-fallback path). */
const PROFILE_NAME_RE = /^[a-z0-9-]{1,63}$/

export interface ProjectUri {
  scheme: string
  authority?: string
  /** Sentinel profile name from the URI userinfo (`profile@sentinel`). NOT
   *  identity -- comparison helpers strip this. See `stripProfile()`. */
  profile?: string
  path: string
  fragment?: string
  raw: string
}

export interface ProjectUriParts {
  scheme: string
  authority?: string
  /** Sentinel profile name. Emitted as `${profile}@` before the authority by
   *  `buildProjectUri` when set. */
  profile?: string
  path: string
  fragment?: string
}

const WILDCARD_URI: ProjectUri = Object.freeze({
  scheme: '*',
  path: '*',
  raw: '*',
})

function parseSchemeWildcard(uri: string): ProjectUri {
  const scheme = uri.slice(0, uri.indexOf(':'))
  return { scheme: scheme.toLowerCase(), path: '*', raw: uri }
}

/** Split a raw authority on a leading `profile@` userinfo, falling back to
 *  the whole thing as the host when the userinfo doesn't match the profile
 *  shape. Used on the manual-fallback parse path (malformed authorities that
 *  WHATWG rejected -- e.g. `work@Mistral Dophin`). */
function splitProfileFromAuthority(rawAuthority: string): { profile?: string; host: string } {
  const atIdx = rawAuthority.indexOf('@')
  if (atIdx < 0) return { host: rawAuthority }
  const candidate = rawAuthority.slice(0, atIdx)
  // An out-of-shape userinfo is left attached to the authority rather than
  // smuggled into `profile` -- the fallback path runs on malformed input and
  // the profile slot is reserved for the canonical shape.
  if (!PROFILE_NAME_RE.test(candidate)) return { host: rawAuthority }
  return { profile: candidate, host: rawAuthority.slice(atIdx + 1) }
}

export function parseProjectUri(uri: string): ProjectUri {
  if (uri === '*') return { ...WILDCARD_URI }

  if (/^[a-z][a-z0-9+.-]*:\*$/i.test(uri)) {
    return parseSchemeWildcard(uri)
  }

  let url: URL | null = null
  try {
    url = new URL(uri)
  } catch {
    // WHATWG URL rejects authority components with spaces/illegal chars
    // (e.g. backends that allocate URIs from human-readable model labels like
    // `chat://Mistral Dophin`). A single such row in the conversation store
    // used to throw from anywhere that iterated all conversations -- most
    // visibly `channel_list_conversations`, where the handler-wide throw was
    // caught by the router as `channel_list_conversations_result` (a type the
    // agent host doesn't listen for), and every caller's promise timed out
    // after 5s with an empty `[]`. Fall back to a tolerant manual split for
    // any `scheme://...` shape so the bad URI degrades gracefully instead.
    const schemeMatch = uri.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i)
    if (!schemeMatch) throw new Error(`Invalid project URI: ${uri}`)
    const scheme = schemeMatch[1].toLowerCase()
    const rest = schemeMatch[2]
    const fragmentIdx = rest.indexOf('#')
    const before = fragmentIdx >= 0 ? rest.slice(0, fragmentIdx) : rest
    const fragment = fragmentIdx >= 0 ? rest.slice(fragmentIdx + 1) : undefined
    const slashIdx = before.indexOf('/')
    const rawAuthority = (slashIdx >= 0 ? before.slice(0, slashIdx) : before) || undefined
    const path = slashIdx >= 0 ? before.slice(slashIdx) || '/' : '/'
    const split: { profile?: string; host: string | undefined } = rawAuthority
      ? splitProfileFromAuthority(rawAuthority)
      : { host: undefined }
    return {
      scheme,
      authority: split.host || undefined,
      profile: split.profile,
      path,
      fragment,
      raw: uri,
    }
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase()
  if (!scheme) throw new Error(`Invalid project URI: missing scheme in ${uri}`)

  const authority = url.hostname || undefined
  const path = decodeURIComponent(url.pathname) || '/'
  const fragment = url.hash ? url.hash.slice(1) : undefined
  const profile = url.username ? decodeURIComponent(url.username) : undefined

  return { scheme, authority, profile: profile || undefined, path, fragment, raw: uri }
}

/**
 * Tolerant variant of `parseProjectUri` that returns `null` instead of
 * throwing on truly garbage input (no `scheme://` prefix). Use this in code
 * that iterates over arbitrary conversation rows from the store and only
 * cares about results it can use -- never let a single bad row poison the
 * whole iteration. For strict write-time validation, use `validateProjectUri`.
 */
export function tryParseProjectUri(uri: string): ProjectUri | null {
  try {
    return parseProjectUri(uri)
  } catch {
    return null
  }
}

/**
 * Strict write-time validation. Rejects URIs that WHATWG URL would reject
 * (authorities with spaces, illegal chars, missing scheme, etc.), so we
 * never persist a row that later poisons read-side iteration. Wildcards
 * (`*`, `scheme:*`) are also rejected -- they're permission patterns,
 * not real project addresses.
 *
 * Profile (URI userinfo `profile@sentinel`) is accepted when it matches
 * `[a-z0-9-]{1,63}`. Password / port / query are still rejected -- the
 * userinfo slot is reserved for the sentinel-profile name only.
 *
 * Returns `{ valid: true }` on accept, or `{ valid: false, error }` with a
 * human-readable explanation that callers can surface verbatim to the user.
 */
export function validateProjectUri(uri: string): { valid: true } | { valid: false; error: string } {
  if (typeof uri !== 'string' || uri.length === 0) {
    return { valid: false, error: 'Project URI is required (got empty string)' }
  }
  if (uri === '*' || /^[a-z][a-z0-9+.-]*:\*$/i.test(uri)) {
    return { valid: false, error: `Wildcard URI "${uri}" is a permission pattern, not a valid project address` }
  }
  // Must be a `scheme://` shape. Bare paths or random strings are not valid
  // project URIs at write time -- if a caller wants to spawn at /abs/path it
  // should pass the path directly (the broker wraps it via cwdToProjectUri),
  // not a hand-rolled URI fragment.
  const schemeMatch = uri.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i)
  if (!schemeMatch) {
    return { valid: false, error: `Project URI "${uri}" is missing a scheme:// prefix` }
  }
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return { valid: false, error: diagnoseUrlRejection(uri, schemeMatch[2]) }
  }
  const userinfoError = validateUserinfo(url, uri)
  if (userinfoError) return { valid: false, error: userinfoError }
  if (url.port) return { valid: false, error: `Project URI "${uri}" must not include a port` }
  if (url.search) return { valid: false, error: `Project URI "${uri}" must not include a query string` }
  return { valid: true }
}

/** Best-effort explanation when WHATWG rejected the URI -- most commonly a
 *  space or unencoded special char in the authority slot. */
function diagnoseUrlRejection(uri: string, rest: string): string {
  const slashIdx = rest.indexOf('/')
  const authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest
  if (authority && /[\s<>"`{}|\\^[\]]/.test(authority)) {
    return `Project URI "${uri}" has an invalid authority "${authority}" (contains whitespace or illegal URL characters)`
  }
  return `Project URI "${uri}" is not a valid URL (rejected by WHATWG URL parser)`
}

/** Userinfo policy: no password, username must be a profile-shaped name. */
function validateUserinfo(url: URL, uri: string): string | null {
  if (url.password) return `Project URI "${uri}" must not include a password in userinfo`
  if (!url.username) return null
  const decoded = decodeURIComponent(url.username)
  if (!PROFILE_NAME_RE.test(decoded)) {
    return `Project URI "${uri}" has an invalid profile "${decoded}" (must match [a-z0-9-]{1,63})`
  }
  return null
}

export function buildProjectUri(parts: ProjectUriParts): string {
  const scheme = parts.scheme.toLowerCase()
  // Every URI carries a sentinel name in the authority slot, regardless of
  // scheme. claude://, opencode://, hermes://, chat-api://, codex:// all
  // share the shape `<scheme>://<sentinel>/<path>`. When authority is
  // omitted we fill in DEFAULT_SENTINEL_NAME ('default'). Empty-authority
  // forms ('claude:///path', 'opencode:///path') still parse fine -- they
  // get upgraded to the canonical form on normalize / match.
  const authority = parts.authority ?? DEFAULT_SENTINEL_NAME
  // Profile (sentinel-profile name) lives in the URI userinfo slot:
  // `claude://work@default/path`. Emitted only when explicitly set; an
  // implicit default-profile URI never carries `default@`.
  const profilePart = parts.profile ? `${parts.profile}@` : ''
  const fragment = parts.fragment ? `#${parts.fragment}` : ''
  return `${scheme}://${profilePart}${authority}${parts.path}${fragment}`
}

export function cwdToProjectUri(cwd: string, scheme = 'claude', authority?: string, profile?: string): string {
  return buildProjectUri({ scheme, authority, profile, path: cwd })
}

/** Authority for matching purposes: empty/undefined authority on any scheme
 *  is treated as DEFAULT_SENTINEL_NAME so pre-canonicalization URIs still
 *  match current ones. */
function authorityForMatch(parsed: ProjectUri): string {
  if (parsed.authority) return parsed.authority
  return DEFAULT_SENTINEL_NAME
}

export function matchProjectUri(pattern: string, uri: string): boolean {
  if (pattern === '*') return true

  if (/^[a-z][a-z0-9+.-]*:\*$/i.test(pattern)) {
    const patternScheme = pattern.slice(0, pattern.indexOf(':')).toLowerCase()
    const parsed = parseProjectUri(uri)
    return parsed.scheme === patternScheme
  }

  if (pattern.endsWith('/*')) {
    const patternBase = pattern.slice(0, -2)
    const parsedPattern = parseProjectUri(patternBase)
    const parsedUri = parseProjectUri(uri)

    if (parsedPattern.scheme !== parsedUri.scheme) return false
    // Profile is NOT identity -- two conversations in the same dir under
    // different profiles are the same project, so the pattern's profile (if
    // any) is ignored, as is the URI's profile.
    if (authorityForMatch(parsedPattern) !== authorityForMatch(parsedUri)) return false

    return parsedUri.path.startsWith(`${parsedPattern.path}/`) || parsedUri.path === parsedPattern.path
  }

  // Strip profile from both sides so a profile-bearing URI matches a
  // profile-less permission grant (and vice versa).
  return normalizeProjectUri(stripProfile(pattern)) === normalizeProjectUri(stripProfile(uri))
}

export function normalizeProjectUri(uri: string): string {
  if (uri === '*') return '*'
  if (/^[a-z][a-z0-9+.-]*:\*$/i.test(uri)) {
    return `${uri.slice(0, uri.indexOf(':')).toLowerCase()}:*`
  }

  let parsed: ProjectUri
  try {
    parsed = parseProjectUri(uri)
  } catch {
    return uri
  }
  const path = canonicalPath(parsed.path)
  const fragment = parsed.fragment ? `#${parsed.fragment}` : ''
  // Upgrade empty authority to DEFAULT_SENTINEL_NAME on every scheme so
  // legacy ('claude:///path', 'opencode:///path') and current
  // ('claude://default/path', 'opencode://default/path') forms canonicalize
  // identically. The authority slot IS the sentinel name regardless of scheme.
  const authority = parsed.authority || DEFAULT_SENTINEL_NAME
  // Profile is preserved through canonical form when set -- the conversation
  // is permanently bound to its picked profile. Identity comparison strips it
  // (via stripProfile), but the stored form keeps it so revive can pin the
  // right CLAUDE_CONFIG_DIR.
  const profilePart = parsed.profile ? `${parsed.profile}@` : ''
  return `${parsed.scheme}://${profilePart}${authority}${path}${fragment}`
}

/** Collapse multi-slash leading scars and drop a trailing slash. Pre-2026-04-25
 *  data produced by `'claude:///' || cwd` concatenation (where cwd was already
 *  absolute) yielded URIs like 'claude:////Users/...' which WHATWG parses as
 *  authority='' + path='//Users/...' -- canonical form is a single slash. */
function canonicalPath(rawPath: string): string {
  let path = rawPath
  if (path.startsWith('//')) path = path.replace(/^\/+/, '/')
  if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

function projectWithoutConversation(uri: string): string {
  const hashIdx = uri.indexOf('#')
  return hashIdx >= 0 ? uri.slice(0, hashIdx) : uri
}

/**
 * Strip the sentinel-profile userinfo (`work@`) from a URI string, leaving
 * the rest untouched. Mirrors `projectWithoutConversation()` for the
 * `#fragment`.
 *
 * Used by identity-comparison helpers (compareProjectUri, matchProjectUri,
 * isSameProject) because profile is NOT identity: two conversations in the
 * same dir under different profiles are still the same project.
 *
 * Safe on wildcards, scheme-wildcards, and malformed input -- returns the
 * string unchanged when there is no userinfo to strip.
 */
/**
 * Set or replace the sentinel-profile userinfo (`work@`) on a project URI.
 * `profile === undefined` strips the userinfo (i.e. promotes back to the
 * implicit `default` profile).
 *
 * Used by the broker when a sentinel echoes back its resolved profile NAME
 * (`spawn_result.resolvedProfile`) and the conversation's stored projectUri
 * must be rewritten to pin the profile for future revives. Safe on wildcards
 * / malformed URIs -- returns unchanged when the prefix doesn't parse.
 *
 * PROFILE-ENV BOUNDARY: the broker manipulates the NAME slot only; configDir
 * / env never appear in a URI.
 */
/**
 * Read the sentinel-profile userinfo (`work@`) from a project URI, returning
 * undefined when absent. Tolerant of malformed input. Use this when the
 * broker needs the NAME to forward to a sentinel (e.g. revive pin).
 */
export function getProfileFromUri(uri: string): string | undefined {
  try {
    return parseProjectUri(uri).profile
  } catch {
    return undefined
  }
}

export function withProfile(uri: string, profile: string | undefined): string {
  const stripped = stripProfile(uri)
  if (!profile) return stripped
  const schemeMatch = stripped.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i)
  if (!schemeMatch) return stripped
  return `${schemeMatch[1]}${profile}@${schemeMatch[2]}`
}

export function stripProfile(uri: string): string {
  const schemeMatch = uri.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i)
  if (!schemeMatch) return uri
  const prefix = schemeMatch[1]
  const rest = schemeMatch[2]
  // Authority ends at the first '/' or '#'. The '@' we care about lives
  // inside the authority slot; if it sits past the first '/', it's part of
  // the path (e.g. `/Users/foo@example`) and must be left alone.
  const authorityEndIdx = rest.search(/[/#]/)
  const authority = authorityEndIdx >= 0 ? rest.slice(0, authorityEndIdx) : rest
  const tail = authorityEndIdx >= 0 ? rest.slice(authorityEndIdx) : ''
  const atIdx = authority.indexOf('@')
  if (atIdx < 0) return uri
  return `${prefix}${authority.slice(atIdx + 1)}${tail}`
}

export function extractProjectLabel(uri: string): string {
  if (uri === '*' || /^[a-z][a-z0-9+.-]*:\*$/i.test(uri)) return uri

  try {
    const parsed = parseProjectUri(uri)
    const segments = parsed.path.split('/').filter(Boolean)
    return segments.length > 0 ? segments[segments.length - 1] : parsed.path
  } catch {
    const colon = uri.indexOf('://')
    return colon >= 0 ? uri.slice(colon + 3) : uri
  }
}

function cmp(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Compare two project URIs for equality / sorting at the PROJECT level.
 *
 * The conversation fragment (`#conv-xyz`) and the sentinel-profile userinfo
 * (`work@`) are both irrelevant at the project level and are stripped before
 * comparison. Authority forms are equivalent (`claude:///x` ==
 * `claude://default/x`). Scheme case, trailing slashes, and multi-slash scars
 * are all normalized.
 *
 * Returns -1 / 0 / 1 suitable for Array.sort(). Safe on both server and web.
 *
 * Use this when grouping / matching by project identity -- e.g. listing
 * conversations for a project, permission scope matching, sidebar grouping.
 */
export function compareProjectUri(a: string, b: string): number {
  return cmp(
    normalizeProjectUri(stripProfile(projectWithoutConversation(a))),
    normalizeProjectUri(stripProfile(projectWithoutConversation(b))),
  )
}

/**
 * Compare two project URIs at the SESSION level, including the conversation
 * fragment. `claude://default/foo#conv-1` and `claude://default/foo#conv-2`
 * are distinct; `claude://default/foo` (no fragment) differs from either.
 *
 * Profile is still stripped (it's not identity); only the `#fragment` is
 * preserved relative to compareProjectUri.
 *
 * Use this when matching a specific session (e.g. reconnect routing, live
 * session identity) where the conversation within a project matters.
 */
export function compareProjectConversationUri(a: string, b: string): number {
  return cmp(normalizeProjectUri(stripProfile(a)), normalizeProjectUri(stripProfile(b)))
}

export function isSameProject(a: string, b: string): boolean {
  return compareProjectUri(a, b) === 0
}

export function isSameProjectConversation(a: string, b: string): boolean {
  return compareProjectConversationUri(a, b) === 0
}
