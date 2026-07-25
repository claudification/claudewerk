/**
 * Plain Renderer Lab -- the Experiments settings tab (shown only while the
 * plain renderer is active). Live A/B knobs for the plain transcript's
 * SCROLL-BACK anchoring (lib/plain-renderer-lab.ts). The defaults ARE the
 * shipped answer; these knobs step back to the older behaviors so we can prove
 * which mechanism is doing the work. Every change applies immediately (prefs
 * are live zustand state -- the renderer re-reads them on the next commit).
 */

import { resolveAnchorStrategy } from '@/components/transcript/plain/anchor-strategy'
import { useConversationsStore } from '@/hooks/use-conversations'
import { DEFAULT_PLAIN_RENDERER_LAB, plainLabSummary, resolvePlainRendererLab } from '@/lib/plain-renderer-lab'
import { LabKnobRows, LabResetHeader } from './lab-knobs-ui'
import { KNOBS } from './plain-renderer-lab-knobs'

export function PlainRendererLabSection() {
  const stored = useConversationsStore(s => s.controlPanelPrefs.plainRendererLab)
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)
  const lab = resolvePlainRendererLab(stored)
  const anchor = resolveAnchorStrategy(lab.anchorMode)

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-muted-foreground leading-relaxed">
        Live experiment knobs for the plain renderer's scroll-back anchoring. Stick-to-bottom is settled; this is the
        load-older / height-inflation path. Defaults = accurate per-group heights + the browser's own scroll anchoring.
        Change one knob at a time and watch the <span className="font-mono">[window]</span> console lines.
      </div>
      <LabResetHeader summary={plainLabSummary(lab)} onReset={() => updatePrefs({ plainRendererLab: {} })} />
      <div className="text-[10px] font-mono text-muted-foreground">
        this device: anchoring resolves to <span className="text-foreground">{anchor.resolved}</span>
        {lab.anchorMode === 'auto' &&
          (anchor.resolved === 'native'
            ? ' (engine implements CSS scroll anchoring)'
            : ' (no CSS scroll anchoring -- Safari 26 and older)')}
      </div>
      <LabKnobRows
        knobs={KNOBS}
        values={lab}
        defaults={DEFAULT_PLAIN_RENDERER_LAB}
        onChange={(key, value) => updatePrefs({ plainRendererLab: { ...stored, [key]: value } })}
      />
    </div>
  )
}
