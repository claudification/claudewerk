import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'

interface SentinelProfileInfoLite {
  name: string
  label?: string
  color?: string
  pool: string | null
  authed: boolean
}

type SelectionMode = 'default' | 'balanced' | 'random'

interface SentinelEntry {
  sentinelId: string
  alias: string
  aliases: string[]
  isDefault: boolean
  color?: string
  connected: boolean
  hostname?: string
  spawnRoot?: string
  createdAt: number
  profiles?: SentinelProfileInfoLite[]
  defaultSelection?: SelectionMode
  pools?: string[]
  defaultPool?: string
}

/** Per-(sentinelId, profile) usage breakdown row (matches
 *  ProfileBreakdownRow on the server -- web is JS-typed for now to avoid
 *  pulling broker types into the UI bundle). */
interface ProfileUsageRow {
  sentinelId: string
  profile: string
  costUsd: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function ProfilePoolBadge({ pool }: { pool: string | null }) {
  if (pool === null) {
    return <span className="px-1 py-0.5 text-[8px] text-muted-foreground/40 rounded uppercase">pinned</span>
  }
  return <span className="px-1 py-0.5 text-[8px] bg-accent/12 text-accent/80 rounded lowercase">#{pool}</span>
}

function ProfileUsageSpan({ usage }: { usage?: ProfileUsageRow }) {
  if (!usage) return null
  return (
    <span className="text-muted-foreground/60">
      {usage.turns} turn{usage.turns === 1 ? '' : 's'} · {fmtUsd(usage.costUsd)}
    </span>
  )
}

/** Auth detection is best-effort: the sentinel only checks for credential
 *  files at the configDir root. macOS stores Claude creds in the Keychain
 *  (no file present), so a "no" verdict may actually be an authed profile.
 *  Render the unknown state as a warning, not a hard fail, until we have a
 *  cross-platform auth probe. */
const AUTH_UNKNOWN_TIP =
  "Sentinel couldn't find .credentials.json / .claude.json at the configDir root. The profile may still be authed via the OS keychain (macOS). Run `sentinel profile auth <name>` to (re-)login if needed."

function ProfileBreakdownLine({ profile, usage }: { profile: SentinelProfileInfoLite; usage?: ProfileUsageRow }) {
  const authClass = profile.authed ? 'text-active/70' : 'text-amber-400/70'
  const authGlyph = profile.authed ? '✓' : '?'
  const colorStyle = profile.color ? { color: profile.color } : undefined
  return (
    <div className="flex items-center gap-2 pl-6 py-0.5 text-[10px] text-muted-foreground/80 font-mono">
      <span className={`text-sm ${authClass}`} title={profile.authed ? 'Credentials file present' : AUTH_UNKNOWN_TIP}>
        {authGlyph}
      </span>
      <span className="text-foreground" style={colorStyle}>
        {profile.name}
      </span>
      {profile.label && <span className="text-muted-foreground/50">{profile.label}</span>}
      <ProfilePoolBadge pool={profile.pool} />
      <span className="flex-1" />
      <ProfileUsageSpan usage={usage} />
    </div>
  )
}

function SentinelHeader({
  sentinel,
  onSetDefault,
  onRevoke,
}: {
  sentinel: SentinelEntry
  onSetDefault: () => void
  onRevoke: () => void
}) {
  const showSelection = sentinel.defaultSelection && sentinel.defaultSelection !== 'default'
  const showDefaultPool = sentinel.defaultPool && sentinel.defaultPool !== 'default'
  return (
    <div className="flex items-center gap-2 p-2">
      <span className={`text-sm ${sentinel.connected ? 'text-active' : 'text-muted-foreground/40'}`}>
        {sentinel.connected ? '●' : '○'}
      </span>
      <span className="font-bold text-foreground">{sentinel.alias}</span>
      {sentinel.hostname && <span className="text-muted-foreground/50">{sentinel.hostname}</span>}
      {sentinel.isDefault && (
        <span className="px-1 py-0.5 text-[8px] bg-accent/20 text-accent rounded uppercase font-bold">default</span>
      )}
      {showSelection && (
        <span className="px-1 py-0.5 text-[8px] bg-primary/12 text-primary/80 rounded uppercase">
          {sentinel.defaultSelection}
        </span>
      )}
      {showDefaultPool && (
        <span className="px-1 py-0.5 text-[8px] bg-accent/12 text-accent/80 rounded lowercase">
          pool: {sentinel.defaultPool}
        </span>
      )}
      <span className="flex-1" />
      {!sentinel.isDefault && (
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={onSetDefault}
        >
          set default
        </button>
      )}
      <button
        type="button"
        className="text-[10px] text-destructive/70 hover:text-destructive cursor-pointer"
        onClick={onRevoke}
      >
        revoke
      </button>
    </div>
  )
}

function OrphanProfileLine({ row }: { row: ProfileUsageRow }) {
  return (
    <div className="flex items-center gap-2 pl-6 py-0.5 text-[10px] text-muted-foreground/50 font-mono">
      <span className="text-sm text-muted-foreground/30">·</span>
      <span className="italic">{row.profile}</span>
      <span className="px-1 py-0.5 text-[8px] text-muted-foreground/40 uppercase">history</span>
      <span className="flex-1" />
      <span>
        {row.turns} turn{row.turns === 1 ? '' : 's'} · {fmtUsd(row.costUsd)}
      </span>
    </div>
  )
}

function computeOrphans(
  profiles: SentinelProfileInfoLite[],
  usage: Map<string, ProfileUsageRow>,
  connected: boolean,
): ProfileUsageRow[] {
  if (!connected || profiles.length === 0) return []
  const known = new Set(profiles.map(p => p.name))
  const out: ProfileUsageRow[] = []
  for (const [name, row] of usage) {
    if (!known.has(name)) out.push(row)
  }
  return out
}

function SentinelRow({
  sentinel,
  usage,
  onSetDefault,
  onRevoke,
}: {
  sentinel: SentinelEntry
  /** Per-profile usage map keyed by profile name. Only present for this sentinel. */
  usage: Map<string, ProfileUsageRow>
  onSetDefault: () => void
  onRevoke: () => void
}) {
  const profiles = sentinel.profiles ?? []
  const orphanUsage = computeOrphans(profiles, usage, sentinel.connected)
  // Show the configure-via-CLI hint when the sentinel reports profiles. Phase
  // 7 covers broker-managed mutation of `defaultSelection` and per-profile
  // `pooled`; for now those are configured by editing the sentinel's
  // `sentinel.json` or invoking `sentinel profile pool`. Surfacing the hint
  // tells the user how to change what the UI shows read-only.
  const showCliHint = sentinel.connected && profiles.length > 0
  return (
    <div className="border border-border rounded text-xs font-mono">
      <SentinelHeader sentinel={sentinel} onSetDefault={onSetDefault} onRevoke={onRevoke} />
      {profiles.length > 0 && (
        <div className="border-t border-border/40 py-1">
          {profiles.map(p => (
            <ProfileBreakdownLine key={p.name} profile={p} usage={usage.get(p.name)} />
          ))}
          {orphanUsage.map(row => (
            <OrphanProfileLine key={`orphan-${row.profile}`} row={row} />
          ))}
          {showCliHint && (
            <div className="pl-6 pr-2 pt-1 text-[9px] text-muted-foreground/50 leading-snug">
              Pool / default-selection are sentinel-local. Configure via{' '}
              <code className="text-foreground/70">sentinel profile pool</code> or by editing{' '}
              <code className="text-foreground/70">~/.config/rclaude/sentinel.json</code> on the host.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CreatedSecretBanner({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  return (
    <div className="p-3 border border-active/50 bg-active/5 rounded space-y-2">
      <div className="text-[10px] text-active uppercase tracking-wider font-bold">Secret (shown once)</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-[10px] font-mono text-foreground break-all select-all">{secret}</code>
        <button
          type="button"
          className="px-2 py-1 text-[10px] font-mono border border-border hover:bg-muted cursor-pointer shrink-0"
          onClick={() => {
            navigator.clipboard.writeText(secret)
            haptic('tick')
          }}
        >
          copy
        </button>
      </div>
      <div className="text-[10px] text-muted-foreground mt-1">
        Configure the sentinel:
        <pre className="mt-1 p-2 bg-muted rounded text-[9px] whitespace-pre-wrap">
          {`export CLAUDWERK_SENTINEL_SECRET=${secret}\nexport CLAUDWERK_BROKER=wss://<your-broker-host>\nsentinel --alias <alias>`}
        </pre>
      </div>
      <button
        type="button"
        className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
        onClick={onDismiss}
      >
        dismiss
      </button>
    </div>
  )
}

function SentinelList() {
  const [sentinels, setSentinels] = useState<SentinelEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newAlias, setNewAlias] = useState('')
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const [profileUsage, setProfileUsage] = useState<ProfileUsageRow[]>([])
  const connectedSentinels = useConversationsStore(s => s.sentinels)

  const fetchSentinels = useCallback(() => {
    setLoading(true)
    fetch('/api/sentinels')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setSentinels(data)
        else setError(data.error || 'Failed to load sentinels')
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  const fetchProfileUsage = useCallback(() => {
    // Per-(sentinelId, profile) cost breakdown. New in Phase 5; gracefully
    // tolerate older brokers that don't yet expose this endpoint.
    fetch('/api/stats/profiles', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data && Array.isArray(data.profiles)) setProfileUsage(data.profiles as ProfileUsageRow[])
      })
      .catch(() => {
        /* ignore -- usage is decorative, not required for sentinel management */
      })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: connectedSentinels is a refetch trigger
  useEffect(() => {
    fetchSentinels()
    fetchProfileUsage()
  }, [fetchSentinels, fetchProfileUsage, connectedSentinels])

  function handleCreate() {
    if (!newAlias.trim()) return
    setCreating(true)
    setCreatedSecret(null)
    fetch('/api/sentinels/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: newAlias.trim().toLowerCase() }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.sentinelSecret) {
          setCreatedSecret(data.sentinelSecret)
          setNewAlias('')
          fetchSentinels()
          haptic('success')
        } else {
          setError(data.error || 'Failed to create sentinel')
          haptic('error')
        }
        setCreating(false)
      })
      .catch(err => {
        setError(err.message)
        setCreating(false)
        haptic('error')
      })
  }

  function handleSetDefault(sentinelId: string) {
    fetch(`/api/sentinels/${sentinelId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    })
      .then(() => {
        fetchSentinels()
        haptic('tap')
      })
      .catch(() => haptic('error'))
  }

  function handleRevoke(sentinelId: string, alias: string) {
    if (!confirm(`Revoke sentinel "${alias}"? This invalidates its secret.`)) return
    fetch(`/api/sentinels/${sentinelId}`, { method: 'DELETE' })
      .then(() => {
        fetchSentinels()
        haptic('tap')
      })
      .catch(() => haptic('error'))
  }

  if (loading && sentinels.length === 0) {
    return <div className="text-xs text-muted-foreground text-center py-4">Loading sentinels...</div>
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-xs text-destructive">{error}</div>}

      <div className="space-y-2">
        {sentinels.map(s => {
          const usageMap = new Map<string, ProfileUsageRow>()
          for (const row of profileUsage) {
            if (row.sentinelId === s.sentinelId) usageMap.set(row.profile, row)
          }
          return (
            <SentinelRow
              key={s.sentinelId}
              sentinel={s}
              usage={usageMap}
              onSetDefault={() => handleSetDefault(s.sentinelId)}
              onRevoke={() => handleRevoke(s.sentinelId, s.alias)}
            />
          )
        })}
        {sentinels.length === 0 && (
          <div className="text-xs text-muted-foreground/50 text-center py-2">
            No sentinels registered. Create one below.
          </div>
        )}
      </div>

      <div className="border-t border-border/50 pt-3">
        <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-2">Create Sentinel</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newAlias}
            onChange={e => setNewAlias(e.target.value)}
            placeholder="alias (e.g. beast)"
            className="flex-1 px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring rounded"
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate()
            }}
          />
          <button
            type="button"
            disabled={creating || !newAlias.trim()}
            className="px-3 py-1 text-xs font-mono bg-accent text-accent-foreground hover:bg-accent/80 disabled:opacity-50 cursor-pointer rounded"
            onClick={handleCreate}
          >
            {creating ? '...' : 'create'}
          </button>
        </div>
      </div>

      {createdSecret && <CreatedSecretBanner secret={createdSecret} onDismiss={() => setCreatedSecret(null)} />}
    </div>
  )
}

export function SentinelManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] p-0">
        <div className="px-6 pt-5 pb-3 pr-12">
          <DialogTitle className="text-accent font-bold uppercase tracking-wider text-[10px]">Sentinels</DialogTitle>
        </div>
        <div className="px-6 pb-6 overflow-y-auto">
          <SentinelList />
        </div>
      </DialogContent>
    </Dialog>
  )
}
