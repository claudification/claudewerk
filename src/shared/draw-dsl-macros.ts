/**
 * Semantic-UI macros: a leaf DSL node (button/input/checkbox/nav/image) -> a small group
 * of sketchy-wireframe skeletons. Split out of draw-dsl-skeleton.ts so the skeleton walker
 * stays small and the per-kind macro table lives on its own. Pure.
 *
 * Author with Excalidraw's STANDARD light-palette hexes: the dark canvas inverts +
 * hue-rotates them into correct pastels (storing final pastels reads muddy). Verified by
 * the sibling excalidraw-theming work; theming polish is owned there.
 */
import type { DslNode, Placed, Skeleton } from './draw-dsl'

const ACCENT = '#1971c2' // standard blue
const MUTED = '#868e96' // standard gray
const BAR = '#f1f3f5' // pale fill -> inverts to a dark bar in dark mode

// A flat per-kind dispatch table (not branching logic) -- complexity is inherent.
/** Semantic-UI nodes -> a small sketchy wireframe group (primary shape carries `id`). */
// fallow-ignore-next-line complexity
export function uiMacro(node: DslNode, p: Placed, id: string): Skeleton[] {
  switch (node.kind) {
    case 'button': {
      const ghost = node.variant === 'ghost'
      return [
        {
          type: 'rectangle',
          id,
          x: p.x,
          y: p.y,
          width: p.w,
          height: p.h,
          roundness: { type: 3 },
          backgroundColor: ghost ? 'transparent' : ACCENT,
          fillStyle: 'solid',
          strokeColor: ACCENT,
          label: { text: node.text, strokeColor: ghost ? ACCENT : '#ffffff' },
        },
      ]
    }
    case 'input': {
      const sks: Skeleton[] = []
      let fy = p.y
      if (node.label) {
        sks.push({ type: 'text', id: `${id}~lbl`, x: p.x, y: fy, text: node.label, fontSize: 16, strokeColor: MUTED })
        fy += 22
      }
      sks.push({
        type: 'rectangle',
        id,
        x: p.x,
        y: fy,
        width: p.w,
        height: 40,
        roundness: { type: 3 },
        ...(node.placeholder ? { label: { text: node.placeholder, strokeColor: MUTED } } : {}),
      })
      return sks
    }
    case 'checkbox':
      return [
        {
          type: 'rectangle',
          id,
          x: p.x,
          y: p.y,
          width: 24,
          height: 24,
          roundness: { type: 3 },
          ...(node.checked ? { backgroundColor: ACCENT, fillStyle: 'solid' } : {}),
        },
        { type: 'text', id: `${id}~lbl`, x: p.x + 32, y: p.y + 2, text: node.text, fontSize: 16 },
      ]
    case 'nav':
      return [
        {
          type: 'rectangle',
          id,
          x: p.x,
          y: p.y,
          width: p.w,
          height: p.h,
          roundness: { type: 3 },
          backgroundColor: BAR,
          fillStyle: 'solid',
          strokeColor: MUTED,
        },
        { type: 'text', id: `${id}~items`, x: p.x + 14, y: p.y + 12, text: node.items.join('     '), fontSize: 16 },
      ]
    case 'image':
      return imageMacro(node.url, p, id)
    default:
      return []
  }
}

/** The canonical wireframe image placeholder: a dashed frame + a diagonal cross, caption
 * pinned bottom-left so it doesn't collide with the cross. */
function imageMacro(url: string, p: Placed, id: string): Skeleton[] {
  const cross = (suffix: string, a: number[], b: number[]): Skeleton => ({
    type: 'line',
    id: `${id}~${suffix}`,
    x: p.x,
    y: p.y,
    points: [a, b],
    strokeColor: MUTED,
    strokeStyle: 'dashed',
  })
  return [
    { type: 'rectangle', id, x: p.x, y: p.y, width: p.w, height: p.h, strokeStyle: 'dashed', strokeColor: MUTED },
    cross('x1', [0, 0], [p.w, p.h]),
    cross('x2', [p.w, 0], [0, p.h]),
    {
      type: 'text',
      id: `${id}~cap`,
      x: p.x + 8,
      y: p.y + p.h - 22,
      text: shortUrl(url),
      fontSize: 14,
      strokeColor: MUTED,
    },
  ]
}

function shortUrl(url: string): string {
  const tail = url.split('/').pop() || url
  return tail.length > 24 ? `${tail.slice(0, 21)}...` : tail
}
