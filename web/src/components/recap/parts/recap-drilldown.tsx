/** Per-conversation drill-down: a navigable index of the period's work,
 *  heaviest-first. Rows are clickable in-app (open the conversation). */

import type { RecapDigest } from '@shared/protocol'
import { fmtUsd } from './recap-bits'

function Row({ c }: { c: RecapDigest['conversations'][number] }) {
  return (
    <>
      <span className="flex-1 truncate">{c.title || c.id}</span>
      <span className="tabular-nums text-[11px] text-muted-foreground">{c.turns} turns</span>
      {c.costUsd != null && <span className="tabular-nums text-[11px] text-muted-foreground">{fmtUsd(c.costUsd)}</span>}
      <span className="text-[10px] uppercase text-muted-foreground">{c.status}</span>
    </>
  )
}

export function RecapConversationDrilldown({
  conversations,
  onOpenConversation,
}: {
  conversations: RecapDigest['conversations']
  onOpenConversation?: (id: string) => void
}) {
  if (!conversations.length) return null
  return (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold">
        Conversations <span className="text-muted-foreground">{conversations.length}</span>
      </h3>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {conversations.map(c =>
          onOpenConversation ? (
            <button
              key={c.id}
              type="button"
              onClick={() => onOpenConversation(c.id)}
              className="flex items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted/30"
            >
              <Row c={c} />
            </button>
          ) : (
            <div key={c.id} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
              <Row c={c} />
            </div>
          ),
        )}
      </div>
    </div>
  )
}
