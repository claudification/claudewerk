/**
 * @vitest-environment node
 */
/**
 * The seam: a `<channel sender="canvas">` entry must come out of the parser as a
 * canvas item (id + chips + clean text), not as the plain-text fallback that put
 * raw `<selected>` markup in the bubble.
 */

import { describe, expect, test } from 'vitest'
import { parseGroupEntries } from './parse-entries'

const CANVAS_ENTRY = {
  message: {
    content: `<channel source="rclaude" sender="canvas" from_conversation="canvas:cnv_6ec4c5e2" from_project="canvas" intent="request">
  <selected id="ytaVE08z" type="rectangle" stroke="#1971c2" fill="#ffc9c9" at="356,544" size="207x82">CLAUDE</selected>
make sense of this scene
</channel>`,
  },
}

describe('parseGroupEntries -- canvas channel', () => {
  const [item] = parseGroupEntries([CANVAS_ENTRY], () => undefined)

  test('is a canvas channel item', () => {
    expect(item.kind).toBe('channel')
    expect(item).toMatchObject({ isCanvasChannel: true, source: 'canvas', intent: 'request' })
  })

  test('carries the canvas id for the link', () => {
    expect(item).toMatchObject({ canvasId: 'cnv_6ec4c5e2' })
  })

  test('the text is the message, with the markup lifted out', () => {
    expect(item).toMatchObject({ text: 'make sense of this scene' })
  })

  test('the selection survives as a chip', () => {
    expect(item).toMatchObject({ canvasChips: [{ id: 'ytaVE08z', type: 'rectangle', label: 'CLAUDE' }] })
  })
})
