import { formatResetIn } from '@shared/format-reset-time'
import type { ProjectSettings } from '@shared/protocol'
import { ChevronRight, Copy } from 'lucide-react'
import { useState } from 'react'
import { wsSend } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, formatTime, haptic } from '@/lib/utils'
import type { ConversationTarget } from './conversation-header'

export function ErrorBanner({ lastError }: { lastError: Conversation['lastError'] }) {
  if (!lastError) return null
  return (
    <div className="px-2 py-1.5 bg-destructive/15 border border-destructive/40 text-[10px] font-mono space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="text-destructive font-bold uppercase">API Error</span>
        {lastError.errorType && <span className="text-destructive/80">{lastError.errorType}</span>}
        <span className="text-muted-foreground ml-auto">{formatTime(lastError.timestamp)}</span>
      </div>
      {lastError.errorMessage && <div className="text-destructive/70">{lastError.errorMessage}</div>}
      {lastError.stopReason && <div className="text-muted-foreground">reason: {lastError.stopReason}</div>}
    </div>
  )
}

export function RateLimitBanner({ rateLimit }: { rateLimit: Conversation['rateLimit'] }) {
  if (!rateLimit) return null
  const identity =
    rateLimit.profile && rateLimit.sentinelAlias
      ? `${rateLimit.profile} @ ${rateLimit.sentinelAlias}`
      : rateLimit.sentinelAlias || rateLimit.profile || undefined
  const resetText = formatResetIn(rateLimit.resetsAt)
  return (
    <div className="px-2 py-1 bg-amber-500/10 border border-amber-500/30 text-[10px] font-mono flex items-center gap-2">
      <span className="text-amber-400 font-bold uppercase">Rate Limited</span>
      <span className="text-amber-400/70">{rateLimit.message}</span>
      {identity && <span className="text-muted-foreground">{identity}</span>}
      {resetText && <span className="text-amber-400/70">{resetText}</span>}
      <span className="text-muted-foreground ml-auto">{formatTime(rateLimit.timestamp)}</span>
    </div>
  )
}

export function ProjectPathRow({ project }: { project: string }) {
  return (
    <div className="flex items-center gap-1 group/project">
      <span className="text-[10px] text-muted-foreground truncate">{projectPath(project)}</span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(projectPath(project))
          haptic('tap')
        }}
        className="shrink-0 text-muted-foreground/30 hover:text-muted-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/project:opacity-100 transition-opacity"
        title="Copy path"
      >
        <Copy className="w-3 h-3" />
      </button>
    </div>
  )
}

export function SummaryRow({ summary }: { summary: string | undefined }) {
  if (!summary) return null
  return (
    <div className="text-[10px] text-muted-foreground/70 truncate" title={summary}>
      {summary}
    </div>
  )
}

export function RecapRow({ recap, recapFresh }: { recap: Conversation['recap']; recapFresh: boolean | undefined }) {
  if (!recap) return null
  return (
    <div
      className={cn(
        'text-[10px] transition-all duration-700',
        recapFresh
          ? 'text-zinc-300/70 border-l-2 border-zinc-500/40 pl-2 py-1 bg-zinc-800/15 rounded-r leading-relaxed'
          : 'text-muted-foreground/40 italic truncate',
      )}
      title={recap.content}
    >
      {recap.title && <span className="font-medium">{recap.title}: </span>}
      {recapFresh ? recap.content : recap.content}
    </div>
  )
}

export function PrLinksRow({ prLinks }: { prLinks: Conversation['prLinks'] }) {
  if (!prLinks || prLinks.length === 0) return null
  return (
    <div className="flex items-center gap-2 mt-0.5">
      {prLinks.map(pr => (
        <a
          key={pr.prUrl}
          href={pr.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] font-mono text-sky-400 hover:text-sky-300 hover:underline transition-colors"
        >
          {pr.prRepository.split('/').pop()}#{pr.prNumber}
        </a>
      ))}
    </div>
  )
}

export function TrustLevelBadge({ projectSettings }: { projectSettings: ProjectSettings | undefined }) {
  if (!projectSettings?.trustLevel || projectSettings.trustLevel === 'default') return null
  return (
    <div className="mt-1">
      <span
        className={cn(
          'px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border rounded',
          projectSettings.trustLevel === 'open'
            ? 'bg-green-400/15 text-green-400 border-green-400/30'
            : 'bg-amber-400/15 text-amber-400 border-amber-400/30',
        )}
      >
        {projectSettings.trustLevel === 'open' ? '🔓 Open' : '🤝 Benevolent'}
      </span>
    </div>
  )
}

/**
 * Read-only "Launch config" disclosure for a daemon-transport conversation --
 * how the worker was launched (transport + mode + injected config). Renders
 * nothing for non-daemon conversations. Transport reframe (Phase 5): keys off
 * the canonical `transport === 'claude-daemon'` (with `daemonMode` as the
 * legacy dual-read) and surfaces `transport` directly. The conversation's live
 * ccSessionId is never shown -- this is launch INPUT only.
 */
type LaunchConfigDetail = NonNullable<Conversation['launchConfig']>

/** The detail rows for the daemon launch-config disclosure. Pure so the
 *  component stays thin (transport + mode + injected config; never secrets). */
function buildLaunchConfigRows(
  transport: string | undefined,
  lc: LaunchConfigDetail,
): Array<{ k: string; v: string; mono?: boolean }> {
  const rows: Array<{ k: string; v: string; mono?: boolean }> = []
  if (transport) rows.push({ k: 'transport', v: transport, mono: true })
  if (lc.daemonMode) rows.push({ k: 'mode', v: lc.daemonMode })
  if (lc.model) rows.push({ k: 'model', v: lc.model, mono: true })
  if (lc.daemonSettingsPath) rows.push({ k: 'settings', v: lc.daemonSettingsPath, mono: true })
  if (lc.daemonMcpConfigPath) rows.push({ k: 'mcp config', v: lc.daemonMcpConfigPath, mono: true })
  if (lc.appendSystemPrompt) rows.push({ k: 'system prompt suffix', v: lc.appendSystemPrompt })
  const envKeys = lc.env ? Object.keys(lc.env) : []
  if (envKeys.length) rows.push({ k: 'env', v: envKeys.join(', '), mono: true })
  return rows
}

export function LaunchConfigRow({ conversation }: { conversation: Conversation }) {
  const [open, setOpen] = useState(false)
  const lc = conversation.launchConfig
  const transport = conversation.transport ?? lc?.transport
  const isDaemon = transport === 'claude-daemon' || !!lc?.daemonMode
  if (!lc || !isDaemon) return null

  const rows = buildLaunchConfigRows(transport, lc)

  return (
    <div className="border border-border/60 rounded">
      <button
        type="button"
        onClick={() => {
          setOpen(o => !o)
          haptic('tap')
        }}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />
        <span className="uppercase tracking-wide">Launch config</span>
        <span className="ml-auto text-comment font-mono">
          {`${transport ?? 'daemon'}${lc.daemonMode ? ` · ${lc.daemonMode}` : ''}`}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-1.5 pt-0.5 space-y-0.5">
          {rows.map(row => (
            <div key={row.k} className="flex items-start gap-2 text-[10px]">
              <span className="text-muted-foreground/70 w-32 shrink-0">{row.k}</span>
              <span className={cn('text-foreground/90 truncate', row.mono && 'font-mono')} title={row.v}>
                {row.v}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LinkedProjects({
  conversation,
  projectSettings,
  onSetConversationTarget,
}: {
  conversation: Conversation
  projectSettings: ProjectSettings | undefined
  onSetConversationTarget: (target: ConversationTarget | null) => void
}) {
  if (!conversation.linkedProjects || conversation.linkedProjects.length === 0) return null
  return (
    <div className="flex items-center gap-2 mt-1 flex-wrap">
      <span className="text-[10px] text-teal-400/60">projects:</span>
      {conversation.linkedProjects.map(lp => (
        <span key={lp.project} className="inline-flex items-center gap-1 text-[10px] font-mono">
          <button
            type="button"
            className="text-teal-400 hover:text-teal-300 hover:underline cursor-pointer"
            onClick={() => {
              haptic('tap')
              const myName =
                projectSettings?.label ||
                projectPath(conversation.project).split('/').pop() ||
                conversation.id.slice(0, 8)
              onSetConversationTarget({
                projectA: conversation.project,
                projectB: lp.project,
                nameA: myName,
                nameB: lp.name,
              })
            }}
            title={`View conversation with ${lp.name}`}
          >
            {lp.name}
          </button>
          <button
            type="button"
            onClick={() => {
              haptic('error')
              wsSend('channel_unlink', { projectA: conversation.project, projectB: lp.project })
            }}
            className="text-red-400/40 hover:text-red-400 transition-colors"
            title={`Sever link to ${lp.name}`}
          >
            x
          </button>
        </span>
      ))}
    </div>
  )
}
