/**
 * Draw block submit-spill: before a dialog's form state goes over the wire, each
 * Draw value is processed:
 *   1. A PNG thumbnail is rendered (exportScenePng) and uploaded, and its URL is
 *      attached as `thumbUrl` so the transcript can show the drawing inline.
 *   2. Any inline scene larger than DRAW_INLINE_MAX is uploaded to the broker blob
 *      store (same path as pasted images) and swapped for a tiny `draw-ref`. This
 *      keeps the WS event + persisted snapshot small -- the scene is never dropped,
 *      it's parked in a shareable file and referenced.
 * Both steps are best-effort: a failure leaves the value usable (inline / no thumb).
 */
import { DRAW_INLINE_MAX, type DrawValue, isDrawValue } from '@shared/draw'
import { uploadFile } from '@/lib/upload'
import { exportScenePng } from './draw-export'

/** Render a scene to a PNG thumbnail and upload it; undefined on any failure. */
async function renderThumb(snapshot: string, key: string, conversationId?: string): Promise<string | undefined> {
  try {
    const png = await exportScenePng(snapshot, { maxWidthOrHeight: 800 })
    if (!png) return undefined
    const file = new File([png], `drawing-${key}.png`, { type: 'image/png' })
    const { url } = await uploadFile(file, conversationId)
    return url
  } catch (err) {
    console.error('[draw] thumbnail export/upload failed', err)
    return undefined
  }
}

/**
 * Return a copy of `values` with every Draw value carrying a `thumbUrl` (best-effort)
 * and every oversize inline scene spilled to a `draw-ref`.
 */
export async function materializeDrawValues(
  values: Record<string, unknown>,
  conversationId?: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...values }
  for (const [key, v] of Object.entries(values)) {
    if (!isDrawValue(v)) continue
    let value: DrawValue = v

    // 1. Thumbnail -- only inline scenes can be rendered here; a draw-ref keeps its
    // existing thumb from a prior submit.
    if (value.kind === 'draw' && !value.thumbUrl) {
      const thumbUrl = await renderThumb(value.snapshot, key, conversationId)
      if (thumbUrl) value = { ...value, thumbUrl }
    }

    // 2. Spill oversize inline scenes to a blob ref, preserving the thumb.
    if (value.kind === 'draw' && value.bytes > DRAW_INLINE_MAX) {
      try {
        const file = new File([value.snapshot], `drawing-${key}.json`, { type: 'application/json' })
        const { url } = await uploadFile(file, conversationId)
        value = { kind: 'draw-ref', url, bytes: value.bytes, thumbUrl: value.thumbUrl }
      } catch (err) {
        console.error('[draw] snapshot spill upload failed; sending inline', err)
      }
    }

    out[key] = value
  }
  return out
}
