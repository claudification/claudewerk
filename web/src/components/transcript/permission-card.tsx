/**
 * PermissionCard -- the inline tool-permission gate, rendered where CC asked.
 *
 * One card per gate, built from up to two entries the grouping folds together
 * by `requestId`: the ASK (`permission_request`) and, once someone answers, the
 * receipt (`permission_decision`). Three states:
 *
 *  - PENDING  -> amber, with ALLOW / ALWAYS / DENY. Shown only while the broker
 *                still lists the gate as pending, which is the authority. A card
 *                whose buttons outlived the gate would send an answer nobody is
 *                waiting for.
 *  - RESOLVED -> outcome colour + who decided and how long it blocked.
 *  - UNKNOWN  -> muted. The gate predates receipts, or its decision entry sits
 *                outside the loaded window.
 *
 * An `auto` / `expired` receipt usually arrives with no ASK at all (nobody was
 * prompted), and renders standalone.
 */

import type { TranscriptPermissionDecisionEntry, TranscriptPermissionRequestEntry } from '@shared/protocol'
import { useEffect } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useInlinePermissionRegistry } from '@/lib/inline-permission-registry'
import { projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { formatPermissionInput } from '../conversation-detail/permission-input-preview'
import { BannerButton } from '../ui/conversation-banner'
import type { DisplayGroup } from './grouping'
import { cardAppearance, decisionSummary } from './permission-outcome'
import { TimeStamp } from './timestamp'

type RequestEntry = TranscriptPermissionRequestEntry
type DecisionEntry = TranscriptPermissionDecisionEntry

function splitEntries(entries: unknown[]): { request?: RequestEntry; decision?: DecisionEntry } {
  let request: RequestEntry | undefined
  let decision: DecisionEntry | undefined
  for (const e of entries as Array<RequestEntry | DecisionEntry>) {
    if (e.type === 'permission_request') request = e
    else if (e.type === 'permission_decision') decision = e
  }
  return { request, decision }
}

/** Register while mounted so the pinned banner knows this gate is covered. */
function useCoverBanner(requestId: string | undefined, active: boolean): void {
  const register = useInlinePermissionRegistry(s => s.register)
  const unregister = useInlinePermissionRegistry(s => s.unregister)
  useEffect(() => {
    if (!(requestId && active)) return
    register(requestId)
    return () => unregister(requestId)
  }, [requestId, active, register, unregister])
}

function PendingActions({
  conversationId,
  requestId,
  toolName,
}: Record<'conversationId' | 'requestId' | 'toolName', string>) {
  const respond = useConversationsStore(s => s.respondToPermission)
  const allowAlways = useConversationsStore(s => s.allowPermissionAlways)
  return (
    <div className="flex items-center gap-1.5 mt-2">
      <BannerButton
        accent="emerald"
        label="ALLOW"
        onClick={() => {
          haptic('success')
          respond(conversationId, requestId, 'allow')
        }}
      />
      <BannerButton
        accent="blue"
        label="ALWAYS"
        onClick={() => {
          haptic('double')
          allowAlways(conversationId, requestId, toolName)
        }}
      />
      <BannerButton
        accent="red"
        label="DENY"
        onClick={() => {
          haptic('error')
          respond(conversationId, requestId, 'deny')
        }}
      />
    </div>
  )
}

export function PermissionCard({ group }: { group: DisplayGroup }) {
  const { request, decision } = splitEntries(group.entries)
  const head = request ?? decision
  const requestId = head?.requestId
  // From the ENTRY, never from the panel's current selection -- see the
  // conversationId note on TranscriptPermissionRequestEntry.
  const conversationId = head?.conversationId ?? ''
  const isPending = useConversationsStore(s =>
    requestId ? s.pendingPermissions.some(p => p.requestId === requestId) : false,
  )
  const root = useConversationsStore(s => projectPath(s.conversationsById[conversationId]?.project ?? ''))
  const waiting = isPending && !decision && conversationId !== ''
  useCoverBanner(requestId, waiting)

  if (!head) return null

  const toolName = head.toolName
  const { style, label } = cardAppearance(decision?.outcome, waiting)

  return (
    <div className={cn('mb-2 px-3 py-2 rounded-md border font-mono text-[11px]', style.card)}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn('inline-block w-1.5 h-1.5 rounded-full', style.dot)} />
        <span className={cn('px-1.5 py-0.5 text-[10px] font-bold uppercase rounded border', style.chip)}>{label}</span>
        <span className="text-foreground/90 font-bold">{toolName}</span>
        <span className="flex-1" />
        <TimeStamp ts={head.timestamp} className="text-muted-foreground text-[10px]" />
      </div>

      {request?.description && <div className="text-foreground/70 text-[11px] mb-1">{request.description}</div>}
      {request?.inputPreview && formatPermissionInput(toolName, request.inputPreview, root)}

      {decision && (
        <div className="text-muted-foreground text-[10px] mt-1.5">
          {decisionSummary(decision.outcome, decision.decidedBy, decision.waitedMs)}
        </div>
      )}
      {!decision && !waiting && <div className="text-fg-muted text-[10px] mt-1.5">outcome not recorded</div>}
      {waiting && requestId && (
        <PendingActions conversationId={conversationId} requestId={requestId} toolName={toolName} />
      )}
    </div>
  )
}
