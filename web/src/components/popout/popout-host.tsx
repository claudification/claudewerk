/**
 * PopoutHost -- mounted ONCE in the app shell. Renders one <PopoutWindow> per
 * open record in use-popout-store and routes it to the right (lazy) surface by
 * kind. The heavy surface chunk (Excalidraw, ...) loads only when a popout opens.
 *
 * A single window-level beforeunload closes every popup so a parent-tab reload
 * (e.g. an SW update) never orphans a popout that can no longer be re-parented.
 */

import { lazy, type ReactNode, Suspense, useEffect } from 'react'
import { PopoutWindow } from './popout-window'
import { type PopoutRecord, usePopoutStore } from './use-popout-store'

const CanvasSurface = lazy(() => import('../canvas/canvas-window').then(m => ({ default: m.CanvasSurface })))

function renderSurface(rec: PopoutRecord): ReactNode {
  switch (rec.kind) {
    case 'canvas':
      return <CanvasSurface canvasId={rec.payloadId} />
    default:
      return null
  }
}

// Consumed via app.tsx's lazyModule(named(import, 'PopoutHost')) -- a dynamic
// string ref fallow's static graph can't follow.
// fallow-ignore-next-line unused-export
export function PopoutHost() {
  const records = usePopoutStore(s => s.records)
  const close = usePopoutStore(s => s.close)

  useEffect(() => {
    const onUnload = () => {
      for (const rec of Object.values(usePopoutStore.getState().records)) {
        try {
          rec.win.close()
        } catch {}
      }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  return (
    <>
      {Object.values(records).map(rec => (
        <PopoutWindow key={rec.id} win={rec.win} onClose={() => close(rec.id)}>
          <Suspense fallback={null}>{renderSurface(rec)}</Suspense>
        </PopoutWindow>
      ))}
    </>
  )
}
