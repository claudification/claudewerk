import type { ScannerContract } from '@shared/scanner-contracts'
import { formatAgo } from '@/sheaf/format'

/**
 * THE FULL CONTRACT FOR ONE SCANNER, behind the `(i)` on its opt-in row.
 *
 * A checkbox that arms an unattended agent has to be able to answer five
 * questions before somebody ticks it: what it selects, what it skips and why,
 * what it dispatches, what that costs, and how often it runs. The row's one-line
 * description answers none of them -- "Dispatch an authorised card as a work
 * order" does not say that it spends an implementer seat.
 *
 * EVERY VALUE COMES OFF `SCANNER_CONTRACTS`, which the broker's own `Scanner`
 * records also read. Nothing here is prose about a scanner; it is the scanner's
 * declaration, rendered.
 */

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <div className="w-[68px] shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground pt-px">{label}</div>
      <div className="min-w-0 flex-1 text-[10px] text-foreground/90 space-y-0.5">{children}</div>
    </div>
  )
}

/**
 * The cadence line, and the one place this panel is allowed to say nothing.
 *
 * A scanner with no caller renders as having no caller. Two of them are built,
 * tested and invoked by nothing at all, and inventing an interval for them would
 * turn the single most useful sentence on this screen -- "enabled, last ran
 * never" -- into a puzzle instead of an alarm.
 */
function Cadence({ contract, lastRun }: { contract: ScannerContract; lastRun: number | undefined }) {
  const ran = lastRun === undefined ? 'last ran never' : `last ran ${formatAgo(Date.now() - lastRun)}`
  if (!contract.built) {
    return (
      <Fact label="Cadence">
        <div className="text-amber-400">not built yet -- nothing behind this box</div>
        <div className="text-muted-foreground">{ran}</div>
      </Fact>
    )
  }
  return (
    <Fact label="Cadence">
      {contract.cadence === undefined ? (
        <div className="text-amber-400">no caller yet -- never scheduled</div>
      ) : (
        <div>{contract.cadence}</div>
      )}
      <div className="text-muted-foreground">{ran}</div>
    </Fact>
  )
}

export function ScannerContractCard({
  contract,
  lastRun,
}: {
  contract: ScannerContract
  /** The SAVED stamp, or `undefined` for a scanner that has never run. */
  lastRun: number | undefined
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="text-[11px] font-medium text-foreground">
        {contract.label}
        <span className="ml-1.5 font-mono text-[9px] text-muted-foreground">{contract.id}</span>
      </div>

      <Fact label="Selects">
        <div>{contract.selects}</div>
        {contract.precondition !== undefined && <div className="text-muted-foreground">{contract.precondition}</div>}
      </Fact>

      {contract.skips.length > 0 && (
        <Fact label="Skips">
          {contract.skips.map(skip => (
            <div key={skip.bucket}>
              <span className="font-mono text-[9px] text-amber-400/90">{skip.bucket}</span>
              <span className="text-muted-foreground"> -- {skip.why}</span>
            </div>
          ))}
        </Fact>
      )}

      <Fact label={contract.does === 'dispatch' ? 'Dispatches' : 'Proposes'}>
        <div>{contract.dispatches}</div>
      </Fact>

      <Fact label="Costs">
        <div>{contract.cost}</div>
        <div className="text-muted-foreground">{contract.verifierFollows}</div>
      </Fact>

      <Cadence contract={contract} lastRun={lastRun} />
    </div>
  )
}
