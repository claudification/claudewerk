/**
 * Write-up tab body: the LLM narrative markdown plus the A/B eval controls -- a
 * fork switcher (sibling variants of the same project+period) and a "Regenerate
 * write-up" button that opens the tunable modal (model, refinement instructions
 * + presets, variant name, sampling).
 *
 * Presentational only: the parent viewer owns the WS send, the sibling fetch,
 * and the auto-switch on fork. This component renders state + fires callbacks.
 */

import type { PeriodRecapDoc, RecapSummary } from '@shared/protocol'
import { useState } from 'react'
import { Markdown } from '@/components/markdown'
import { cn, haptic } from '@/lib/utils'
import { modelLabel } from './recap-forks'
import { RegenerateRecapModal, type RegenerateTuning } from './regenerate-recap-modal'

function isTerminalStatus(status: RecapSummary['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

/** A variant's chip label: its human name when set, else the model name. */
function variantChipLabel(v: Pick<RecapSummary, 'variantLabel' | 'model'>): string {
  return v.variantLabel || modelLabel(v.model)
}

function ForkSwitcher({
  recap,
  siblings,
  onSelectFork,
}: {
  recap: PeriodRecapDoc
  siblings: RecapSummary[]
  onSelectFork: (recapId: string) => void
}) {
  if (siblings.length <= 1) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Write-up variants">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-0.5">Variants</span>
      {siblings.map(s => {
        const active = s.id === recap.recapId
        const pending = !isTerminalStatus(s.status)
        return (
          <button
            key={s.id}
            type="button"
            disabled={active}
            title={`${s.model || 'pending'}${s.llmCostUsd > 0 ? ` - $${s.llmCostUsd.toFixed(4)}` : ''} (${s.status})`}
            onClick={() => {
              if (active) return
              haptic('tap')
              onSelectFork(s.id)
            }}
            className={cn(
              'px-2 py-0.5 text-[11px] rounded-full border transition-colors',
              active
                ? 'border-accent bg-accent/15 text-foreground cursor-default'
                : 'border-border text-muted-foreground hover:bg-muted/60 cursor-pointer',
            )}
          >
            <span className="inline-flex items-center gap-1">
              {pending && (
                <span className="inline-block size-2.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              )}
              {variantChipLabel(s)}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function RecapWriteupTab({
  recap,
  siblings,
  regenerating,
  onSelectFork,
  onRegenerate,
}: {
  recap: PeriodRecapDoc
  siblings: RecapSummary[]
  regenerating: boolean
  onSelectFork: (recapId: string) => void
  onRegenerate: (tuning: RegenerateTuning) => void
}) {
  const [modalOpen, setModalOpen] = useState(false)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-border">
        <ForkSwitcher recap={recap} siblings={siblings} onSelectFork={onSelectFork} />
        <button
          type="button"
          disabled={regenerating}
          title="Fork a tuned variant of this write-up (model, instructions, sampling)"
          onClick={() => {
            if (regenerating) return
            haptic('tap')
            setModalOpen(true)
          }}
          className={cn(
            'ml-auto px-2 py-1 text-xs rounded border border-border transition-all',
            regenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-muted/60 cursor-pointer',
          )}
        >
          {regenerating ? (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block size-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Generating…
            </span>
          ) : (
            'Regenerate write-up…'
          )}
        </button>
      </div>
      {recap.markdown ? (
        <Markdown copyable>{recap.markdown}</Markdown>
      ) : (
        <div className="text-sm text-muted-foreground">No write-up for this recap.</div>
      )}
      <RegenerateRecapModal
        open={modalOpen}
        recap={recap}
        busy={regenerating}
        onClose={() => setModalOpen(false)}
        onSubmit={tuning => {
          setModalOpen(false)
          onRegenerate(tuning)
        }}
      />
    </div>
  )
}
