/**
 * THE DIALOGUE (D2) -- renders a persistent dialog's blocks, keyed by STABLE
 * block id so a patch never remounts an unchanged subtree (input value + focus
 * survive). Blocks the agent just changed get a brief highlight ring.
 *
 * A multi-page layout renders as TABS (pages beat scrolling): only the focused
 * page's blocks mount. Page state is owned by the parent (LiveDialogModalInner)
 * so the footer can show "Next >" on non-last pages.
 */
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { pagesWithChanges } from '../dialog-pages'
import { ComponentRenderer, type DialogFormState } from '../dialog-renderer'
import type { DialogComponent, DialogPage } from '../types'
import { PersistentDialogTabs } from './persistent-dialog-tabs'

export function PersistentDialogBody({
  pages,
  activePage,
  onSelectPage,
  form,
  highlightIds,
  onAction,
}: {
  pages: DialogPage[]
  activePage: number
  onSelectPage: (i: number) => void
  form: DialogFormState
  highlightIds: Set<string>
  onAction: (id: string) => void
}) {
  const isMultiPage = pages.length > 1
  const changed = useMemo(() => pagesWithChanges(pages, highlightIds), [pages, highlightIds])
  const blocks = pages[activePage]?.body ?? []

  return (
    <div className="flex flex-col">
      {isMultiPage && (
        <PersistentDialogTabs pages={pages} active={activePage} changed={changed} onSelect={onSelectPage} />
      )}
      <div className="flex flex-col gap-3">
        {blocks.map((block: DialogComponent, i) => {
          const id = (block as { id?: string }).id
          const highlighted = id ? highlightIds.has(id) : false
          return (
            <div
              key={id ?? `__pos_${activePage}_${i}`}
              className={cn(
                'rounded transition-[box-shadow,background-color] duration-500',
                highlighted && 'bg-primary/5 ring-2 ring-primary/60',
              )}
            >
              <ComponentRenderer component={block} form={form} onAction={onAction} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
