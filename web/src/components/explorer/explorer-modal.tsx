/**
 * Explorer Modal
 *
 * Full-screen overlay (mobile) / centered modal (desktop) that renders
 * the explorer layout and collects user input.
 */

import { X } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { cn, haptic } from '@/lib/utils'
import { ComponentRenderer, type ExplorerFormState } from './explorer-renderer'
import type { ExplorerComponent, ExplorerLayout, ExplorerResult } from './types'

// Initialize form state from component defaults (recursively)
function collectDefaults(components: ExplorerComponent[], values: Record<string, unknown>): void {
  for (const comp of components) {
    switch (comp.type) {
      case 'Options':
        if (comp.default !== undefined) values[comp.id] = comp.default
        break
      case 'TextInput':
        if (comp.default !== undefined) values[comp.id] = comp.default
        break
      case 'Toggle':
        values[comp.id] = comp.default ?? false
        break
      case 'Slider':
        values[comp.id] = comp.default ?? comp.min ?? 0
        break
      case 'ImagePicker':
        // No default for image picker
        break
      case 'Stack':
      case 'Grid':
      case 'Group':
        collectDefaults(comp.children, values)
        break
    }
  }
}

function getInitialValues(layout: ExplorerLayout): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  if (layout.body) {
    collectDefaults(layout.body, values)
  } else if (layout.pages) {
    for (const page of layout.pages) {
      collectDefaults(page.body, values)
    }
  }
  return values
}

// Check required fields
function collectRequired(components: ExplorerComponent[]): string[] {
  const ids: string[] = []
  for (const comp of components) {
    if ('required' in comp && comp.required && 'id' in comp) {
      ids.push(comp.id)
    }
    if ('children' in comp) {
      ids.push(...collectRequired(comp.children))
    }
  }
  return ids
}

function hasValue(val: unknown): boolean {
  if (val === undefined || val === null || val === '') return false
  if (Array.isArray(val)) return val.length > 0
  return true
}

interface ExplorerModalProps {
  layout: ExplorerLayout
  onSubmit: (result: ExplorerResult) => void
  onCancel: () => void
}

export const ExplorerModal = memo(function ExplorerModal({ layout, onSubmit, onCancel }: ExplorerModalProps) {
  const [values, setValues] = useState(() => getInitialValues(layout))
  const [activePage, setActivePage] = useState(0)

  const pages = useMemo(() => {
    if (layout.pages) return layout.pages
    if (layout.body) return [{ label: '', body: layout.body }]
    return []
  }, [layout])

  const isMultiPage = pages.length > 1
  const isLastPage = activePage >= pages.length - 1
  const currentPage = pages[activePage]

  const form: ExplorerFormState = useMemo(
    () => ({
      values,
      setValue: (id: string, value: unknown) => {
        setValues(prev => ({ ...prev, [id]: value }))
      },
    }),
    [values],
  )

  const handleSubmit = useCallback(
    (actionId = 'submit') => {
      haptic('success')
      onSubmit({
        ...values,
        _action: actionId,
        _timeout: false,
        _cancelled: false,
      })
    },
    [values, onSubmit],
  )

  const handleAction = useCallback(
    (actionId: string) => {
      handleSubmit(actionId)
    },
    [handleSubmit],
  )

  const handleCancel = useCallback(() => {
    haptic('error')
    onCancel()
  }, [onCancel])

  const handleNext = useCallback(() => {
    haptic('tap')
    if (isLastPage) {
      handleSubmit()
    } else {
      setActivePage(p => p + 1)
    }
  }, [isLastPage, handleSubmit])

  const handlePrev = useCallback(() => {
    haptic('tap')
    setActivePage(p => Math.max(0, p - 1))
  }, [])

  // Check if all required fields on current page are filled
  const allComponents = currentPage?.body || []
  const requiredIds = useMemo(() => collectRequired(allComponents), [allComponents])
  const canProceed = requiredIds.every(id => hasValue(values[id]))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleCancel} />

      {/* Modal */}
      <div
        className={cn(
          'relative flex flex-col bg-background border border-border/50 shadow-2xl',
          // Mobile: full screen with safe area. Desktop: centered modal
          'w-full h-full sm:w-[560px] sm:max-h-[85vh] sm:h-auto sm:rounded-lg',
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-4 pt-4 pb-3 border-b border-border/30 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-foreground truncate">{layout.title}</h2>
            {layout.description && (
              <div className="text-sm text-muted-foreground mt-0.5">
                <Markdown>{layout.description}</Markdown>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Page tabs (if multi-page) */}
        {isMultiPage && (
          <div className="flex gap-1 px-4 py-2 border-b border-border/20 shrink-0 overflow-x-auto">
            {pages.map((page, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  haptic('tap')
                  setActivePage(i)
                }}
                className={cn(
                  'px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap',
                  i === activePage
                    ? 'bg-primary/10 text-primary border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                )}
              >
                {page.label || `Page ${i + 1}`}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {currentPage?.body.map((component, i) => (
            <ComponentRenderer key={`${activePage}-${i}`} component={component} form={form} onAction={handleAction} />
          ))}
        </div>

        {/* Footer -- extra bottom padding for mobile (home indicator area) */}
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-5 sm:pb-3 border-t border-border/30 shrink-0">
          <Button variant="ghost" onClick={handleCancel}>
            {layout.cancelLabel || 'Cancel'}
          </Button>

          <div className="flex gap-2">
            {isMultiPage && activePage > 0 && (
              <Button variant="outline" onClick={handlePrev}>
                Back
              </Button>
            )}
            <Button onClick={handleNext} disabled={!canProceed}>
              {isLastPage ? layout.submitLabel || 'Submit' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
})
