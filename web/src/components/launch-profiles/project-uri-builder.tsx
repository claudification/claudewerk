/**
 * Inline "build a project URI" panel for the launch-profile editor.
 *
 * Rendered IN PLACE -- not a Dialog -- so it opens from inside the Launch
 * Profiles modal without stacking a second overlay or fighting a nested
 * focus trap. Pick a sentinel, browse to a cwd via /api/dirs, and it
 * composes a canonical claude://{sentinel}/{path} URI.
 */

import { buildProjectUri, parseProjectUri } from '@shared/project-uri'
import { ChevronUp, FolderClosed, Loader2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { type SentinelStatusInfo, useConversationsStore } from '@/hooks/use-conversations'
import { cn } from '@/lib/utils'

const DEFAULT_SENTINEL = 'default'

interface Props {
  /** Existing URI to seed the sentinel + path from. Empty = fresh. */
  initialUri: string
  onApply: (uri: string) => void
  onClose: () => void
}

export function ProjectUriBuilder({ initialUri, onApply, onClose }: Props) {
  const sentinels = useConversationsStore(s => s.sentinels)
  const options = useMemo(() => buildSentinelOptions(sentinels), [sentinels])
  const seed = useMemo(() => seedFromUri(initialUri), [initialUri])
  const [sentinel, setSentinel] = useState(seed.sentinel)
  const [path, setPath] = useState(seed.path)

  const uri = buildProjectUri({ scheme: 'claude', authority: sentinel, path: uriPath(path) })

  function pickSentinel(alias: string) {
    if (alias === sentinel) return
    // The new sentinel has its own filesystem -- the old path is meaningless.
    setSentinel(alias)
    setPath('/')
  }

  return (
    <div className="border border-primary/25 bg-surface-inset/50 p-2.5 space-y-2.5 text-xs">
      <SentinelPicker options={options} value={sentinel} onChange={pickSentinel} />
      <DirBrowser path={path} sentinel={sentinel} onPathChange={setPath} />
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <code className="truncate font-mono text-[11px] text-primary">{uri}</code>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => onApply(uri)}
            className="px-2 py-1 text-[10px] bg-primary text-background font-bold"
          >
            Use this URI
          </button>
        </div>
      </div>
    </div>
  )
}

interface SentinelOption {
  alias: string
  connected: boolean
  isDefault: boolean
}

function SentinelPicker({
  options,
  value,
  onChange,
}: {
  options: SentinelOption[]
  value: string
  onChange: (alias: string) => void
}) {
  return (
    <div className="space-y-1">
      <div className="text-[9px] uppercase tracking-wide text-comment">Sentinel / workstation</div>
      <div className="flex flex-wrap gap-1">
        {options.map(o => (
          <button
            key={o.alias}
            type="button"
            onClick={() => onChange(o.alias)}
            title={o.connected ? 'Connected' : 'Offline'}
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 font-mono text-[11px] border transition-colors',
              o.alias === value
                ? 'border-primary/60 text-primary bg-primary/10'
                : 'border-primary/15 text-muted-foreground hover:text-foreground',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', o.connected ? 'bg-success' : 'bg-muted-foreground/40')} />
            {o.alias}
          </button>
        ))}
      </div>
    </div>
  )
}

function DirBrowser({
  path,
  sentinel,
  onPathChange,
}: {
  path: string
  sentinel: string
  onPathChange: (path: string) => void
}) {
  const { dirs, loading, error } = useDirListing(path, sentinel)
  return (
    <div className="space-y-1">
      <div className="text-[9px] uppercase tracking-wide text-comment">Working directory</div>
      <input
        aria-label="Working directory path"
        type="text"
        value={path}
        onChange={e => onPathChange(e.target.value)}
        spellCheck={false}
        className="w-full font-mono text-[11px] bg-surface-inset border border-primary/20 px-2 py-1 outline-none"
      />
      <div className="border border-primary/15 bg-surface-inset/70 max-h-44 overflow-y-auto">
        {path !== '/' && (
          <DirRow icon={<ChevronUp className="size-3" />} label=".." onClick={() => onPathChange(parentPath(path))} />
        )}
        <DirList dirs={dirs} loading={loading} error={error} onEnter={name => onPathChange(joinPath(path, name))} />
      </div>
    </div>
  )
}

function DirList({
  dirs,
  loading,
  error,
  onEnter,
}: {
  dirs: string[]
  loading: boolean
  error: string | null
  onEnter: (name: string) => void
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-comment">
        <Loader2 className="size-3 animate-spin" /> Listing…
      </div>
    )
  }
  if (error) return <div className="px-2 py-1 text-destructive">{error}</div>
  if (dirs.length === 0) return <div className="px-2 py-1 text-comment">No subdirectories.</div>
  return (
    <>
      {dirs.map(d => (
        <DirRow
          key={d}
          icon={<FolderClosed className="size-3 text-primary/70" />}
          label={d}
          onClick={() => onEnter(d)}
        />
      ))}
    </>
  )
}

function DirRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 w-full text-left px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-primary/10 hover:text-foreground transition-colors"
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

/** Sentinel picker options, default-first. Falls back to a synthetic
 *  `default` entry when no sentinel is connected so the picker is never
 *  empty (the user can still type a path by hand). */
function buildSentinelOptions(sentinels: SentinelStatusInfo[]): SentinelOption[] {
  if (sentinels.length === 0) {
    return [{ alias: DEFAULT_SENTINEL, connected: false, isDefault: true }]
  }
  return sentinels
    .map(s => ({ alias: s.alias, connected: s.connected, isDefault: !!s.isDefault }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.alias.localeCompare(b.alias))
}

function seedFromUri(uri: string): { sentinel: string; path: string } {
  try {
    const p = parseProjectUri(uri)
    return { sentinel: p.authority || DEFAULT_SENTINEL, path: p.path }
  } catch {
    return { sentinel: DEFAULT_SENTINEL, path: '/' }
  }
}

/** Path as stored in the URI: leading slash, no trailing slash except root. */
function uriPath(path: string): string {
  let p = path.trim()
  if (!p.startsWith('/')) p = `/${p}`
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p
}

function joinPath(base: string, name: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base
  return `${b}/${name}`
}

function parentPath(path: string): string {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

/** Debounced /api/dirs listing of the immediate child directories of `path`
 *  on the chosen sentinel. */
function useDirListing(path: string, sentinel: string): { dirs: string[]; loading: boolean; error: string | null } {
  const [dirs, setDirs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // scoped out of phase 7 PLAN (would need TanStack Query adoption)
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setLoading(true)
      setError(null)
      const params = new URLSearchParams({ path: uriPath(path), sentinel })
      fetch(`/api/dirs?${params}`)
        .then(async r => {
          const data = (await r.json()) as { dirs?: string[]; error?: string }
          setDirs(data.error ? [] : (data.dirs ?? []))
          setError(data.error ?? null)
        })
        .catch((e: unknown) => {
          setDirs([])
          setError(e instanceof Error ? e.message : 'Directory listing failed')
        })
        .finally(() => setLoading(false))
    }, 220)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [path, sentinel])

  return { dirs, loading, error }
}
