/** Headless / PTY transport pills. Shared by the revive and fork tabs so both
 *  paths offer the same choice with the same H/P shortcuts. */

import { TogglePill } from '@/components/ui/toggle-pill'
import { haptic } from '@/lib/utils'

export function ModeToggle({ headless, onChange }: { headless: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">Mode</div>
      <div className="flex gap-2">
        <TogglePill
          active={headless}
          onClick={() => {
            onChange(true)
            haptic('tap')
          }}
          label="Headless"
          shortcut="H"
        />
        <TogglePill
          active={!headless}
          onClick={() => {
            onChange(false)
            haptic('tap')
          }}
          label="PTY"
          shortcut="P"
        />
      </div>
    </div>
  )
}
