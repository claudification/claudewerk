import type { ProjectSettings } from '@shared/protocol'
import { SCANNER_CONTRACTS } from '@shared/scanner-contracts'
import { SCANNER_IDS, type ScannerId } from '@shared/scanner-ids'
import { type ScannerToggles, scannerEnabled, scannerLastRun } from '@shared/scanner-opt-in'
import { GroupHeader, SettingCheckbox, SettingRow } from '@/components/settings/settings-inputs'
import { HoverCard } from '@/components/ui/hover-card'
import { formatAgo } from '@/sheaf/format'
import { ScannerContractCard } from './scanner-contract-card'

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

/**
 * The `(i)`. Opens the scanner's whole contract -- see `ScannerContractCard`.
 *
 * `openOnTap` so this works on a phone, where hover does not exist, and so the
 * panel does not vanish while somebody is reading ten refusal buckets.
 */
function ContractInfo({ id, lastRun }: { id: ScannerId; lastRun: number | undefined }) {
  const contract = SCANNER_CONTRACTS[id]
  return (
    <HoverCard openOnTap panel={() => <ScannerContractCard contract={contract} lastRun={lastRun} />} width={360}>
      <button
        type="button"
        aria-label={`What the ${contract.label} scanner does`}
        className="h-4 w-4 rounded-full border border-border text-[9px] leading-none text-muted-foreground hover:text-foreground hover:border-foreground/50"
      >
        i
      </button>
    </HoverCard>
  )
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
        // Through `scannerEnabled`, never `toggles[id]`: a project that ticked
        // this box before an id was renamed has the OLD spelling in its stored
        // map, and a raw index would render that box unticked while the scanner
        // is in fact running -- the one lie a default-deny opt-in must not tell.
        const enabled = scannerEnabled({ scanners: toggles }, id)
        const lastRun = scannerLastRun(settings, id)
        const { label, description } = SCANNER_CONTRACTS[id]
        return (
          <SettingRow key={id} label={label} description={description}>
            <div className="flex items-center gap-2">
              <LastRun at={lastRun} enabled={enabled} />
              <ContractInfo id={id} lastRun={lastRun} />
              <SettingCheckbox
                ariaLabel={`Enable the ${label} scanner for this project`}
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
