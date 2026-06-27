/**
 * SentinelConfigEditor -- the broker-tunable sentinel config screen (Phase 8 of
 * `.claude/docs/plan-sentinel-profiles.md`).
 *
 * Edits the BROKER-TUNABLE subset only: per-profile weight / pool / label /
 * color and sentinel-wide defaultSelection / defaultPool. A single "Save"
 * issues ONE batched `POST /api/sentinels/:id/config` (which forwards a single
 * `sentinel_patch_config` to the sentinel). Optimistic UI: the draft is shown
 * immediately; on an ack failure the draft is rolled back to the last-saved
 * baseline and the error surfaced.
 *
 * PROFILE-ENV BOUNDARY: configDir / env / spawnRoot and profile creation are
 * NOT editable here -- they bind a NAME to host filesystem + credentials and
 * stay sentinel-local (CLI). A read-only hint explains why.
 */
import { useEffect, useMemo, useState } from 'react'
import { haptic } from '@/lib/utils'

export type SelectionMode = 'default' | 'balanced' | 'random'

export interface SentinelProfileInfoLite {
  name: string
  label?: string
  color?: string
  pool: string | null
  /** Relative selection weight within the pool (default 1, >= 0). */
  weight?: number
  authed: boolean
}

/** Per-profile editable draft. `pool: null` = excluded from every pool. */
interface ProfileDraft {
  weight: number
  pool: string | null
  label: string
  color: string
}

interface Draft {
  profiles: Record<string, ProfileDraft>
  defaultSelection: SelectionMode
  defaultPool: string
}

function profileToDraft(p: SentinelProfileInfoLite): ProfileDraft {
  return {
    weight: typeof p.weight === 'number' ? p.weight : 1,
    pool: p.pool,
    label: p.label ?? '',
    color: p.color ?? '',
  }
}

function buildBaseline(
  profiles: SentinelProfileInfoLite[],
  defaultSelection: SelectionMode,
  defaultPool: string,
): Draft {
  const out: Record<string, ProfileDraft> = {}
  for (const p of profiles) out[p.name] = profileToDraft(p)
  return { profiles: out, defaultSelection, defaultPool }
}

/** Shallow-equal two drafts -- used to enable/disable Save. */
// fallow-ignore-next-line complexity
function draftsEqual(a: Draft, b: Draft): boolean {
  if (a.defaultSelection !== b.defaultSelection || a.defaultPool !== b.defaultPool) return false
  const an = Object.keys(a.profiles)
  const bn = Object.keys(b.profiles)
  if (an.length !== bn.length) return false
  for (const name of an) {
    const x = a.profiles[name]
    const y = b.profiles[name]
    if (!y) return false
    if (x.weight !== y.weight || x.pool !== y.pool || x.label !== y.label || x.color !== y.color) return false
  }
  return true
}

/**
 * Compute the minimal patch body (only changed fields) from baseline -> draft.
 * Empty `label` / `color` are sent as empty string (the sentinel clears them).
 * `pool: null` is sent verbatim (excluded). Returns `null` when nothing changed.
 */
// fallow-ignore-next-line complexity
function computePatchBody(baseline: Draft, draft: Draft): Record<string, unknown> | null {
  const body: Record<string, unknown> = {}
  const profiles: Record<string, Record<string, unknown>> = {}
  for (const [name, d] of Object.entries(draft.profiles)) {
    const b = baseline.profiles[name]
    if (!b) continue
    const entry: Record<string, unknown> = {}
    if (d.weight !== b.weight) entry.weight = d.weight
    if (d.pool !== b.pool) entry.pool = d.pool
    if (d.label !== b.label) entry.label = d.label
    if (d.color !== b.color) entry.color = d.color
    if (Object.keys(entry).length > 0) profiles[name] = entry
  }
  if (Object.keys(profiles).length > 0) body.profiles = profiles
  if (draft.defaultSelection !== baseline.defaultSelection) body.defaultSelection = draft.defaultSelection
  if (draft.defaultPool !== baseline.defaultPool) body.defaultPool = draft.defaultPool
  return Object.keys(body).length > 0 ? body : null
}

const POOL_NONE = '__none__'

// fallow-ignore-next-line complexity
function ProfileEditRow({
  name,
  draft,
  pools,
  onChange,
}: {
  name: string
  draft: ProfileDraft
  pools: string[]
  onChange: (next: ProfileDraft) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pl-6 pr-2 py-1 text-[10px]">
      <span className="text-foreground font-bold min-w-[64px]" style={draft.color ? { color: draft.color } : undefined}>
        {name}
      </span>
      <label className="flex items-center gap-1 text-muted-foreground/70">
        w
        <input
          type="number"
          min={0}
          step={1}
          value={draft.weight}
          onChange={e => onChange({ ...draft, weight: Math.max(0, Number(e.target.value) || 0) })}
          className="w-12 px-1 py-0.5 bg-muted border border-border text-foreground rounded text-[10px]"
        />
      </label>
      <label className="flex items-center gap-1 text-muted-foreground/70">
        pool
        <select
          value={draft.pool === null ? POOL_NONE : draft.pool}
          onChange={e => onChange({ ...draft, pool: e.target.value === POOL_NONE ? null : e.target.value })}
          className="px-1 py-0.5 bg-muted border border-border text-foreground rounded text-[10px] lowercase"
        >
          {/* Pools the sentinel reported, plus the current pool if it's not in
              the reported set (defensive), plus the "excluded" sentinel. */}
          {[...new Set([...pools, ...(draft.pool && !pools.includes(draft.pool) ? [draft.pool] : [])])].map(p => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value={POOL_NONE}>(excluded)</option>
        </select>
      </label>
      <input
        aria-label="Sentinel label"
        type="text"
        value={draft.label}
        placeholder="label"
        onChange={e => onChange({ ...draft, label: e.target.value })}
        className="w-24 px-1 py-0.5 bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 rounded text-[10px]"
      />
      <input
        aria-label="Sentinel color"
        type="text"
        value={draft.color}
        placeholder="#color"
        onChange={e => onChange({ ...draft, color: e.target.value })}
        className="w-20 px-1 py-0.5 bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 rounded text-[10px]"
      />
    </div>
  )
}

export function SentinelConfigEditor({
  sentinelId,
  profiles,
  pools,
  defaultSelection,
  defaultPool,
  onSaved,
}: {
  sentinelId: string
  profiles: SentinelProfileInfoLite[]
  pools: string[]
  defaultSelection: SelectionMode
  defaultPool: string
  onSaved: () => void
}) {
  const baseline = useMemo(
    () => buildBaseline(profiles, defaultSelection, defaultPool),
    [profiles, defaultSelection, defaultPool],
  )
  const [draft, setDraft] = useState<Draft>(baseline)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Resync the draft when the upstream baseline changes (e.g. a fresh fetch
  // after another save, or a sentinel reconnect with new profiles).
  useEffect(() => {
    setDraft(baseline)
    setError(null)
  }, [baseline])

  const dirty = !draftsEqual(baseline, draft)
  // Pool options for the sentinel-wide defaultPool: reported pools plus any
  // pool a draft profile is being moved into (so the selector stays valid).
  const draftPools = useMemo(() => {
    const set = new Set<string>(pools)
    for (const d of Object.values(draft.profiles)) if (d.pool) set.add(d.pool)
    return Array.from(set).toSorted()
  }, [pools, draft.profiles])

  function patchProfile(name: string, next: ProfileDraft) {
    setDraft(d => ({ ...d, profiles: { ...d.profiles, [name]: next } }))
  }

  // fallow-ignore-next-line complexity
  async function handleSave() {
    const body = computePatchBody(baseline, draft)
    if (!body) return
    setSaving(true)
    setError(null)
    // Optimistic: the draft already reflects the desired state. On failure we
    // roll back to the baseline below.
    try {
      const resp = await fetch(`/api/sentinels/${sentinelId}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string }
      if (!resp.ok || !data.ok) {
        // Roll back the optimistic draft to the last-saved baseline.
        setDraft(baseline)
        setError(data.detail || data.error || `Save failed (${resp.status})`)
        haptic('error')
      } else {
        haptic('success')
        onSaved()
      }
    } catch (e) {
      setDraft(baseline)
      setError((e as Error).message)
      haptic('error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-border/40 pt-1 pb-2">
      <div className="px-2 pb-1 text-[9px] text-muted-foreground/50 uppercase tracking-wider">Tune (live)</div>

      {Object.entries(draft.profiles).map(([name, d]) => (
        <ProfileEditRow
          key={name}
          name={name}
          draft={d}
          pools={draftPools}
          onChange={next => patchProfile(name, next)}
        />
      ))}

      {/* Sentinel-wide selectors. */}
      <div className="flex flex-wrap items-center gap-2 pl-6 pr-2 py-1 text-[10px]">
        <label className="flex items-center gap-1 text-muted-foreground/70">
          selection
          <select
            value={draft.defaultSelection}
            onChange={e => setDraft(d => ({ ...d, defaultSelection: e.target.value as SelectionMode }))}
            className="px-1 py-0.5 bg-muted border border-border text-foreground rounded text-[10px]"
          >
            <option value="default">default</option>
            <option value="balanced">balanced</option>
            <option value="random">random</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-muted-foreground/70">
          default pool
          <select
            value={draft.defaultPool}
            onChange={e => setDraft(d => ({ ...d, defaultPool: e.target.value }))}
            className="px-1 py-0.5 bg-muted border border-border text-foreground rounded text-[10px] lowercase"
          >
            {Array.from(new Set([...draftPools, draft.defaultPool]))
              .toSorted()
              .map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
          </select>
        </label>
        <span className="flex-1" />
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={handleSave}
          className="px-2 py-0.5 text-[10px] font-mono bg-accent text-accent-foreground hover:bg-accent/80 disabled:opacity-40 cursor-pointer rounded"
        >
          {saving ? 'saving...' : 'save'}
        </button>
      </div>

      {error && <div className="pl-6 pr-2 pt-1 text-[10px] text-destructive">{error}</div>}

      {/* Read-only boundary hint: secrets + filesystem + profile CRUD stay on host. */}
      <div className="pl-6 pr-2 pt-1 text-[9px] text-muted-foreground/50 leading-snug">
        <code className="text-foreground/70">configDir</code>, env vars, and adding/removing profiles are configured via
        CLI on the host (<code className="text-foreground/70">sentinel profile add/set/auth</code>) -- secrets stay on
        the host and never traverse the wire.
      </div>
    </div>
  )
}
