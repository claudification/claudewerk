import type { PulseAttentionFlags } from '@/lib/pulse/bands'
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

/**
 * Ordered resolvers. First non-empty string wins.
 *
 * The store flags come FIRST and deliberately duplicate what `pendingAttention`
 * would say. They are the second path that survives the umbrella being wrong --
 * a row in the blocked band whose action text read "working" would be worse than
 * useless.
 */
const RESOLVERS: Array<(c: Conversation, f: PulseAttentionFlags) => string | undefined> = [
  (_, f) => (f.hasPendingPermission ? 'permission' : undefined),
  (_, f) => (f.hasOpenDialog ? 'dialog open' : undefined),
  (_, f) => (f.hasPendingAsk ? 'asked a question' : undefined),
  (_, f) => (f.hasPendingLink ? 'link needs approval' : undefined),
  c => (c.pendingAttention ? attentionText(c.pendingAttention) : undefined),
  c => (c.pendingSpawnApproval ? 'spawn needs approval' : undefined),
  c => (c.rateLimit ? 'rate limited' : undefined),
  c => (c.compacting ? 'compacting' : undefined),
  c => (c.liveStatus?.state === 'blocked' && c.liveStatus.blocked ? firstLine(c.liveStatus.blocked) : undefined),
  c => (c.liveStatus?.state === 'needs_you' && c.liveStatus.pending ? firstLine(c.liveStatus.pending) : undefined),
  c => (c.liveStatus?.state === 'done' && c.liveStatus.done ? firstLine(c.liveStatus.done) : undefined),
  c => (c.planMode ? 'plan mode' : undefined),
  c => (c.lastError?.errorType ? `error: ${c.lastError.errorType}` : undefined),
  // CC's per-turn classification -- the machine-derived answer. It sits BELOW
  // every authored or blocking signal above (those are deliberate; this is
  // automatic) and ABOVE the lifecycle word, because "wiring swipe into app
  // shell" is the whole point and "working" tells you nothing.
  //
  // ACTIVE only, deliberately: the label describes the last turn, so on an idle
  // or ended row it would assert work that stopped happening. The lifecycle word
  // is the honest answer there.
  c => (c.status === 'active' && c.turnSummary?.detail ? firstLine(c.turnSummary.detail, 48) : undefined),
  c => STATUS_LABEL[c.status],
]

export function pulseActionText(c: Conversation, flags: PulseAttentionFlags = {}): string {
  for (const resolve of RESOLVERS) {
    const text = resolve(c, flags)
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
