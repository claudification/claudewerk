import type { ReactNode } from 'react'
import { Markdown } from '@/components/markdown'
import { BannerButton, ConversationBanner } from '@/components/ui/conversation-banner'
import type { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'

// Element types derived from the store's own state -- single source of truth,
// so these rows never drift from the shapes the panel actually holds.
type StoreState = ReturnType<typeof useConversationsStore.getState>
export type PermissionItem = StoreState['pendingPermissions'][number]
export type LinkItem = StoreState['pendingProjectLinks'][number]
export type AskItem = StoreState['pendingAskQuestions'][number]
export type NotifItem = StoreState['notifications'][number]

type Navigate = (conversationId: string) => void
type RespondPerm = StoreState['respondToPermission']
type SendRule = StoreState['sendPermissionRule']
type RespondLink = StoreState['respondToProjectLink']
type DismissNotif = StoreState['dismissNotification']

export function PermissionRow({
  item,
  respondPerm,
  sendRule,
}: {
  item: PermissionItem
  respondPerm: RespondPerm
  sendRule: SendRule
}) {
  return (
    <ConversationBanner
      accent="amber"
      label="PERMISSION"
      title={<span className="font-bold">{item.toolName}</span>}
      actions={
        <>
          <BannerButton
            accent="emerald"
            label="ALLOW"
            size="sm"
            onClick={() => {
              haptic('success')
              respondPerm(item.conversationId, item.requestId, 'allow')
            }}
          />
          <BannerButton
            accent="blue"
            label="ALWAYS"
            size="sm"
            onClick={() => {
              haptic('double')
              respondPerm(item.conversationId, item.requestId, 'allow')
              sendRule(item.conversationId, item.toolName, 'allow')
            }}
          />
          <BannerButton
            accent="red"
            label="DENY"
            size="sm"
            onClick={() => {
              haptic('error')
              respondPerm(item.conversationId, item.requestId, 'deny')
            }}
          />
        </>
      }
    >
      {item.description && <div className="text-foreground/70 text-[11px]">{item.description}</div>}
      {item.inputPreview && <PermissionPreview toolName={item.toolName} input={item.inputPreview} />}
    </ConversationBanner>
  )
}

export function PlanApprovalRow({ conversationId, navigate }: { conversationId: string; navigate: Navigate }) {
  return (
    <ConversationBanner accent="blue" label="PLAN APPROVAL">
      <div className="text-foreground/70 text-[11px] line-clamp-3">Plan ready for review</div>
      <div className="flex items-center gap-2 mt-0.5">
        <BannerButton
          accent="emerald"
          label="VIEW"
          size="sm"
          onClick={() => {
            haptic('tap')
            navigate(conversationId)
          }}
        />
      </div>
    </ConversationBanner>
  )
}

export function AskRow({ item, navigate }: { item: AskItem; navigate: Navigate }) {
  return (
    <ConversationBanner accent="violet" label="QUESTION">
      <div className="text-foreground/70 text-[11px] line-clamp-2">
        {item.questions[0]?.question || 'Waiting for input'}
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <BannerButton
          accent="violet"
          label="ANSWER"
          size="sm"
          onClick={() => {
            haptic('tap')
            navigate(item.conversationId)
          }}
        />
      </div>
    </ConversationBanner>
  )
}

export function LinkRow({ item, respondLink }: { item: LinkItem; respondLink: RespondLink }) {
  return (
    <ConversationBanner
      accent="teal"
      label="LINK"
      layout="row"
      title={
        <>
          <span className="text-teal-300">{item.fromProject}</span>
          {' -> '}
          <span className="text-teal-300">{item.toProject}</span>
        </>
      }
      actions={
        <>
          <BannerButton
            accent="emerald"
            label="ALLOW"
            size="sm"
            onClick={() => {
              haptic('success')
              respondLink(item.fromConversation, item.toConversation, 'approve')
            }}
          />
          <BannerButton
            accent="red"
            label="BLOCK"
            size="sm"
            onClick={() => {
              haptic('error')
              respondLink(item.fromConversation, item.toConversation, 'block')
            }}
          />
        </>
      }
    />
  )
}

/**
 * A plain NOTIFY row. The whole card navigates to the owning conversation;
 * only the X dismisses. role="button" div (not <button>) since it wraps the
 * X <button>, and the body renders as markdown.
 */
export function NotifyRow({
  item,
  navigate,
  dismissNotif,
}: {
  item: NotifItem
  navigate: Navigate
  dismissNotif: DismissNotif
}) {
  return (
    // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
    <div
      role="button"
      tabIndex={0}
      className="cursor-pointer"
      onClick={() => navigate(item.conversationId)}
      onKeyDown={e => {
        if (e.key === 'Enter') navigate(item.conversationId)
      }}
    >
      <ConversationBanner
        accent="muted"
        label="NOTIFY"
        meta={formatTime(item.timestamp)}
        actions={
          <BannerButton
            accent="muted"
            label="X"
            size="sm"
            onClick={e => {
              e.stopPropagation()
              haptic('tick')
              dismissNotif(item.id)
            }}
          />
        }
      >
        <div className="text-foreground/70">
          <Markdown>{item.message}</Markdown>
        </div>
      </ConversationBanner>
    </div>
  )
}

// Per-tool preview of the pending permission's input. Strategy map over the
// tool name (Write/Edit/Read share the file-path preview) instead of an
// if-chain; the map returns null when the tool has nothing worth showing.
const filePathPreview = (p: { file_path?: string }) =>
  p.file_path ? <div className="text-amber-300 text-[10px] truncate">{p.file_path}</div> : null

const PREVIEWERS: Record<string, (parsed: Record<string, unknown>) => ReactNode> = {
  Write: filePathPreview,
  Edit: filePathPreview,
  Read: filePathPreview,
  Bash: p => {
    const cmd = (p.command || p.cmd) as string | undefined
    return cmd ? (
      <pre className="text-cyan-400 text-[10px] bg-background/50 px-1.5 py-0.5 rounded whitespace-pre-wrap line-clamp-2">
        {cmd.slice(0, 200)}
      </pre>
    ) : null
  },
}

function PermissionPreview({ toolName, input }: { toolName: string; input: string }) {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(input)
  } catch {
    // not JSON -- fall through to the raw preview
  }
  const preview = parsed ? PREVIEWERS[toolName]?.(parsed) : null
  if (preview) return preview
  return input.length > 0 ? (
    <pre className="text-muted-foreground text-[9px] bg-background/50 px-1.5 py-0.5 rounded whitespace-pre-wrap line-clamp-2">
      {input.slice(0, 150)}
    </pre>
  ) : null
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
