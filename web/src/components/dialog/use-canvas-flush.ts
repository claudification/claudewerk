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
      // Persistence keeps files INLINE (disk snapshot is self-contained, so a
      // reload/join needs no fetch). Only the live WS delta strips them.
      const fullJson = serializeAsJSON(elements, appState, files ?? {}, 'local')
      onSnapshot?.(fullJson, utf8Bytes(fullJson))
      if (!collab) return
      await uploadNewFiles(files)
      // With an upload slot the delta carries fileIds only; without one, fall back
      // to inline files so the image still reaches peers.
      const deltaJson = uploadFile ? serializeAsJSON(elements, appState, {}, 'local') : fullJson
      collab.onChange(deltaJson)
    },
    [collab, onSnapshot, uploadFile, uploadNewFiles],
  )
}
