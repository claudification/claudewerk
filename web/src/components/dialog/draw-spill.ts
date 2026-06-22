/**
 * Draw block submit-spill: before a dialog's form state goes over the wire, any
 * inline drawing larger than DRAW_INLINE_MAX is uploaded to the broker blob store
 * (same path as pasted images) and swapped for a tiny URL reference. This keeps
 * the WS event + persisted snapshot small and is the recovery for big drawings --
 * the snapshot is never dropped, it's parked in a shareable file and referenced.
 */
import { DRAW_INLINE_MAX, type DrawValue, isDrawValue } from '@shared/draw'
import { uploadFile } from '@/lib/upload'

/**
 * Return a copy of `values` with every oversize inline Draw snapshot spilled to a
 * blob and replaced by a `draw-ref`. Best-effort: an upload failure leaves the
 * value inline (the broker's hard cap then surfaces an error bar rather than the
 * client silently losing the drawing).
 */
export async function materializeDrawValues(
  values: Record<string, unknown>,
  conversationId?: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...values }
  for (const [key, v] of Object.entries(values)) {
    if (!isDrawValue(v) || v.kind !== 'draw' || v.bytes <= DRAW_INLINE_MAX) continue
    try {
      const file = new File([v.snapshot], `drawing-${key}.json`, { type: 'application/json' })
      const { url } = await uploadFile(file, conversationId)
      const ref: DrawValue = { kind: 'draw-ref', url, bytes: v.bytes }
      out[key] = ref
    } catch (err) {
      console.error('[draw] snapshot spill upload failed; sending inline', err)
    }
  }
  return out
}
