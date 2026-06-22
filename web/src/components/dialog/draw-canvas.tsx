/**
 * The heavy tldraw canvas -- its OWN lazy chunk (LAZY LOAD covenant). tldraw is
 * ~13MB unpacked, so it must NOT ride the dialog chunk: draw-block.tsx React.lazy's
 * this file so tldraw loads only when a Draw block actually paints.
 *
 * Owns the editor: loads the initial snapshot, enforces readOnly, and emits the
 * (debounced) tldraw store snapshot back up as a JSON string + byte size.
 */
import { useCallback, useRef } from 'react'
import { type Editor, getSnapshot, loadSnapshot, type TLEditorSnapshot, Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { utf8Bytes } from '@shared/draw'

// tldraw 5.x is license-enforced: on a production domain WITHOUT a key it paints
// for ~2s, runs its license check, then blanks the canvas (the container survives
// but its only child is `data-testid="tl-license-expired"`, display:none). The key
// is public + domain-bound (safe to ship in the client bundle); it comes from
// web/.env at build time. Undefined => eval mode (watermark on localhost only).
const LICENSE_KEY = import.meta.env.VITE_TLDRAW_LICENSE_KEY as string | undefined

export interface DrawCanvasProps {
  /** Parsed tldraw snapshot to seed the canvas (null = blank). */
  initialSnapshot?: unknown
  readOnly?: boolean
  /** Debounced: fires with the serialized snapshot whenever the user edits. */
  onSnapshot?: (json: string, bytes: number) => void
}

export default function DrawCanvas({ initialSnapshot, readOnly, onSnapshot }: DrawCanvasProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const handleMount = useCallback(
    (editor: Editor) => {
      if (initialSnapshot) {
        try {
          loadSnapshot(editor.store, initialSnapshot as TLEditorSnapshot)
        } catch (err) {
          console.error('[draw] failed to load snapshot', err)
        }
      }
      if (readOnly) {
        editor.updateInstanceState({ isReadonly: true })
        return
      }
      if (!onSnapshot) return
      const unsub = editor.store.listen(
        () => {
          clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            const json = JSON.stringify(getSnapshot(editor.store))
            onSnapshot(json, utf8Bytes(json))
          }, 500)
        },
        { scope: 'document', source: 'user' },
      )
      return () => {
        clearTimeout(timer.current)
        unsub()
      }
    },
    [initialSnapshot, readOnly, onSnapshot],
  )

  return <Tldraw licenseKey={LICENSE_KEY} onMount={handleMount} hideUi={readOnly} />
}
