/**
 * Structured recap report (Recap 2.0). Renders the persisted frontmatter
 * (metadata) + digest as a scorecard, charts, typed cited cards, and a
 * conversation drill-down. Shared by the in-app viewer and the public share
 * page. Degrades to the markdown body when structured data is absent (pre-2.0).
 */

import type { RecapCostLedger, RecapDigest, RecapMetadata } from '@shared/protocol'
import { Markdown } from '@/components/markdown'
import { RecapAnalytics } from './parts/recap-analytics'
import { RecapConversationDrilldown } from './parts/recap-drilldown'
import { RecapEngineCost } from './parts/recap-engine-cost'
import { RecapProjectMetrics } from './parts/recap-project-metrics'
import { RecapScorecard } from './parts/recap-scorecard'
import { RecapSections } from './parts/recap-sections'

interface RecapReportProps {
  metadata?: RecapMetadata
  digest?: RecapDigest
  markdown?: string
  /** Pillar E COST 2 -- engine-cost ledger. In-app only (internal ops data);
   *  the public share omits it. */
  costLedger?: RecapCostLedger
  /** Provided in-app (opens the conversation); absent on the public share. */
  onOpenConversation?: (id: string) => void
  /** When true, omit the embedded "Full write-up" <details> -- the in-app viewer
   *  surfaces the write-up as its own tab instead. The public share leaves it
   *  inline (no tab chrome there). */
  hideWriteup?: boolean
}

/** Pull the `## TL;DR` block out of the markdown body so it stays visible even
 *  when the full narrative is collapsed. */
function extractTldr(md: string): string | null {
  const m = md.match(/^##\s+TL;?DR\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/im)
  return m ? m[1].trim() : null
}

export function RecapReport({
  metadata,
  digest,
  markdown,
  costLedger,
  onOpenConversation,
  hideWriteup = false,
}: RecapReportProps) {
  // Pre-2.0 recaps (no structured data) degrade to the markdown body verbatim.
  if (!metadata && !digest) {
    return markdown ? <Markdown copyable>{markdown}</Markdown> : null
  }

  const tldr = markdown ? extractTldr(markdown) : null
  return (
    <div className="flex flex-col gap-5">
      <RecapScorecard metadata={metadata} digest={digest} />
      {tldr && (
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">TL;DR</div>
          <Markdown>{tldr}</Markdown>
        </div>
      )}
      <RecapAnalytics digest={digest} />
      <RecapProjectMetrics digest={digest} />
      {metadata && <RecapSections metadata={metadata} onOpenConversation={onOpenConversation} />}
      {digest && (
        <RecapConversationDrilldown conversations={digest.conversations} onOpenConversation={onOpenConversation} />
      )}
      <RecapEngineCost ledger={costLedger} />
      {markdown && !hideWriteup && (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-muted-foreground">
            Full write-up &amp; timeline
          </summary>
          <div className="border-t border-border px-3 py-2">
            <Markdown copyable>{markdown}</Markdown>
          </div>
        </details>
      )}
    </div>
  )
}
