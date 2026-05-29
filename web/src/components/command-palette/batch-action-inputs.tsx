import type { SentinelStatusInfo } from '@/hooks/use-conversations'

/** Per-action input panel for the "broadcast" action -- a multi-line
 *  textarea whose value becomes the broadcast message sent to all
 *  selected conversations. */
export function BatchBroadcastInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <textarea
      aria-label="Broadcast message text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="Message to broadcast to all selected conversations..."
      rows={3}
      className="w-full bg-muted/20 px-2 py-1 border border-border/40 outline-none focus:border-accent text-xs font-mono"
    />
  )
}

/** Per-action input panel for the "reassign" action -- three fields:
 *  target projectUri, target sentinel, target profile. Each field is
 *  optional; blank means "leave unchanged" and the magic `__clear__`
 *  token means "reset to default". */
export function BatchReassignInputs({
  project,
  sentinel,
  profile,
  sentinels,
  onProjectChange,
  onSentinelChange,
  onProfileChange,
}: {
  project: string
  sentinel: string
  profile: string
  sentinels: SentinelStatusInfo[]
  onProjectChange: (next: string) => void
  onSentinelChange: (next: string) => void
  onProfileChange: (next: string) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-2 text-xs">
      <input
        aria-label="Target project URI"
        placeholder="target projectUri (optional)"
        value={project}
        onChange={e => onProjectChange(e.target.value)}
        className="bg-muted/20 px-2 py-1 border border-border/40 outline-none focus:border-accent"
      />
      <select
        aria-label="Target sentinel"
        value={sentinel}
        onChange={e => onSentinelChange(e.target.value)}
        className="bg-muted/20 px-2 py-1 border border-border/40"
      >
        <option value="">leave sentinel unchanged</option>
        <option value="__clear__">clear sentinel (use default)</option>
        {sentinels.map(s => (
          <option key={s.sentinelId} value={s.sentinelId}>
            {s.alias} ({s.sentinelId.slice(0, 8)})
          </option>
        ))}
      </select>
      <input
        aria-label="Target profile"
        placeholder="target profile (blank=unchanged, __clear__=default)"
        value={profile}
        onChange={e => onProfileChange(e.target.value)}
        className="bg-muted/20 px-2 py-1 border border-border/40 outline-none focus:border-accent"
      />
    </div>
  )
}
