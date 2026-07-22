/**
 * Client transport for canvas image bytes -- the counterpart to the broker's
 * per-canvas file slot. Image bytes upload ONCE here (not inlined in every scene
 * delta, which floods the WS) and peers fetch them by Excalidraw fileId.
 *
 * One factory, two bases: authed owners hit `/api/canvases/:id`, share guests hit
 * `/shared/public/canvas/:token` (the token itself is the temporary upload cap).
 */

/** The slice of Excalidraw's BinaryFileData we round-trip. */
export interface CanvasBinaryFile {
  id: string
  dataURL: string
  mimeType: string
  created: number
}

export type UploadFile = (fileId: string, dataURL: string) => Promise<void>
export type FetchFile = (fileId: string) => Promise<CanvasBinaryFile | null>

export interface CanvasFileTransport {
  upload: UploadFile
  fetch: FetchFile
}

/** Pull the mime out of a `data:<mime>;base64,...` URL (Excalidraw needs it back). */
function mimeFromDataUrl(dataURL: string): string {
  return dataURL.match(/^data:([^;,]+)/)?.[1] ?? 'image/png'
}

/**
 * Build an upload/fetch pair for one canvas. `base` is the canvas's route root
 * (`/api/canvases/<id>` or `/shared/public/canvas/<token>`); files hang off
 * `<base>/files/<fileId>`. Failures resolve softly (upload throws so the caller
 * can await/settle; fetch returns null so a missing image just doesn't render
 * rather than crashing the apply loop).
 */
export function makeCanvasFileTransport(base: string): CanvasFileTransport {
  const fileUrl = (fileId: string) => `${base}/files/${encodeURIComponent(fileId)}`
  return {
    upload: async (fileId, dataURL) => {
      const res = await fetch(fileUrl(fileId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataURL }),
      })
      if (!res.ok) throw new Error(`canvas file upload ${fileId} -> ${res.status}`)
    },
    fetch: async fileId => {
      const res = await fetch(fileUrl(fileId))
      if (!res.ok) return null
      const { id, dataURL } = (await res.json()) as { id?: string; dataURL?: string }
      if (typeof dataURL !== 'string') return null
      return { id: id ?? fileId, dataURL, mimeType: mimeFromDataUrl(dataURL), created: Date.now() }
    },
  }
}
