import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openSpawnDialog } from '@/components/spawn-dialog-trigger'
import { type SentinelStatusInfo, useConversationsStore } from '@/hooks/use-conversations'

/** Default sentinel name (mirrors src/shared/project-uri.ts DEFAULT_SENTINEL_NAME).
 *  Used as the implicit authority when no `@sentinel` token is given. */
const DEFAULT_SENTINEL = 'default'

export interface SentinelSuggestion {
  alias: string
  connected: boolean
  isDefault: boolean
}

export interface ProfileSuggestion {
  /** Profile name (e.g. "work"). Selected with Enter / Tab. */
  name: string
  /** Optional display label (free-form, set by the sentinel). */
  label?: string
  /** Optional color tint (hex, set by the sentinel). */
  color?: string
  /** Pool the profile belongs to (`null` -- excluded from every pool). */
  pool?: string | null
  /** Whether the sentinel believes credentials are present for this profile. */
  authed?: boolean
}

export interface PoolSuggestion {
  /** Pool name (e.g. "work"). Selected with Enter / Tab. */
  name: string
  /** How many profiles in this pool. Displayed for context. */
  profileCount: number
  /** Whether this is the sentinel's `defaultPool` (used when `#pool` omitted). */
  isDefault: boolean
}

export interface SpawnModeState {
  spawnPath: string
  spawnParentDir: string
  spawnSentinel: string
  /** Resolved profile name (or selection-mode token), parsed from the
   *  `@sentinel:profile` shorthand. Empty when no profile token is present. */
  spawnProfile: string
  /** Pool name parsed from `@sentinel#pool` shorthand. Empty when no
   *  pool token is present. Mutually exclusive with `spawnProfile`. */
  spawnPool: string
  filteredSpawnDirs: string[]
  filteredSentinels: SentinelSuggestion[]
  /** Profile-name suggestions surfaced after the user types `@sentinel:`.
   *  Sourced from the sentinel's reported profiles. */
  filteredProfiles: ProfileSuggestion[]
  /** Pool-name suggestions surfaced after the user types `@sentinel#`.
   *  Sourced from the sentinel's reported pools (including its defaultPool). */
  filteredPools: PoolSuggestion[]
  isSentinelEntry: boolean
  /** True when the user has typed `@sentinel:` (and no space yet) -- the
   *  hook shows profile autocomplete instead of the dir listing. */
  isProfileEntry: boolean
  /** True when the user has typed `@sentinel#` (and no space yet) -- the
   *  hook shows pool autocomplete. Mutually exclusive with isProfileEntry. */
  isPoolEntry: boolean
  spawnLoading: boolean
  spawnError: string | null
  spawning: boolean
  canCreateDir: boolean
  handleSpawn: (path: string, mkdir?: boolean) => void
  handleDirSelect: (dir: string) => void
  handleSentinelSelect: (alias: string) => void
  handleProfileSelect: (name: string) => void
  handlePoolSelect: (name: string) => void
}

interface UseSpawnModeArgs {
  filter: string
  isSpawnMode: boolean
  sentinelConnected: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  setFilter: (value: string) => void
  setActiveIndex: (value: number) => void
  onClose: () => void
}

/**
 * Spawn-mode (`s:` prefix) derivations. Parses the optional `@sentinel`
 * authority + path, debounces directory listings via the broker's `/api/dirs`
 * endpoint, and exposes the Tab/Enter completion targets. While the user is
 * still typing the `@sentinel` token (no space yet), the hook skips the dir
 * fetch and exposes a sentinel suggestion list with the default sentinel
 * first. `handleSpawn` defers to the spawn dialog -- this hook does not
 * actually launch conversations.
 */
export function useSpawnMode({
  filter,
  isSpawnMode,
  sentinelConnected,
  inputRef,
  setFilter,
  setActiveIndex,
  onClose,
}: UseSpawnModeArgs): SpawnModeState {
  const spawnRawInput = isSpawnMode ? filter.slice(2).trim() : ''
  const [spawnDirs, setSpawnDirs] = useState<string[]>([])
  const [spawnLoading, setSpawnLoading] = useState(false)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const spawning = false // spawn now handled by SpawnDialog
  const spawnFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sentinels = useConversationsStore(s => s.sentinels)

  const spawnParsed = useMemo(() => parseSpawnInput(spawnRawInput), [spawnRawInput])
  const spawnPath = spawnParsed.path
  // Always resolve to a concrete sentinel name. No `@` token => 'default'.
  const spawnSentinel = spawnParsed.sentinel || DEFAULT_SENTINEL
  const spawnProfile = spawnParsed.profile || ''
  const spawnPool = spawnParsed.pool || ''
  // Sentinel-entry mode: input has a leading `@` token but no space yet, so
  // the user is still typing the sentinel alias / colon-profile / hash-pool
  // suffix. Profile-entry mode -> `@alias:` -> profile completion. Pool-entry
  // mode -> `@alias#` -> pool completion. The two are mutually exclusive;
  // whichever delimiter appears first wins.
  const sentinelOrPoolOrProfileToken =
    isSpawnMode && spawnRawInput.startsWith('@') && !spawnRawInput.includes(' ') ? spawnRawInput.slice(1) : ''
  const colonIdx = sentinelOrPoolOrProfileToken.indexOf(':')
  const hashIdx = sentinelOrPoolOrProfileToken.indexOf('#')
  const firstDelim = pickFirstDelim(colonIdx, hashIdx)
  const isSentinelEntry = sentinelOrPoolOrProfileToken.length > 0 && firstDelim.kind === 'none'
  const isProfileEntry = sentinelOrPoolOrProfileToken.length > 0 && firstDelim.kind === 'colon'
  const isPoolEntry = sentinelOrPoolOrProfileToken.length > 0 && firstDelim.kind === 'hash'
  const sentinelTypedPrefix = isSentinelEntry ? sentinelOrPoolOrProfileToken.toLowerCase() : ''
  const profileTypedPrefix = isProfileEntry ? sentinelOrPoolOrProfileToken.slice(firstDelim.idx + 1).toLowerCase() : ''
  const profileEntrySentinelAlias = isProfileEntry
    ? sentinelOrPoolOrProfileToken.slice(0, firstDelim.idx).toLowerCase()
    : ''
  const poolTypedPrefix = isPoolEntry ? sentinelOrPoolOrProfileToken.slice(firstDelim.idx + 1).toLowerCase() : ''
  const poolEntrySentinelAlias = isPoolEntry ? sentinelOrPoolOrProfileToken.slice(0, firstDelim.idx).toLowerCase() : ''

  const spawnParentDir = spawnPath.includes('/') ? spawnPath.slice(0, spawnPath.lastIndexOf('/') + 1) : '/'
  const spawnPartial = spawnPath.includes('/')
    ? spawnPath.slice(spawnPath.lastIndexOf('/') + 1).toLowerCase()
    : spawnPath.toLowerCase()

  // Reset dirs/error synchronously when leaving dir-fetch mode (entering sentinel/profile/pool entry or leaving spawn mode).
  const shouldFetchDirs = isSpawnMode && !isSentinelEntry && !isProfileEntry && !isPoolEntry
  const [prevShouldFetchDirs, setPrevShouldFetchDirs] = useState(shouldFetchDirs)
  if (shouldFetchDirs !== prevShouldFetchDirs) {
    setPrevShouldFetchDirs(shouldFetchDirs)
    if (!shouldFetchDirs) {
      setSpawnDirs([])
      setSpawnError(null)
    }
  }

  const fetchDirs = useCallback(
    (dirPath: string, sentinel?: string) => {
      if (!sentinelConnected) return
      setSpawnLoading(true)
      setSpawnError(null)
      const params = new URLSearchParams({ path: dirPath })
      if (sentinel) params.set('sentinel', sentinel)
      fetch(`/api/dirs?${params}`)
        .then(r => r.json())
        .then(data => {
          setSpawnDirs(data.dirs || [])
          setSpawnError(data.error || null)
          setSpawnLoading(false)
        })
        .catch(err => {
          setSpawnError(err.message)
          setSpawnLoading(false)
        })
    },
    [sentinelConnected],
  )

  useEffect(() => {
    if (!shouldFetchDirs) return
    if (spawnFetchTimer.current) clearTimeout(spawnFetchTimer.current)
    spawnFetchTimer.current = setTimeout(() => fetchDirs(spawnParentDir, spawnSentinel), 200)
    return () => {
      if (spawnFetchTimer.current) clearTimeout(spawnFetchTimer.current)
    }
  }, [shouldFetchDirs, spawnParentDir, spawnSentinel, fetchDirs])

  const filteredSpawnDirs = spawnPartial ? spawnDirs.filter(d => d.toLowerCase().startsWith(spawnPartial)) : spawnDirs
  const canCreateDir =
    isSpawnMode &&
    !isSentinelEntry &&
    !isProfileEntry &&
    !isPoolEntry &&
    spawnPartial.length > 0 &&
    filteredSpawnDirs.length === 0 &&
    !spawnLoading

  const filteredSentinels = useMemo<SentinelSuggestion[]>(() => {
    if (!isSentinelEntry) return []
    return buildSentinelSuggestions(sentinels, sentinelTypedPrefix)
  }, [isSentinelEntry, sentinels, sentinelTypedPrefix])

  const filteredProfiles = useMemo<ProfileSuggestion[]>(() => {
    if (!isProfileEntry) return []
    return buildProfileSuggestions(sentinels, profileEntrySentinelAlias, profileTypedPrefix)
  }, [isProfileEntry, sentinels, profileEntrySentinelAlias, profileTypedPrefix])

  const filteredPools = useMemo<PoolSuggestion[]>(() => {
    if (!isPoolEntry) return []
    return buildPoolSuggestions(sentinels, poolEntrySentinelAlias, poolTypedPrefix)
  }, [isPoolEntry, sentinels, poolEntrySentinelAlias, poolTypedPrefix])

  function handleSpawn(path: string, mkdir = false) {
    if (spawning || !path) return
    onClose()
    openSpawnDialog({
      path,
      mkdir,
      sentinel: spawnSentinel,
      profile: spawnProfile || undefined,
      pool: spawnPool || undefined,
    })
  }

  function handleDirSelect(dir: string) {
    const prefix = sentinelPrefixFor(spawnRawInput)
    setFilter(`S:${prefix}${spawnParentDir}${dir}/`)
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  function handleSentinelSelect(alias: string) {
    setFilter(`S:@${alias} `)
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  function handleProfileSelect(name: string) {
    const sentinelPart = profileEntrySentinelAlias || spawnSentinel
    setFilter(`S:@${sentinelPart}:${name} `)
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  function handlePoolSelect(name: string) {
    const sentinelPart = poolEntrySentinelAlias || spawnSentinel
    setFilter(`S:@${sentinelPart}#${name} `)
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  return {
    spawnPath,
    spawnParentDir,
    spawnSentinel,
    spawnProfile,
    spawnPool,
    filteredSpawnDirs,
    filteredSentinels,
    filteredProfiles,
    filteredPools,
    isSentinelEntry,
    isProfileEntry,
    isPoolEntry,
    spawnLoading,
    spawnError,
    spawning,
    canCreateDir,
    handleSpawn,
    handleDirSelect,
    handleSentinelSelect,
    handleProfileSelect,
    handlePoolSelect,
  }
}

/** Pick the first delimiter encountered (`:` for fixed profile, `#` for pool).
 *  The earlier index wins; equal-zero ties don't happen (one is -1). */
function pickFirstDelim(colonIdx: number, hashIdx: number): { kind: 'none' | 'colon' | 'hash'; idx: number } {
  if (colonIdx === -1 && hashIdx === -1) return { kind: 'none', idx: -1 }
  if (colonIdx === -1) return { kind: 'hash', idx: hashIdx }
  if (hashIdx === -1) return { kind: 'colon', idx: colonIdx }
  return colonIdx < hashIdx ? { kind: 'colon', idx: colonIdx } : { kind: 'hash', idx: hashIdx }
}

interface SpawnInput {
  sentinel?: string
  /** Optional sentinel-profile name parsed from `@sentinel:profile` (Fixed
   *  mode). Mutually exclusive with `pool`. */
  profile?: string
  /** Optional pool name parsed from `@sentinel#pool` (Balanced/Random
   *  filtered by pool). Mutually exclusive with `profile`. */
  pool?: string
  path: string
}

// fallow-ignore-next-line complexity
export function parseSpawnInput(input: string): SpawnInput {
  if (input.startsWith('claude://')) {
    try {
      const url = new URL(input)
      const profile = url.username ? decodeURIComponent(url.username) : undefined
      return { sentinel: url.hostname || undefined, profile: profile || undefined, path: url.pathname }
    } catch {
      return { path: input }
    }
  }
  if (input.startsWith('@')) {
    // Only the LEADING @token is treated as a sentinel; subsequent `@`
    // characters are part of the path. Naturally enforces a single sentinel
    // per spawn line.
    const spaceIdx = input.indexOf(' ')
    const head = spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)
    const path = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1)
    // First delimiter wins: `:` -> Fixed profile, `#` -> pool. Mutually
    // exclusive within a single spawn line. Anything after the second
    // delimiter is treated as part of the profile/pool name (so the user
    // can't accidentally chain both).
    const colonIdx = head.indexOf(':')
    const hashIdx = head.indexOf('#')
    if (colonIdx === -1 && hashIdx === -1) return { sentinel: head, path }
    const useColon = colonIdx !== -1 && (hashIdx === -1 || colonIdx < hashIdx)
    if (useColon) {
      return {
        sentinel: head.slice(0, colonIdx),
        profile: head.slice(colonIdx + 1) || undefined,
        path,
      }
    }
    return {
      sentinel: head.slice(0, hashIdx),
      pool: head.slice(hashIdx + 1) || undefined,
      path,
    }
  }
  return { path: input }
}

/** Returns the verbatim leading `@sentinel[:profile] ` portion (including
 *  trailing space) so dir selection preserves the user's sentinel + profile
 *  choice when the filter string is rebuilt. */
function sentinelPrefixFor(rawInput: string): string {
  if (!rawInput.startsWith('@')) return ''
  const spaceIdx = rawInput.indexOf(' ')
  if (spaceIdx === -1) return ''
  return rawInput.slice(0, spaceIdx + 1)
}

/** Build profile suggestion list for `@sentinel:` autocomplete. Reads the
 *  target sentinel's reported `profiles[]` from the conversations store --
 *  these are the SAFE names only (Profile-Env Boundary). Filtered by name
 *  prefix (case-insensitive). Falls back to an empty list when the sentinel
 *  is unknown or reports zero / one profile (no point completing in those
 *  cases -- `default` is implicit). */
function buildProfileSuggestions(
  sentinels: SentinelStatusInfo[],
  sentinelAlias: string,
  prefix: string,
): ProfileSuggestion[] {
  const lookup = sentinelAlias.toLowerCase()
  const match = sentinels.find(s => s.alias.toLowerCase() === lookup)
  const profiles = match?.profiles ?? []
  if (profiles.length <= 1) return []
  const out: ProfileSuggestion[] = []
  for (const p of profiles) {
    if (prefix && !p.name.toLowerCase().startsWith(prefix)) continue
    out.push({
      name: p.name,
      label: p.label,
      color: p.color,
      pool: p.pool,
      authed: p.authed,
    })
  }
  return out
}

/** Build pool suggestion list for `@sentinel#` autocomplete. Sourced from
 *  the sentinel's reported `pools[]`. Falls back to an empty list when the
 *  sentinel is unknown or reports zero / one pool (no point completing). */
function buildPoolSuggestions(
  sentinels: SentinelStatusInfo[],
  sentinelAlias: string,
  prefix: string,
): PoolSuggestion[] {
  const lookup = sentinelAlias.toLowerCase()
  const match = sentinels.find(s => s.alias.toLowerCase() === lookup)
  const pools = match?.pools ?? []
  if (pools.length <= 1) return []
  const profilesByPool = new Map<string, number>()
  for (const p of match?.profiles ?? []) {
    if (p.pool === null) continue
    profilesByPool.set(p.pool, (profilesByPool.get(p.pool) ?? 0) + 1)
  }
  const out: PoolSuggestion[] = []
  for (const name of pools) {
    if (prefix && !name.toLowerCase().startsWith(prefix)) continue
    out.push({
      name,
      profileCount: profilesByPool.get(name) ?? 0,
      isDefault: name === (match?.defaultPool ?? 'default'),
    })
  }
  return out
}

/** Build sentinel suggestion list. Default sentinel (whichever has
 *  `isDefault: true`, or the literal alias `default` as a fallback) is
 *  always first. Filtered by alias prefix (case-insensitive). */
function buildSentinelSuggestions(sentinels: SentinelStatusInfo[], prefix: string): SentinelSuggestion[] {
  const seen = new Set<string>()
  const out: SentinelSuggestion[] = []

  function push(s: SentinelSuggestion) {
    const key = s.alias.toLowerCase()
    if (seen.has(key)) return
    if (prefix && !key.startsWith(prefix)) return
    seen.add(key)
    out.push(s)
  }

  const defaultEntry = sentinels.find(s => s.isDefault) || sentinels.find(s => s.alias === DEFAULT_SENTINEL)
  if (defaultEntry) {
    push({ alias: defaultEntry.alias, connected: defaultEntry.connected, isDefault: true })
  } else {
    push({ alias: DEFAULT_SENTINEL, connected: sentinels.some(s => s.connected), isDefault: true })
  }

  for (const s of sentinels) {
    if (s.isDefault) continue
    push({ alias: s.alias, connected: s.connected, isDefault: false })
  }

  return out
}
