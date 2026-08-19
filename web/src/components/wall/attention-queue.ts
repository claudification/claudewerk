/**
 * THE FOLD behind A1: every open question in the fleet, in one sorted queue.
 *
 * SIX PROTOCOLS, ONE LIST. Permissions, asks, dialogs, plan approvals, channel
 * links and spawn approvals each arrive on their own wire message and land in
 * their own store slice. This file is the only place that knows that, and it is
 * PURE -- stores and clocks are handed in, so the whole queue is testable
 * without a websocket, a timer or a DOM.
 *
 * THE SECOND PATH IS KEPT. `hardBlockOf` also reports a block the card's
 * `pendingAttention` umbrella claims but no store slice can detail (the
 * `elicitation` type has no slice at all, and on 2026-08-19 a broker bug cleared
 * the umbrella out from under an open dialog). Those become `stuck` rows: listed,
 * counted, waiting-clock running, with no buttons and a line saying where to
 * answer. A block we cannot answer in place still has to be VISIBLE -- silence
 * is the exact failure this pane exists to end.
 *
 * WHAT IS ANSWERABLE IN PLACE is not re-decided here: `dialog-answerable.ts`
 * already draws that line for the voice orb (one single-select list, no wizards,
 * no forms) and this pane obeys the same call. Plan approvals are the one
 * deliberate divergence -- voice bars them because nothing SPOKEN should exit
 * plan mode, and a deliberate click is not that.
 */

import { projectIdentityKey } from '@shared/project-uri'
import type { useConversationsStore } from '@/hooks/use-conversations'
import { pulseActionText, pulseTag } from '@/lib/pulse/action-text'
import { bandOf, hardBlockOf, isAttentionBand, type PulseAttentionFlags } from '@/lib/pulse/bands'
import type { Conversation, ProjectSettings } from '@/lib/types'
import { projectDisplayName } from '@/lib/utils'
import { type AnswerableDialog, askAnswerable, dialogAnswerable } from '@/lib/voice-orb/dialog-answerable'
import { type AttentionAnswers, type AttentionEntry, compareAttention } from './attention-entries'

type StoreState = ReturnType<typeof useConversationsStore.getState>

/** Exactly the store slices this fold reads -- named off the store itself so a
 *  shape change over there breaks HERE, at compile time. */
export interface AttentionSources {
  permissions: StoreState['pendingPermissions']
  links: StoreState['pendingProjectLinks']
  asks: StoreState['pendingAskQuestions']
  dialogs: StoreState['pendingDialogs']
  conversations: readonly Conversation[]
  projectSettings: Record<string, ProjectSettings>
  flagsFor: (conversationId: string) => PulseAttentionFlags
  answers: AttentionAnswers
  now: number
}

/** Who is asking -- the fields every entry carries whatever its protocol is. */
type Who = Pick<AttentionEntry, 'project' | 'projectIcon' | 'projectColor' | 'title' | 'tag' | 'host' | 'model'>

function whoIs(c: Conversation | undefined, settings: Record<string, ProjectSettings>, id: string): Who {
  if (!c) return { project: '', title: id.slice(0, 8) }
  const ps = settings[projectIdentityKey(c.project)]
  return {
    project: projectDisplayName(c.project, ps?.label),
    projectIcon: ps?.icon,
    projectColor: ps?.color,
    title: c.title || c.name || c.summary || c.id.slice(0, 8),
    tag: pulseTag(c),
    host: c.hostSentinelAlias ?? c.hostSentinelId,
    model: c.model,
  }
}

/** A pick-one question (native ask or one-shot dialog) as buttons. */
function optionActions(d: AnswerableDialog, answers: AttentionAnswers): AttentionEntry['actions'] {
  return d.options.map((o, i) => ({
    id: `opt:${o.value}:${i}`,
    label: o.label,
    tone: i === 0 ? ('go' as const) : ('alt' as const),
    run: () =>
      d.kind === 'ask'
        ? answers.respondToAskQuestion(d.conversationId, d.key, { [d.fieldId]: o.label })
        : answers.submitDialog(d.conversationId, d.key, {
            [d.fieldId]: o.value,
            _action: 'submit',
            _timeout: false,
            _cancelled: false,
          }),
  }))
}

function permissionRows(src: AttentionSources, who: (id: string) => Who): AttentionEntry[] {
  return src.permissions.map(p => ({
    key: `perm:${p.requestId}`,
    tier: 'hard' as const,
    band: 'blocked' as const,
    kind: 'permission' as const,
    conversationId: p.conversationId,
    ...who(p.conversationId),
    question: `permission: ${p.toolName}`,
    detail: p.inputPreview || p.description || undefined,
    since: p.timestamp,
    actions: [
      {
        id: 'allow',
        label: 'ALLOW',
        tone: 'go' as const,
        run: () => src.answers.respondToPermission(p.conversationId, p.requestId, 'allow'),
      },
      {
        id: 'always',
        label: 'ALWAYS',
        tone: 'alt' as const,
        run: () => src.answers.allowPermissionAlways(p.conversationId, p.requestId, p.toolName),
      },
      {
        id: 'deny',
        label: 'DENY',
        tone: 'stop' as const,
        run: () => src.answers.respondToPermission(p.conversationId, p.requestId, 'deny'),
      },
    ],
  }))
}

function askRows(src: AttentionSources, who: (id: string) => Who): AttentionEntry[] {
  return src.asks.map(a => {
    const answerable = askAnswerable(a)
    return {
      key: `ask:${a.toolUseId}`,
      tier: 'hard' as const,
      band: 'blocked' as const,
      kind: 'ask' as const,
      conversationId: a.conversationId,
      ...who(a.conversationId),
      question: answerable?.question ?? a.questions[0]?.question ?? 'asked a question',
      detail: answerable ? undefined : a.questions.map(q => q.question).join(' · '),
      since: a.timestamp,
      hint: answerable ? undefined : 'more than one answer -- open the conversation',
      actions: answerable ? optionActions(answerable, src.answers) : [],
    }
  })
}

function planActions(src: AttentionSources, conversationId: string, dialogId: string): AttentionEntry['actions'] {
  const send = (action: 'submit' | 'reject') =>
    src.answers.submitDialog(conversationId, dialogId, { _action: action, _timeout: false, _cancelled: false })
  return [
    { id: 'approve', label: 'APPROVE & RUN', tone: 'go', run: () => send('submit') },
    { id: 'reject', label: 'CHANGES', tone: 'stop', run: () => send('reject') },
  ]
}

// Cognitive 18 vs a threshold of 15, ruled DEFER at the merge (overseer, gen 17):
// this is one of the six protocol folds and splitting it mid-fan-out would put a
// second writer in a file three pane cards still branch from. The fix is owned by
// `wall-integration-fallow-debt`, which runs after the panes drain -- delete this
// suppression there, do not renew it.
// fallow-ignore-next-line complexity
function dialogRows(src: AttentionSources, who: (id: string) => Who): AttentionEntry[] {
  const rows: AttentionEntry[] = []
  for (const [conversationId, d] of Object.entries(src.dialogs)) {
    // An EXPIRED dialog blocks nobody -- the agent moved on and it renders as a
    // re-displayable pill elsewhere. Holding it here would keep a dead question
    // at the top of the queue forever.
    if (d.expired) continue
    const plan = d.source === 'plan_approval'
    const answerable = plan ? null : dialogAnswerable({ conversationId, ...d })
    const actions = plan ? planActions(src, conversationId, d.dialogId) : []
    if (answerable) actions.push(...optionActions(answerable, src.answers))
    rows.push({
      key: `dialog:${d.dialogId}`,
      tier: 'hard',
      band: 'blocked',
      kind: plan ? 'plan' : 'dialog',
      conversationId,
      ...who(conversationId),
      question: plan ? 'plan needs approval' : (answerable?.question ?? d.layout.title),
      detail: plan ? d.layout.title : undefined,
      since: d.timestamp,
      hint: actions.length === 0 ? 'this one needs the full dialog -- open the conversation' : undefined,
      actions,
    })
  }
  return rows
}

function linkRows(src: AttentionSources, who: (id: string) => Who): AttentionEntry[] {
  return src.links.map(l => {
    const c = src.conversations.find(x => x.id === l.toConversation)
    return {
      key: `link:${l.fromConversation}:${l.toConversation}`,
      tier: 'hard' as const,
      band: 'blocked' as const,
      kind: 'link' as const,
      conversationId: l.toConversation,
      ...who(l.toConversation),
      question: `link: ${l.fromProject} -> ${l.toProject}`,
      // No timestamp rides the link request, so the clock starts from the last
      // thing that conversation did rather than pretending it just arrived.
      since: c?.lastActivity ?? src.now,
      actions: [
        {
          id: 'allow',
          label: 'ALLOW',
          tone: 'go' as const,
          run: () => src.answers.respondToProjectLink(l.fromConversation, l.toConversation, 'approve'),
        },
        {
          id: 'block',
          label: 'BLOCK',
          tone: 'stop' as const,
          run: () => src.answers.respondToProjectLink(l.fromConversation, l.toConversation, 'block'),
        },
      ],
    }
  })
}

function spawnRows(src: AttentionSources, who: (id: string) => Who): AttentionEntry[] {
  const rows: AttentionEntry[] = []
  for (const c of src.conversations) {
    const spawn = c.pendingSpawnApproval
    if (!spawn) continue
    rows.push({
      key: `spawn:${spawn.requestId}`,
      tier: 'hard',
      band: 'blocked',
      kind: 'spawn',
      conversationId: c.id,
      ...who(c.id),
      question: 'spawn needs approval',
      detail: spawn.reason,
      since: spawn.requestedAt,
      actions: [
        {
          id: 'allow',
          label: 'ALLOW',
          tone: 'go',
          run: () => src.answers.respondToSpawnApproval(c.id, spawn.requestId, 'allow', false),
        },
        {
          id: 'deny',
          label: 'DENY',
          tone: 'stop',
          run: () => src.answers.respondToSpawnApproval(c.id, spawn.requestId, 'deny', false),
        },
      ],
    })
  }
  return rows
}

/**
 * The rows the conversation records themselves produce: a hard block with no
 * answerable slice behind it (`stuck`), and the soft self-reports (`needs`).
 *
 * `detailed` carries the conversations a slice already spoke for, so a
 * permission never renders twice -- once from its slice and once from the
 * umbrella that describes the same gate.
 */
// Same ruling as `dialogRows` above: cognitive 16, deferred to
// `wall-integration-fallow-debt`, not permanent.
// fallow-ignore-next-line complexity
function conversationRows(src: AttentionSources, who: (id: string) => Who, detailed: Set<string>): AttentionEntry[] {
  const rows: AttentionEntry[] = []
  for (const c of src.conversations) {
    const flags = src.flagsFor(c.id)
    const band = bandOf(c, flags, src.now)
    if (!isAttentionBand(band)) continue
    if (detailed.has(c.id)) continue
    const blocked = band === 'blocked'
    rows.push({
      key: `conv:${c.id}`,
      tier: blocked ? 'hard' : 'soft',
      band,
      kind: blocked ? 'stuck' : 'needs',
      conversationId: c.id,
      ...who(c.id),
      question: pulseActionText(c, flags) || (blocked ? (hardBlockOf(c, flags) ?? 'blocked') : 'needs you'),
      since: c.liveStatus?.updatedAt ?? c.pendingAttention?.timestamp ?? c.lastActivity,
      hint: blocked ? 'no answer path on this surface -- open the conversation' : undefined,
      actions: [],
    })
  }
  return rows
}

/** Every open question in the fleet, hard first, oldest first. */
export function buildAttentionQueue(src: AttentionSources): AttentionEntry[] {
  const byId = new Map(src.conversations.map(c => [c.id, c]))
  const who = (id: string) => whoIs(byId.get(id), src.projectSettings, id)

  const detailed = [
    ...permissionRows(src, who),
    ...askRows(src, who),
    ...dialogRows(src, who),
    ...linkRows(src, who),
    ...spawnRows(src, who),
  ]
  const spokenFor = new Set(detailed.map(r => r.conversationId))
  return [...detailed, ...conversationRows(src, who, spokenFor)].sort(compareAttention)
}
