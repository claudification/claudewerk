/**
 * The "scheme" box emitter: a ShapeNode carrying variant/title/subtitle -> a polished group
 * (pastel rectangle + centered ink title + grey subtitle). Split out of draw-dsl-skeleton.ts
 * to keep that file under the size bar. Pure (no Excalidraw runtime).
 *
 * Centering note: convertToExcalidrawElements treats a centered text's `x` as the CENTER
 * anchor (it stores left = x - realWidth/2), so we pass the box's horizontal center and let
 * convert center with REAL glyph metrics -- no dependence on our rough estimate.
 */
import type { Placed, ShapeNode, Skeleton } from './draw-dsl'
import { FONT_FAMILY, SCHEME_FILLS, SCHEME_RECIPE, schemeBlock } from './scheme-variants'

/** A presentation-grade box: pastel rectangle + centered ink title + grey subtitle. The
 * extra texts share the box's dslId (mapped in the skeleton walker) so the round-trip treats
 * it as one node. The rectangle carries `text:title` purely as the reverse pass's baseline
 * label (convert ignores a bare `text` on a shape; the visible title is a separate text). */
export function schemeBox(node: ShapeNode, p: Placed, id: string): Skeleton[] {
  const R = SCHEME_RECIPE
  const title = node.title ?? node.text
  const sub = node.subtitle
  const rect: Skeleton = {
    type: 'rectangle',
    id,
    x: p.x,
    y: p.y,
    width: p.w,
    height: p.h,
    backgroundColor: node.style?.fill ?? (node.variant ? SCHEME_FILLS[node.variant] : SCHEME_FILLS.plain),
    strokeColor: node.style?.stroke ?? R.stroke,
    fillStyle: 'solid',
    roughness: node.style?.rough ?? R.roughness,
    roundness: { type: R.roundnessType },
    ...(title ? { text: title } : {}),
  }
  const out: Skeleton[] = [rect]
  const { titleH, blockH } = schemeBlock(title ?? '', sub ?? '')
  let y = p.y + (p.h - blockH) / 2
  const titleFont = node.style?.font ? FONT_FAMILY[node.style.font] : R.titleFont
  if (title) {
    out.push(centeredText(`${id}~title`, title, p, y, R.titlePx, R.titleColor, titleFont))
    y += titleH + R.lineGap
  }
  if (sub) out.push(centeredText(`${id}~sub`, sub, p, y, R.subPx, R.subColor, R.subFont))
  return out
}

/** A text skeleton centered in the box: `x` is the box center (convert's center anchor). */
function centeredText(
  id: string,
  text: string,
  p: Placed,
  y: number,
  px: number,
  color: string,
  font: number,
): Skeleton {
  return {
    type: 'text',
    id,
    x: p.x + p.w / 2,
    y,
    text,
    fontSize: px,
    strokeColor: color,
    fontFamily: font,
    textAlign: 'center',
  }
}
