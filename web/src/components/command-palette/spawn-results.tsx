import { FolderPlus, Hash, Server, Star, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SpawnResultsProps } from './types'
import type { PoolSuggestion, ProfileSuggestion } from './use-spawn-mode'

function ProfileEntryRow({
  profile,
  active,
  onSelect,
  onHover,
}: {
  profile: ProfileSuggestion
  active: boolean
  onSelect: () => void
  onHover: () => void
}) {
  const colorStyle = profile.color ? { color: profile.color } : undefined
  return (
    <button
      type="button"
      data-active={active}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
        active ? 'bg-primary/20' : 'hover:bg-primary/10',
      )}
    >
      <User
        className={cn('w-3.5 h-3.5 shrink-0', profile.authed ? 'text-active' : 'text-amber-400/80')}
        style={colorStyle}
      />
      <span className="text-xs text-foreground" style={colorStyle}>
        {profile.name}
      </span>
      {profile.label && <span className="text-[9px] text-comment">{profile.label}</span>}
      {profile.pool === null && <span className="text-[9px] text-comment uppercase">pinned</span>}
      {profile.pool && <span className="text-[9px] text-comment lowercase">#{profile.pool}</span>}
      {profile.authed === false && (
        <span
          className="text-[9px] text-amber-400/80 uppercase"
          title="Sentinel couldn't find credentials file at configDir root; may still be authed via OS keychain"
        >
          auth ?
        </span>
      )}
    </button>
  )
}

function ProfileEntryList({
  profiles,
  resolvedSentinel,
  activeIndex,
  setActiveIndex,
  onProfileSelect,
}: {
  profiles: ProfileSuggestion[]
  resolvedSentinel: string
  activeIndex: number
  setActiveIndex: (i: number) => void
  onProfileSelect: (name: string) => void
}) {
  if (profiles.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-[10px] text-comment">
        No matching profile on <span className="text-foreground">@{resolvedSentinel}</span>
      </div>
    )
  }
  return (
    <>
      {profiles.map((p, i) => (
        <ProfileEntryRow
          key={p.name}
          profile={p}
          active={i === activeIndex}
          onSelect={() => onProfileSelect(p.name)}
          onHover={() => setActiveIndex(i)}
        />
      ))}
    </>
  )
}

function PoolEntryRow({
  pool,
  active,
  onSelect,
  onHover,
}: {
  pool: PoolSuggestion
  active: boolean
  onSelect: () => void
  onHover: () => void
}) {
  return (
    <button
      type="button"
      data-active={active}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
        active ? 'bg-primary/20' : 'hover:bg-primary/10',
      )}
    >
      <Hash className="w-3.5 h-3.5 shrink-0 text-active" />
      <span className="text-xs text-foreground">#{pool.name}</span>
      <span className="text-[9px] text-comment">
        {pool.profileCount} profile{pool.profileCount === 1 ? '' : 's'}
      </span>
      {pool.isDefault && (
        <span className="text-[9px] text-active uppercase tracking-wide flex items-center gap-0.5">
          <Star className="w-2.5 h-2.5" /> default
        </span>
      )}
    </button>
  )
}

function PoolEntryList({
  pools,
  resolvedSentinel,
  activeIndex,
  setActiveIndex,
  onPoolSelect,
}: {
  pools: PoolSuggestion[]
  resolvedSentinel: string
  activeIndex: number
  setActiveIndex: (i: number) => void
  onPoolSelect: (name: string) => void
}) {
  if (pools.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-[10px] text-comment">
        No matching pool on <span className="text-foreground">@{resolvedSentinel}</span>
      </div>
    )
  }
  return (
    <>
      {pools.map((p, i) => (
        <PoolEntryRow
          key={p.name}
          pool={p}
          active={i === activeIndex}
          onSelect={() => onPoolSelect(p.name)}
          onHover={() => setActiveIndex(i)}
        />
      ))}
    </>
  )
}

export function SpawnResults({
  dirs,
  sentinels,
  profiles,
  pools,
  isSentinelEntry,
  isProfileEntry,
  isPoolEntry,
  resolvedSentinel,
  resolvedProfile,
  resolvedPool,
  loading,
  error,
  path,
  spawning,
  sentinelConnected,
  canCreateDir,
  activeIndex,
  setActiveIndex,
  onDirSelect,
  onSentinelSelect,
  onProfileSelect,
  onPoolSelect,
  onSpawn,
}: SpawnResultsProps) {
  if (!sentinelConnected) {
    return <div className="px-3 py-4 text-center text-[10px] text-red-400">No sentinel connected</div>
  }

  // Profile autocomplete: user has typed `@sentinel:` and is filling in the
  // profile-name suffix.
  if (isProfileEntry) {
    return (
      <ProfileEntryList
        profiles={profiles}
        resolvedSentinel={resolvedSentinel}
        activeIndex={activeIndex}
        setActiveIndex={setActiveIndex}
        onProfileSelect={onProfileSelect}
      />
    )
  }

  // Pool autocomplete: user has typed `@sentinel#` and is filling in the
  // pool-name suffix. Sourced from the sentinel's reported pools.
  if (isPoolEntry) {
    return (
      <PoolEntryList
        pools={pools}
        resolvedSentinel={resolvedSentinel}
        activeIndex={activeIndex}
        setActiveIndex={setActiveIndex}
        onPoolSelect={onPoolSelect}
      />
    )
  }

  // Sentinel autocomplete: user is typing the @<alias> token.
  if (isSentinelEntry) {
    if (sentinels.length === 0) {
      return <div className="px-3 py-4 text-center text-[10px] text-comment">No matching sentinel</div>
    }
    return (
      <>
        {sentinels.map((s, i) => (
          <button
            key={s.alias}
            type="button"
            data-active={i === activeIndex}
            onClick={() => onSentinelSelect(s.alias)}
            onMouseEnter={() => setActiveIndex(i)}
            className={cn(
              'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
              i === activeIndex ? 'bg-primary/20' : 'hover:bg-primary/10',
            )}
          >
            <Server className={cn('w-3.5 h-3.5 shrink-0', s.connected ? 'text-active' : 'text-comment')} />
            <span className="text-xs text-foreground">@{s.alias}</span>
            {s.isDefault && <span className="text-[9px] text-active uppercase tracking-wide">default</span>}
            {!s.connected && <span className="text-[9px] text-comment">offline</span>}
          </button>
        ))}
      </>
    )
  }

  if (loading) {
    return <div className="px-3 py-4 text-center text-[10px] text-comment">Loading directories...</div>
  }

  if (error) {
    return <div className="px-3 py-4 text-center text-[10px] text-red-400">{error}</div>
  }

  if (!path) {
    return (
      <div className="px-3 py-4 text-center text-[10px] text-comment">
        Type a path (e.g. ~/projects/my-app) -- routing to <span className="text-foreground">@{resolvedSentinel}</span>
        {resolvedProfile && (
          <>
            {' '}
            with profile <span className="text-foreground">{resolvedProfile}</span>
          </>
        )}
        {resolvedPool && (
          <>
            {' '}
            from pool <span className="text-foreground">#{resolvedPool}</span>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      {dirs.length === 0 && !spawning && !canCreateDir && (
        <div className="px-3 py-4 text-center text-[10px] text-comment">
          {path.endsWith('/') ? 'No subdirectories' : 'No matches'}
        </div>
      )}
      {canCreateDir && !spawning && (
        <button
          type="button"
          onClick={() => onSpawn(path.endsWith('/') ? path.slice(0, -1) : path, true)}
          className="w-full px-3 py-2 flex items-center gap-3 text-left bg-amber-400/10 hover:bg-amber-400/20 transition-colors"
        >
          <FolderPlus className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-xs">
            <span className="text-amber-400 font-bold">Create</span>{' '}
            <span className="text-foreground">{path.endsWith('/') ? path.slice(0, -1) : path}</span>{' '}
            <span className="text-amber-400 font-bold">& spawn</span>
          </span>
        </button>
      )}
      {dirs.map((dir, i) => (
        <button
          key={dir}
          type="button"
          data-active={i === activeIndex}
          onClick={() => onDirSelect(dir)}
          onMouseEnter={() => setActiveIndex(i)}
          className={cn(
            'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
            i === activeIndex ? 'bg-primary/20' : 'hover:bg-primary/10',
          )}
        >
          <FolderPlus className="w-3.5 h-3.5 text-active shrink-0" />
          <span className="text-xs text-foreground">{dir}/</span>
        </button>
      ))}
      {path?.endsWith('/') && !spawning && (
        <button
          type="button"
          onClick={() => onSpawn(path.slice(0, -1))}
          className="w-full px-3 py-2 flex items-center gap-3 text-left bg-active/10 hover:bg-active/20 transition-colors border-t border-primary/20"
        >
          <FolderPlus className="w-3.5 h-3.5 text-active shrink-0" />
          <span className="text-xs text-active font-bold">Spawn conversation at {path.slice(0, -1)}</span>
        </button>
      )}
      {spawning && (
        <div className="px-3 py-4 text-center text-[10px] text-active animate-pulse">Spawning conversation...</div>
      )}
    </>
  )
}
