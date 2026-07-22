/**
 * Hosted-canvas surface -- a full-bleed Excalidraw with our chrome floating on
 * top of it (see canvas-island.tsx), served by the standalone /canvas/:id route.
 *
 * It is deliberately NOT a portal popout: Excalidraw binds to the global
 * `window`, so it only behaves in a document it actually owns. The reasoning is
 * written up in open-canvas-window.ts.
 *
 * Load/save/rename logic lives in useCanvasDocument.
 */

import type { CanvasSummary } from '@shared/protocol'
import { type ReactNode, useMemo } from 'react'
import ExcalidrawCanvas, { type CanvasCollabBinding } from '@/components/dialog/excalidraw-canvas'
import { useWebSocket } from '@/hooks/use-websocket'
import { CanvasIsland } from './canvas-island'
import { makeCanvasFileTransport } from './canvas-file-transport'
import { useCanvasCollab } from './use-canvas-collab'
import { canvasIdFromPath, type DocState, useCanvasDocument } from './use-canvas-document'

function CanvasBody({
  state,
  canvas,
  seed,
  onSnapshot,
  collab,
  uploadFile,
  topRight,
}: {
  state: DocState
  canvas: CanvasSummary | null
  seed: unknown
  onSnapshot: (json: string) => void
  collab: CanvasCollabBinding
  uploadFile: (fileId: string, dataURL: string) => Promise<void>
  topRight: ReactNode
}) {
  if (state !== 'ready' || !canvas) {
    return (
      <div className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">Loading canvas...</div>
    )
  }
  return (
    <ExcalidrawCanvas
      key={canvas.id}
      initialSnapshot={seed}
      onSnapshot={onSnapshot}
      collab={collab}
      uploadFile={uploadFile}
      topRight={topRight}
    />
  )
}

function CanvasSurface({ canvasId }: { canvasId: string | null }) {
  // This standalone /canvas/:id window bypasses <App>, so nothing else opens the
  // dashboard socket here. Live multiplayer (join/cursors/scene deltas) rides
  // that socket -- wsSend reads store.ws and inbound canvas_* is funnelled in
  // useWebSocket -- so without this the whole room is silent. Authed via the
  // same-origin session cookie, exactly like PopoutShell.
  // conversationChannels:false -- this window only needs the `canvas` channel;
  // subscribing it to a busy conversation's transcript would flood the socket
  // into backpressure and starve the canvas broadcasts.
  useWebSocket({ conversationChannels: false })
  const { canvas, seed, state, saveStore, onSnapshot, onRename } = useCanvasDocument(canvasId)
  // Image bytes ride their own slot (upload once, fetch by id) instead of inlining
  // base64 in every scene delta. Authed owner -> the /api/canvases/:id route.
  const files = useMemo(
    () => (canvasId ? makeCanvasFileTransport(`/api/canvases/${encodeURIComponent(canvasId)}`) : null),
    [canvasId],
  )
  // Live multiplayer is on for the hosted canvas window (a solo editor is just a
  // room of one). The Draw dialog block stays solo (no collab prop).
  const { peers, bindApi, onLocalPointer, onLocalChange } = useCanvasCollab(
    canvasId,
    state === 'ready',
    undefined,
    files?.fetch,
  )
  const collab: CanvasCollabBinding = { bindApi, onPointer: onLocalPointer, onChange: onLocalChange }

  if (state === 'missing') {
    return <div className="fixed inset-0 grid place-items-center text-muted-foreground text-sm">Canvas not found.</div>
  }

  return (
    <div className="fixed inset-0 bg-background">
      <CanvasBody
        state={state}
        canvas={canvas}
        seed={seed}
        onSnapshot={onSnapshot}
        collab={collab}
        uploadFile={files?.upload ?? (async () => {})}
        topRight={<CanvasIsland canvas={canvas} saveStore={saveStore} peers={peers} onRename={onRename} />}
      />
    </div>
  )
}

/** Standalone /canvas/:id route entry -- keys the canvas off the path. */
export function CanvasWindow() {
  return <CanvasSurface canvasId={canvasIdFromPath()} />
}
