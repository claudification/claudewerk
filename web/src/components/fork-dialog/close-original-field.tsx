import { formatAgeShort } from '@/lib/status-style'
import type { Conversation } from '@/lib/types'
import { hasRecentActivity, lastActivityAt } from './close-original'

/**
 * The checkbox + the reason it is in the state it is in. The hint is not
 * decoration: a pre-ticked "close the original" is a destructive default, so it
 * always says WHY it decided the conversation was abandoned.
 */
export function CloseOriginalField({
  conversation,
  checked,
  onChange,
  disabled,
}: {
  conversation: Conversation
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  const recent = hasRecentActivity(conversation)
  const last = lastActivityAt(conversation)
  const hint = recent
    ? `Active ${last ? formatAgeShort(last) : 'just now'} ago -- left running by default.`
    : last
      ? `Nothing for ${formatAgeShort(last)} -- looks abandoned, so it gets closed.`
      : 'No activity on record -- assumed abandoned, so it gets closed.'

  return (
    <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
      <input
        type="checkbox"
        aria-label="Close the original conversation"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 rounded border-input accent-accent disabled:opacity-50"
      />
      <span>
        <span className="text-foreground font-mono text-[11px]">Close the original conversation</span>
        <span className="block text-[9px] text-comment leading-snug">{hint}</span>
      </span>
    </label>
  )
}
