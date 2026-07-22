/**
 * Public canvas viewer -- mounted when the SPA enters share mode with
 * kind='canvas' (/c/:token redirects here). No project chrome, no auth gate.
 * Tier drives the surface: read = view-only; comment = add notes only (base
 * locked, enforced server-side); edit = full co-edit. All writes go through the
 * tier-gated public route.
 */

import type { CanvasPeer } from '@shared/protocol'
import ExcalidrawCanvas, { type CanvasCollabBinding } from '@/components/dialog/excalidraw-canvas'
import { useWebSocket } from '@/hooks/use-websocket'
import { PresenceDots } from './canvas-presence-dots'
import { useCanvasCollab } from './use-canvas-collab'
import { useGuestName } from './use-guest-name'
import type { PublicCanvasDoc } from './use-public-canvas'
import { usePublicCanvas } from './use-public-canvas'

const TIER_NOTE: Record<string, string> = {
  read: 'View only',
  comment: 'Comment mode - add notes, the design is locked',
  edit: 'Edit mode - changes save live',
}

const SAVE_BADGE: Record<PublicCanvasDoc['saveState'], { text: string; cls: string } | null> = {
  idle: null,
  saving: { text: 'saving...', cls: 'text-muted-foreground/60' },
  saved: { text: 'saved', cls: 'text-emerald-400/70' },
  rejected: { text: 'change rejected - the design is locked in comment mode', cls: 'text-red-400/90' },
}

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 grid place-items-center bg-background text-sm text-muted-foreground">{children}</div>
  )
}

function ViewerHeader({
  name,
  tier,
  saveState,
  peers,
  guestName,
  onRename,
}: {
  name: string
  tier: string
  saveState: PublicCanvasDoc['saveState']
  peers: CanvasPeer[]
  guestName: string
  onRename: () => void
}) {
  const badge = SAVE_BADGE[saveState]
  return (
    <div className="flex items-center gap-3 px-3 h-9 border-b border-border shrink-0 text-xs">
      <span className="font-mono text-sky-400/90 truncate">{name}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 shrink-0">{TIER_NOTE[tier]}</span>
      <span className="flex-1" />
      {badge && <span className={`text-[10px] ${badge.cls}`}>{badge.text}</span>}
      <PresenceDots peers={peers} />
      <button
        type="button"
        onClick={onRename}
        title="Change the name others see"
        className="text-[10px] text-muted-foreground/70 hover:text-sky-300 shrink-0"
      >
        {guestName}
      </button>
    </div>
  )
}

// fallow-ignore-next-line complexity -- loading/missing/ready three-state view, irreducible.
export function PublicCanvasView({ token }: { token: string }) {
  // App routes here BEFORE any other useWebSocket() (Dashboard/PopoutShell), so
  // the share socket is opened here or not at all. buildWsUrl() appends
  // ?share=<token>, which the broker upgrades into a canvas-scoped guest socket
  // (shareCanvasId/tier) -- the thing the live room join, cursors, and scene
  // deltas all ride. Without it the "changes save live" promise is a lie.
  useWebSocket()
  const { doc, seed, state, saveState, onSnapshot } = usePublicCanvas(token)
  const { name: guestName, rename } = useGuestName()
  // Guests join the SAME room members do -- the share-mode socket already carries
  // ?share=<token>, and the broker pins it to this canvas at the token's tier.
  // Read-tier guests still join: they receive cursors and live edits, and simply
  // never send (readOnly stops onChange at the source).
  const { peers, bindApi, onLocalPointer, onLocalChange } = useCanvasCollab(
    doc?.canvas.id ?? null,
    state === 'ready',
    guestName,
  )
  const collab: CanvasCollabBinding = { bindApi, onPointer: onLocalPointer, onChange: onLocalChange }

  if (state === 'loading') return <FullScreen>Loading canvas...</FullScreen>
  if (state === 'missing' || !doc) return <FullScreen>This share link is invalid or has been revoked.</FullScreen>

  const readOnly = doc.tier === 'read'
  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <ViewerHeader
        name={doc.canvas.name}
        tier={doc.tier}
        saveState={saveState}
        peers={peers}
        guestName={guestName}
        onRename={rename}
      />
      <div className="flex-1 min-h-0 relative">
        {/* onSnapshot (HTTP PUT) stays alongside the WS delta on purpose: the WS
            path is what other peers SEE, while the HTTP response is what tells a
            comment-tier guest their change was rejected. Both persist the same
            JSON, so the redundancy costs a write, not correctness. */}
        <ExcalidrawCanvas
          key={doc.canvas.id}
          initialSnapshot={seed}
          readOnly={readOnly}
          onSnapshot={readOnly ? undefined : onSnapshot}
          collab={collab}
        />
      </div>
    </div>
  )
}
