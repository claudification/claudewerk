/** PULSE settings -- the fleet surface grouped by activity.
 *
 *  The strip is OFF by default on purpose: it permanently spends ~30px of
 *  vertical space and an always-visible attention dot goes numb fast. The
 *  palette (chord `mod+k p`) costs nothing when closed, so it needs no toggle. */

import { SettingCheckbox } from './settings-inputs'
import { SELECT_CLS, type SettingItem } from './settings-item'

export const PULSE_ITEMS: SettingItem[] = [
  {
    tab: 'display',
    group: 'Pulse',
    label: 'Always-on fleet strip',
    description:
      'Pin a 30px bar under the app: band counts plus the single most urgent conversation. Hover or hold Alt to bloom; never takes focus.',
    keywords: 'pulse strip fleet hud attention bar always on',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.pulseStrip}
        onChange={v => ctx.updatePrefs({ pulseStrip: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Pulse',
    label: 'Default view',
    description: 'Bands group by activity (best for triage). Tide is one time axis (best for reading what happened).',
    keywords: 'pulse view bands tide timeline activity',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={ctx.prefs.pulseView}
        onChange={e => ctx.updatePrefs({ pulseView: e.target.value as 'bands' | 'tide' })}
        className={SELECT_CLS}
      >
        <option value="bands">Bands (default)</option>
        <option value="tide">Tide</option>
      </select>
    ),
  },
]
