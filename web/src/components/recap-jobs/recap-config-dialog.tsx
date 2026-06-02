/**
 * Recap config modal -- the single entry point for kicking off a project (or
 * cross-project) recap. Replaces the old multi-item Recap submenu + the
 * standalone custom-range dialog: pick a period preset (or a custom range,
 * folded in here) and a retrospect toggle, then fire recap_create over the same
 * WS as before. Retrospect defaults ON for periods >= 7 days; the user can flip
 * it, after which it stops auto-following the preset.
 */

import type { RecapPeriodLabel } from '@shared/protocol'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useState } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { useKeyLayer } from '@/lib/key-layers'
import { cn, haptic } from '@/lib/utils'
import { type RecapConfigOptions, recapConfigBus } from './recap-config-trigger'
import { RECAP_PRESETS, retrospectDefault } from './recap-period'
import { createRecap } from './recap-wire'

function isoLocalDay(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function dateToStartMs(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}

function dateToEndMs(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}

function scopeLabel(projectUri: string): string {
  if (projectUri === '*') return 'All projects'
  return projectUri.split('/').filter(Boolean).pop() ?? projectUri
}

export function RecapConfigDialog() {
  const [open, setOpen] = useState(false)
  const [projectUri, setProjectUri] = useState<string | null>(null)
  const [label, setLabel] = useState<RecapPeriodLabel>('last_7')
  const today = isoLocalDay(new Date())
  const [startStr, setStartStr] = useState(today)
  const [endStr, setEndStr] = useState(today)
  const [retrospect, setRetrospect] = useState(true)
  // Once the user toggles retrospect by hand, stop auto-following the preset.
  const [retrospectTouched, setRetrospectTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    recapConfigBus.setHandler((options: RecapConfigOptions) => {
      const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const now = new Date()
      setProjectUri(options.projectUri)
      setLabel('last_7')
      setStartStr(isoLocalDay(start))
      setEndStr(isoLocalDay(now))
      setRetrospect(retrospectDefault('last_7'))
      setRetrospectTouched(false)
      setError(null)
      setOpen(true)
    })
    return () => {
      recapConfigBus.setHandler(null)
    }
  }, [])

  function close() {
    setOpen(false)
    setProjectUri(null)
  }

  // Auto-follow the retrospect default as the period changes, until the user
  // overrides it manually.
  function applyPreset(next: RecapPeriodLabel) {
    setLabel(next)
    if (!retrospectTouched) setRetrospect(retrospectDefault(next, dateToStartMs(startStr), dateToEndMs(endStr)))
  }

  function onCustomStart(v: string) {
    setStartStr(v)
    if (label === 'custom' && !retrospectTouched)
      setRetrospect(retrospectDefault('custom', dateToStartMs(v), dateToEndMs(endStr)))
  }

  function onCustomEnd(v: string) {
    setEndStr(v)
    if (label === 'custom' && !retrospectTouched)
      setRetrospect(retrospectDefault('custom', dateToStartMs(startStr), dateToEndMs(v)))
  }

  function toggleRetrospect() {
    setRetrospect(v => !v)
    setRetrospectTouched(true)
  }

  function submit() {
    if (!projectUri) {
      setError('No project selected.')
      return
    }
    if (label === 'custom') {
      const startMs = dateToStartMs(startStr)
      const endMs = dateToEndMs(endStr)
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        setError('Invalid date.')
        return
      }
      if (startMs > endMs) {
        setError('Start must be on or before end.')
        return
      }
      haptic('success')
      createRecap({ projectUri, label: 'custom', start: startMs, end: endMs, retrospect })
    } else {
      haptic('success')
      createRecap({ projectUri, label, retrospect })
    }
    close()
  }

  useKeyLayer(
    {
      Enter: () => {
        if (open) submit()
      },
      Escape: () => {
        if (open) close()
      },
    },
    { enabled: open },
  )

  return (
    <DialogPrimitive.Root open={open} onOpenChange={o => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover p-4 shadow-lg">
          <DialogPrimitive.Title className="text-sm font-medium mb-1">Project recap</DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-xs text-muted-foreground mb-3">
            Generate a recap for <span className="text-foreground">{projectUri ? scopeLabel(projectUri) : ''}</span>.
          </DialogPrimitive.Description>

          <div className="space-y-3">
            <div>
              <span className="block mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Period</span>
              <div className="flex flex-wrap gap-1.5">
                {RECAP_PRESETS.map(p => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      haptic('tap')
                      applyPreset(p.label)
                    }}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-full border transition-colors',
                      label === p.label
                        ? 'border-accent bg-accent/15 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted/60',
                    )}
                  >
                    {p.display}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    haptic('tap')
                    applyPreset('custom')
                  }}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-full border transition-colors',
                    label === 'custom'
                      ? 'border-accent bg-accent/15 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  Custom…
                </button>
              </div>
            </div>

            {label === 'custom' && (
              <div className="flex gap-3">
                <label className="block text-xs flex-1">
                  <span className="block mb-1 text-muted-foreground">Start</span>
                  <input
                    type="date"
                    value={startStr}
                    max={endStr}
                    onChange={e => onCustomStart(e.target.value)}
                    className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                  />
                </label>
                <label className="block text-xs flex-1">
                  <span className="block mb-1 text-muted-foreground">End</span>
                  <input
                    type="date"
                    value={endStr}
                    min={startStr}
                    max={today}
                    onChange={e => onCustomEnd(e.target.value)}
                    className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                  />
                </label>
              </div>
            )}

            <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={retrospect}
                onChange={toggleRetrospect}
                className="mt-0.5 size-3.5 rounded border-input accent-accent"
              />
              <span>
                <span className="text-foreground">Include retrospective</span>
                <span className="block text-[11px] text-muted-foreground">
                  went well / went badly / recommendations -- on by default for a week or more
                </span>
              </span>
            </label>

            {error && <div className="text-xs text-red-400">{error}</div>}
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="px-3 py-1.5 text-xs rounded border border-border hover:bg-muted/50"
            >
              Cancel <Kbd>Esc</Kbd>
            </button>
            <button
              type="button"
              onClick={submit}
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Generate <Kbd>Enter</Kbd>
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
