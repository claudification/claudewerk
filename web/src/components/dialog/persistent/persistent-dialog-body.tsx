/**
 * THE DIALOGUE (D2) — renders a persistent dialog's top-level blocks, keyed by
 * STABLE block id so a patch never remounts an unchanged subtree (input value +
 * focus survive). Blocks the agent just changed get a brief highlight ring --
 * structural change is deliberately visible (anti-flicker is only for inputs).
 */
import type { DialogComponent, DialogLayout } from '@shared/dialog-schema'
import { cn } from '@/lib/utils'
import { ComponentRenderer, type DialogFormState } from '../dialog-renderer'

function topLevelBlocks(layout: DialogLayout): DialogComponent[] {
  if (layout.body) return layout.body
  if (layout.pages) return layout.pages.flatMap(p => p.body)
  return []
}

export function PersistentDialogBody({
  layout,
  form,
  highlightIds,
  onAction,
}: {
  layout: DialogLayout
  form: DialogFormState
  highlightIds: Set<string>
  onAction: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {topLevelBlocks(layout).map((block, i) => {
        const id = (block as { id?: string }).id
        const highlighted = id ? highlightIds.has(id) : false
        return (
          <div
            // Stable id keeps identity across patches; index only for id-less content blocks.
            key={id ?? `__pos_${i}`}
            className={cn(
              'rounded transition-[box-shadow,background-color] duration-500',
              highlighted && 'ring-2 ring-primary/60 bg-primary/5',
            )}
          >
            <ComponentRenderer component={block} form={form} onAction={onAction} />
          </div>
        )
      })}
    </div>
  )
}
