import { useCallback, useEffect, useMemo, useState } from 'react'

import { formatOklch, LADDER_FLOOR, parseOklch, smallestSurfaceStep } from '@/lib/theme-ladder'
import type { Preset } from './ramp-presets'
import { ALL_RUNGS, serializeSnapshot } from './rung-catalog'

const STORAGE_KEY = 'theme-playground'
const PROSE_ATTR = 'data-prose-font'

export type ProseFont = 'mono' | 'sans'

interface Persisted {
  vars: Record<string, string>
  prose: ProseFont
}

function read(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>
      return { vars: parsed.vars ?? {}, prose: parsed.prose === 'sans' ? 'sans' : 'mono' }
    }
  } catch {}
  return { vars: {}, prose: 'mono' }
}

/** Whatever the stylesheet resolves right now, for a token we have not overridden. */
function computed(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim()
}

/**
 * Live-edit the theme variables on the document.
 *
 * Everything writes straight to `documentElement.style`, which is the same
 * surface `applyTheme` uses -- so an edit here affects the WHOLE window
 * immediately, including surfaces the playground itself is rendered on. That
 * is the point: you judge a colour in situ, not against a swatch.
 */
export function usePlaygroundVars() {
  const [vars, setVars] = useState<Record<string, string>>(() => read().vars)
  const [prose, setProse] = useState<ProseFont>(() => read().prose)

  /* Seed from whatever the active theme resolves to, so the sliders start where
     the eye already is rather than snapping the UI on open. */
  const [baseline] = useState<Record<string, string>>(() =>
    Object.fromEntries(ALL_RUNGS.map(r => [r.token, computed(r.token)])),
  )

  const effective = useMemo(() => ({ ...baseline, ...vars }), [baseline, vars])

  useEffect(() => {
    const root = document.documentElement
    for (const [token, value] of Object.entries(vars)) root.style.setProperty(`--${token}`, value)
    root.setAttribute(PROSE_ATTR, prose)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ vars, prose }))
    } catch {}
  }, [vars, prose])

  const setLightness = useCallback((token: string, l: number) => {
    setVars(prev => {
      const current = parseOklch(prev[token] ?? computed(token))
      if (!current) return prev
      return { ...prev, [token]: formatOklch({ ...current, l }) }
    })
  }, [])

  const setChroma = useCallback((token: string, c: number) => {
    setVars(prev => {
      const current = parseOklch(prev[token] ?? computed(token))
      if (!current) return prev
      return { ...prev, [token]: formatOklch({ ...current, c }) }
    })
  }, [])

  const setHue = useCallback((token: string, h: number) => {
    setVars(prev => {
      const current = parseOklch(prev[token] ?? computed(token))
      if (!current) return prev
      return { ...prev, [token]: formatOklch({ ...current, h }) }
    })
  }, [])

  const applyPreset = useCallback((preset: Preset) => setVars({ ...preset.vars }), [])

  const reset = useCallback(() => {
    const root = document.documentElement
    for (const token of Object.keys(vars)) root.style.removeProperty(`--${token}`)
    setVars({})
  }, [vars])

  const snapshot = useCallback(() => serializeSnapshot(effective, prose), [effective, prose])

  /* The floor, live. Drag the page past a panel and this goes red before you
     have to squint at it to notice. */
  const step = smallestSurfaceStep(effective)

  return {
    vars: effective,
    dirty: Object.keys(vars).length > 0,
    prose,
    setProse,
    setLightness,
    setChroma,
    setHue,
    applyPreset,
    reset,
    snapshot,
    step,
    floorOk: step >= LADDER_FLOOR,
  }
}
