/**
 * The debounced scene-flush for a hosted canvas: persist the scene, upload any new
 * image bytes to the file slot, then emit a files-LESS live delta. Split out of
 * ExcalidrawCanvas so that component stays a thin Excalidraw shell.
 *
 * Ordering matters: the upload must SETTLE before the delta is emitted, or a peer
 * can receive a fileId before the bytes exist, fetch a 404, and -- since deltas
 * aren't re-sent -- show that image broken forever.
 */

import { serializeAsJSON } from '@excalidraw/excalidraw'
import { utf8Bytes } from '@shared/draw'
import { useCallback, useRef } from 'react'
import type { CanvasCollabBinding, ChangeAppState, ChangeElements, ChangeFiles } from './excalidraw-canvas'

export type FlushChange = (elements: ChangeElements, appState: ChangeAppState, files: ChangeFiles) => Promise<void>

export function useCanvasFlush(
  collab: CanvasCollabBinding | undefined,
  onSnapshot: ((json: string, bytes: number) => void) | undefined,
  uploadFile: ((fileId: string, dataURL: string) => Promise<void>) | undefined,
): FlushChange {
  // fileIds already uploaded to the slot -- skip re-uploading on every onChange.
  const uploadedIds = useRef<Set<string>>(new Set())

  const uploadNewFiles = useCallback(
    async (files: ChangeFiles) => {
      if (!uploadFile || !files) return
      const pending: Promise<void>[] = []
      for (const [id, f] of Object.entries(files)) {
        if (uploadedIds.current.has(id)) continue
        const dataURL = (f as { dataURL?: string }).dataURL
        if (typeof dataURL !== 'string') continue
        uploadedIds.current.add(id) // optimistic; roll back on failure so a retry re-uploads
        pending.push(
          uploadFile(id, dataURL).catch(() => {
            uploadedIds.current.delete(id)
          }),
        )
      }
      if (pending.length) await Promise.all(pending)
    },
    [uploadFile],
  )

  return useCallback(
    async (elements, appState, files) => {
      const fullJson = serializeAsJSON(elements, appState, files ?? {}, 'local')
      onSnapshot?.(fullJson, utf8Bytes(fullJson))
      if (!collab) return
      // Upload the bytes to the slot first (await), so a live peer can fetch them the
      // instant the broker's files-LESS broadcast lands.
      await uploadNewFiles(files)
      // Send the FAT scene on the WS delta. The BROKER derives the files-less wire
      // copy (toWireScene) and persists our input VERBATIM -- so the scene it stores
      // is self-contained. If the client stripped here (as it used to), the broker
      // would persist a THINNED scene and the image would vanish on reload. The
      // N-way broadcast stays lean because the broker, not us, strips it.
      collab.onChange(fullJson)
    },
    [collab, onSnapshot, uploadNewFiles],
  )
}
