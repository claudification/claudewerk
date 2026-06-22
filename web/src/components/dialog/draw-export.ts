/**
 * Draw block export helpers: render an Excalidraw SCENE (serializeAsJSON output) to
 * a PNG, and download a scene as `.excalidraw` JSON + PNG. The Excalidraw export
 * chunk is `import()`-ed lazily so these helpers add NOTHING to the bundle until a
 * thumbnail is actually generated or the save button is pressed (LAZY LOAD covenant).
 *
 * Used by:
 *   - draw-spill.ts -- on submit, exportScenePng -> uploadFile -> thumbUrl for the
 *     transcript thumbnail.
 *   - draw-block.tsx -- the header save button (downloadScene).
 */

interface ParsedScene {
  elements: readonly unknown[]
  appState: Record<string, unknown>
  files: Record<string, unknown> | null
}

/** Parse a serializeAsJSON scene (string or already-parsed object) into export inputs. */
function parseScene(snapshot: string | unknown): ParsedScene | null {
  let s: unknown = snapshot
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s)
    } catch {
      return null
    }
  }
  if (!s || typeof s !== 'object') return null
  const o = s as { elements?: unknown; appState?: unknown; files?: unknown }
  return {
    elements: Array.isArray(o.elements) ? o.elements : [],
    appState: (o.appState as Record<string, unknown>) ?? {},
    files: (o.files as Record<string, unknown>) ?? null,
  }
}

/** True when the scene has at least one non-deleted element worth rendering. */
function sceneHasContent(snapshot: string | unknown): boolean {
  const p = parseScene(snapshot)
  return !!p && p.elements.some(el => !(el as { isDeleted?: boolean }).isDeleted)
}

/**
 * Render the scene to a PNG Blob, or null if it has no drawable content. Lazily
 * imports the Excalidraw export utilities. `maxWidthOrHeight` caps the longest
 * side (thumbnails small, saved PNGs larger).
 */
export async function exportScenePng(
  snapshot: string | unknown,
  opts?: { maxWidthOrHeight?: number },
): Promise<Blob | null> {
  const parsed = parseScene(snapshot)
  if (!parsed || !sceneHasContent(snapshot)) return null
  const { exportToBlob } = await import('@excalidraw/excalidraw')
  return exportToBlob({
    elements: parsed.elements as never,
    appState: { ...parsed.appState, exportBackground: parsed.appState.exportBackground ?? true } as never,
    files: parsed.files as never,
    mimeType: 'image/png',
    maxWidthOrHeight: opts?.maxWidthOrHeight,
  })
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Download the current scene as both a `.excalidraw` JSON file and a PNG render. */
export async function downloadScene(snapshot: string | unknown, baseName = 'drawing'): Promise<void> {
  const json = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot)
  triggerDownload(new Blob([json], { type: 'application/json' }), `${baseName}.excalidraw`)
  const png = await exportScenePng(snapshot, { maxWidthOrHeight: 2048 })
  if (png) triggerDownload(png, `${baseName}.png`)
}
