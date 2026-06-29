/**
 * Dock -- THE single global tray of every parked / floating surface.
 *
 * PARKED section shows manager-backed UI modals whose presentation==='docked'
 * (including live dialogs, which are now managed modals). SHELLS section shows
 * the always-roster host shells. One tray, one mental model; self-hides when
 * everything is empty. See plan-unified-modals.md.
 */
import type { ShellRosterEntry } from '@shared/protocol'
import { lazy, Suspense, useMemo } from 'react'
import type { ModalRecord } from '@/hooks/modal-manager-types'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { useShellExpansion } from '@/hooks/use-shell-expansion'
import { useShellRoster } from '@/hooks/use-shells'
import { ModalDockTile } from './modal-dock-tile'
import { ShellDockTile } from './shell-dock-tile'

const ShellOverlay = lazy(() => import('./shell-overlay').then(m => ({ default: m.ShellOverlay })))

type ShellRoster = Record<string, ShellRosterEntry>

function SectionLabel({ children }: { children: string }) {
  return <span className="text-[9px] font-mono uppercase tracking-wide text-white/30 shrink-0 px-1">{children}</span>
}

function ParkedSection({ parked }: { parked: ModalRecord[] }) {
  return (
    <>
      <SectionLabel>parked</SectionLabel>
      {parked.map(r => (
        <ModalDockTile key={r.id} record={r} />
      ))}
    </>
  )
}

function ShellsSection({
  shellIds,
  onExpand,
  showDivider,
}: {
  shellIds: string[]
  onExpand: (id: string) => void
  showDivider: boolean
}) {
  return (
    <>
      {showDivider && <span className="h-4 w-px bg-white/10 shrink-0" aria-hidden />}
      <SectionLabel>shells</SectionLabel>
      {shellIds.map(shellId => (
        <ShellDockTile key={shellId} shellId={shellId} onExpand={() => onExpand(shellId)} />
      ))}
    </>
  )
}

function ShellOverlayHost({
  expandedId,
  roster,
  onMinimize,
}: {
  expandedId: string | null
  roster: ShellRoster
  onMinimize: () => void
}) {
  if (!expandedId || !roster[expandedId]) return null
  return (
    <Suspense fallback={null}>
      <ShellOverlay shellId={expandedId} onMinimize={onMinimize} />
    </Suspense>
  )
}

function useDockContents() {
  const records = useModalManagerStore(s => s.records)
  const roster = useShellRoster()

  const parked = useMemo(
    () =>
      Object.values(records)
        .filter(r => r.presentation === 'docked')
        .sort((a, b) => a.openedAt - b.openedAt),
    [records],
  )

  const shellIds = useMemo(
    () =>
      Object.values(roster)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(s => s.shellId),
    [roster],
  )

  const hasParked = parked.length > 0
  const hasShells = shellIds.length > 0
  return { roster, parked, shellIds, hasParked, hasShells, empty: !hasParked && !hasShells }
}

export function Dock() {
  const { roster, parked, shellIds, hasParked, hasShells, empty } = useDockContents()
  const [expandedId, setExpandedId] = useShellExpansion(roster)
  if (empty) return null

  return (
    <>
      <div className="flex items-center gap-1.5 overflow-x-auto py-1" data-dock>
        {hasParked && <ParkedSection parked={parked} />}
        {hasShells && <ShellsSection shellIds={shellIds} onExpand={setExpandedId} showDivider={hasParked} />}
      </div>
      <ShellOverlayHost expandedId={expandedId} roster={roster} onMinimize={() => setExpandedId(null)} />
    </>
  )
}
