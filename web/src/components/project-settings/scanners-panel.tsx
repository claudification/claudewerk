import type { ProjectSettings } from '@shared/protocol'
import { SCANNER_IDS, type ScannerId } from '@shared/scanner-ids'
import { type ScannerToggles, scannerLastRun } from '@shared/scanner-opt-in'
import { GroupHeader, SettingCheckbox, SettingRow } from '@/components/settings/settings-inputs'
import { formatAgo } from '@/sheaf/format'

/**
 * WHICH SCANNERS MAY SWEEP THIS PROJECT. Off by default, every one.
 *
 * Its own file rather than another ninety lines inside
 * `project-settings-editor.tsx`, which is already 580 lines against a ~150 line
 * hard stop -- `security-panel.tsx` is the sibling that set the pattern.
 *
 * The order is `SCANNER_IDS`', which is "the order a human should be offered
 * them" and is the array the ids are declared in. Iterating it rather than a
 * hand-written list here is what stops a sixth scanner from being invisible in
 * this panel until somebody notices.
 */

/** What each box actually switches on, in the words the card used. */
const ROWS: Record<ScannerId, { label: string; description: string }> = {
  refine: { label: 'Refine', description: 'Drain #needs-refine -- turn rough cards into worked specs' },
  nightshift: { label: 'Nightshift', description: 'Dispatch the nightly batch inside the configured night window' },
  'work-orders': { label: 'Work orders', description: 'Dispatch authorised cards as work orders' },
  epics: { label: 'Epics', description: 'The epic sweep -- beat every armed run and dispatch its ready cards' },
  'morning-report': { label: 'Morning report', description: 'Publish the nightly reconciliation' },
}

/**
 * "Enabled, last ran never" is the sentence this column exists to be able to
 * say. Every other unattended engine in this codebase died exactly that way
 * (nightshift: 0 runs since June; scheduled tasks: 0 ever; quests: 0 ever) and
 * nothing on any screen said so.
 *
 * It also tells a toggle whose scanner has not been built yet from one that is
 * genuinely wedged: both read "never", and only one of them is a bug -- but
 * "never" is at least a question a human can go and ask.
 */
function LastRun({ at, enabled }: { at: number | undefined; enabled: boolean }) {
  if (at === undefined) {
    return (
      <span className={enabled ? 'text-[10px] font-mono text-amber-400' : 'text-[10px] font-mono text-fg-dim'}>
        last ran never
      </span>
    )
  }
  return <span className="text-[10px] font-mono text-muted-foreground">last ran {formatAgo(Date.now() - at)}</span>
}

export function ScannersPanel({
  settings,
  toggles,
  onToggle,
}: {
  /** The SAVED settings -- where the last-run stamps live. The broker writes
   *  those; the editor never sends them back, so they are read-only here. */
  settings: ProjectSettings
  /** The editor's unsaved form state. Absent key = off. */
  toggles: ScannerToggles
  onToggle: (id: ScannerId, enabled: boolean) => void
}) {
  return (
    <>
      <GroupHeader label="Scanners" />
      <div className="text-[9px] text-muted-foreground mb-2">
        Standing sweeps that may dispatch unattended agents into this project. Every one is OFF until you tick it here,
        for every project -- an agent that switches itself on is spending money in a repo nobody opted in for.
      </div>
      {SCANNER_IDS.map(id => {
        const enabled = toggles[id] === true
        return (
          <SettingRow key={id} label={ROWS[id].label} description={ROWS[id].description}>
            <div className="flex items-center gap-2">
              <LastRun at={scannerLastRun(settings, id)} enabled={enabled} />
              <SettingCheckbox
                ariaLabel={`Enable the ${ROWS[id].label} scanner for this project`}
                checked={enabled}
                onChange={next => onToggle(id, next)}
              />
            </div>
          </SettingRow>
        )
      })}
    </>
  )
}
