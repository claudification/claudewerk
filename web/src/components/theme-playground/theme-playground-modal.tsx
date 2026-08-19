import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { LADDER_FLOOR, parseOklch } from '@/lib/theme-ladder'
import { PRESETS } from './ramp-presets'
import { ACCENT_RUNGS, RUNGS, TEXT_RUNGS } from './rung-catalog'
import { RungSlider } from './rung-slider'
import { usePlaygroundVars } from './use-playground-vars'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const SECTIONS = [
  { title: 'Surfaces', rungs: RUNGS, ladder: true },
  { title: 'Text', rungs: TEXT_RUNGS, ladder: false },
  { title: 'Accents', rungs: ACCENT_RUNGS, ladder: false },
]

/**
 * Play with the theme against the real app.
 *
 * Every edit writes to `documentElement.style`, so it repaints the WHOLE
 * window -- including this dialog. Judging a surface colour against a swatch in
 * a settings pane tells you nothing; judging it against the transcript you
 * actually read tells you everything.
 *
 * "Copy current" is the point of the whole thing: it emits a plain-text block
 * to paste back into a conversation, so a look you found by dragging sliders
 * can be promoted to the shipped default without anyone transcribing numbers.
 */
export function ThemePlaygroundModal({ open, onOpenChange }: Props) {
  const pg = usePlaygroundVars()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(pg.snapshot())
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const stepFor = (rungs: typeof RUNGS, i: number, ladder: boolean) => {
    if (!ladder || i === 0) return undefined
    const a = parseOklch(pg.vars[rungs[i - 1].token] ?? '')
    const b = parseOklch(pg.vars[rungs[i].token] ?? '')
    return a && b ? Math.abs(b.l - a.l) : undefined
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm">Theme playground</DialogTitle>
          <p className="text-fg-dim text-[10px]">
            Edits apply to the whole window immediately. Nothing here is saved to the shipped theme -- use Copy current
            and paste it back to promote a look.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
          {PRESETS.map(p => (
            <Button key={p.id} variant="outline" size="xs" title={p.note} onClick={() => pg.applyPreset(p)}>
              {p.name}
            </Button>
          ))}
        </div>

        <div className="max-h-[52vh] overflow-y-auto px-4 py-2">
          {SECTIONS.map(section => (
            <section key={section.title} className="mb-3">
              <h3 className="text-fg-faint mb-1 text-[9px] uppercase tracking-[0.11em]">{section.title}</h3>
              {section.rungs.map((rung, i) => (
                <RungSlider
                  key={rung.token}
                  rung={rung}
                  value={pg.vars[rung.token] ?? ''}
                  step={stepFor(section.rungs, i, section.ladder)}
                  floor={LADDER_FLOOR}
                  onLightness={l => pg.setLightness(rung.token, l)}
                  onChroma={c => pg.setChroma(rung.token, c)}
                />
              ))}
            </section>
          ))}

          <section className="mb-2">
            <h3 className="text-fg-faint mb-1 text-[9px] uppercase tracking-[0.11em]">Prose font</h3>
            <div className="flex items-center gap-1.5">
              {(['mono', 'sans'] as const).map(f => (
                <Button
                  key={f}
                  variant={pg.prose === f ? 'default' : 'outline'}
                  size="xs"
                  onClick={() => pg.setProse(f)}
                >
                  {f === 'mono' ? 'Mono everywhere' : 'Sans for prose'}
                </Button>
              ))}
              <span className="text-fg-faint text-[10px]">
                JetBrains Mono is bound to both --font-sans and --font-mono today.
              </span>
            </div>
          </section>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <span className={`text-[10px] tabular-nums ${pg.floorOk ? 'text-success' : 'text-destructive'}`}>
            smallest surface step Δ{pg.step.toFixed(3)} {pg.floorOk ? 'ok' : `— under the ${LADDER_FLOOR} floor`}
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button variant="ghost" size="xs" onClick={pg.reset} disabled={!pg.dirty}>
              Reset
            </Button>
            <Button variant="default" size="xs" onClick={copy}>
              {copied ? 'Copied' : 'Copy current'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
