import { formatDurationShort } from '@/lib/status-style'
import type { Conversation } from '@/lib/types'

/**
 * "What is it doing right now" — the third column of a Pulse row.
 *
 * One short lowercase phrase, never a sentence. It is the difference between a
 * fleet list and a fleet HUD: `epic-run ceiling copy` tells you nothing,
 * `permission: rm -rf` tells you whether to get up.
 *
 * Resolution order mirrors band precedence: what BLOCKS a human wins over what
 * the agent claims, which wins over lifecycle. First hit wins.
 */

/** Attention types, in the words a human would use. */
const ATTENTION_LABEL: Record<NonNullable<Conversation['pendingAttention']>['type'], string> = {
  permission: 'permission',
  elicitation: 'wants input',
  ask: 'asked a question',
  dialog: 'dialog open',
  plan_approval: 'plan needs approval',
  spawn_approval: 'spawn needs approval',
}

/** Lifecycle fallbacks when nothing more specific is known. */
const STATUS_LABEL: Record<Conversation['status'], string> = {
  starting: 'starting',
  booting: 'booting',
  active: 'working',
  idle: 'idle',
  ended: 'ended',
}

/** First line only, collapsed and clipped — status fields are markdown blobs. */
function firstLine(text: string, max = 72): string {
  const line =
    text
      .replace(/[#*`>\r]/g, '')
      .split('\n')[0]
      ?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** `permission: rm -rf foo` — the tool is the point, the file is the detail. */
function attentionText(a: NonNullable<Conversation['pendingAttention']>): string {
  const label = ATTENTION_LABEL[a.type] ?? 'wants you'
  if (a.type === 'permission') {
    const detail = a.toolName ?? a.filePath
    return detail ? `permission: ${detail}` : 'permission'
  }
  if (a.question) return `${label}: ${firstLine(a.question, 48)}`
  return label
}

/** Ordered resolvers. First non-empty string wins. */
const RESOLVERS: Array<(c: Conversation) => string | undefined> = [
  c => (c.pendingAttention ? attentionText(c.pendingAttention) : undefined),
  c => (c.pendingSpawnApproval ? 'spawn needs approval' : undefined),
  c => (c.rateLimit ? 'rate limited' : undefined),
  c => (c.compacting ? 'compacting' : undefined),
  c => (c.liveStatus?.state === 'blocked' && c.liveStatus.blocked ? firstLine(c.liveStatus.blocked) : undefined),
  c => (c.liveStatus?.state === 'needs_you' && c.liveStatus.pending ? firstLine(c.liveStatus.pending) : undefined),
  c => (c.liveStatus?.state === 'done' && c.liveStatus.done ? firstLine(c.liveStatus.done) : undefined),
  c => (c.planMode ? 'plan mode' : undefined),
  c => (c.lastError?.errorType ? `error: ${c.lastError.errorType}` : undefined),
  c => STATUS_LABEL[c.status],
]

export function pulseActionText(c: Conversation): string {
  for (const resolve of RESOLVERS) {
    const text = resolve(c)
    if (text) return text
  }
  return ''
}

/**
 * The `#tag` axis. No epic/quest field exists on the conversation record, so the
 * tag is the most useful real thing we DO have: which branch / worktree / agent
 * this conversation belongs to. For a fleet that lives in worktrees that is the
 * grouping people actually mean.
 */
export function pulseTag(c: Conversation): string | undefined {
  return c.gitBranch ?? c.adHocWorktree ?? c.agentName ?? undefined
}

/**
 * Age readout: the shared short-duration format, plus a "now" floor — a row
 * that ticks 0s/1s/2s reads as noise on a surface you only glance at.
 */
export function pulseAge(ms: number): string {
  if (ms < 3_000) return 'now'
  return formatDurationShort(ms)
}
