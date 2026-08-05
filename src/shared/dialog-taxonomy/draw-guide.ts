import type { TaxonomyEntry } from './types'

/**
 * draw.* GUIDANCE slices -- the claudewerk-specific knowledge that is NOT in any
 * Excalidraw doc: the dark-mode color filter, the inline-size spill, the comment
 * convention, plus recipes and example pointers.
 */
export const DRAW_GUIDE_ENTRIES: TaxonomyEntry[] = [
  {
    subject: 'draw.colors',
    title: 'Colors -- the dark-mode palette (CRITICAL)',
    summary: 'The dark canvas inverts+hue-rotates; author with STANDARD light hexes or output is muddy.',
    related: ['draw', 'draw.gotchas', 'draw.base'],
    body: `# Colors -- author with the STANDARD light palette

**The single most important Draw gotcha.** The claudewerk canvas defaults to dark theme,
which applies a CSS **invert + hue-rotate** filter over the whole scene. So you must author
with Excalidraw's STANDARD LIGHT-palette hexes -- the filter turns them into the correct
pastels on screen. If you store the final pastel you wanted, the filter muddies it.

## Ink / strokes
| color | hex |
|-------|-----|
| black ink (default) | \`#1e1e1e\` |
| red | \`#e03131\` |
| green | \`#2f9e44\` |
| blue | \`#1971c2\` |
| orange | \`#f08c00\` |
| violet | \`#9c36b5\` |
| grey | \`#868e96\` |

## Fills (pale)
| fill | hex |
|------|-----|
| pale red | \`#ffc9c9\` |
| pale green | \`#b2f2bb\` |
| pale blue | \`#a5d8ff\` |
| pale yellow | \`#ffec99\` |
| pale violet | \`#eebefa\` |

Use \`backgroundColor: "transparent"\` for no fill. These are the exact Excalidraw default
swatches -- staying on-palette guarantees the dark filter lands correctly.`,
  },
  {
    subject: 'draw.gotchas',
    title: 'claudewerk gotchas (not in any Excalidraw doc)',
    summary: 'Dark-mode palette, 256KB spill, theme seeding, fonts, polygon caveat, comments-as-scene-data.',
    related: ['draw.colors', 'draw.comments', 'draw', 'draw.elements.arrow'],
    body: `# claudewerk Draw gotchas

1. **Dark-mode color filter (read \`draw.colors\`).** Author with STANDARD light-palette
   hexes; the dark canvas inverts+hue-rotates them into correct pastels. Storing the final
   pastel = muddy output.
2. **Theme is seeded via appState, NOT the controlled prop.** The canvas defaults
   \`appState.theme\` to \`"dark"\`. Put \`"theme":"dark"\` in your scene's \`appState\`; never
   rely on a \`theme\` prop.
3. **256 KB inline cap** (\`DRAW_INLINE_MAX\`). Bigger scenes spill to a blob \`contentUrl\`.
   Upload via \`mcp__rclaude__share_file\` -> same-origin \`concentrator.frst.dev/file/*.json\`
   URL the panel fetches clean (no CORS). Seed via \`content\` (inline) or \`contentUrl\`.
4. **\`scrollToContent: true\`** in appState auto-frames the drawing on load -- almost always want it.
5. **Fonts** fetch from a CDN: \`1\` Virgil / \`2\` Helvetica / \`3\` Cascadia (code) / \`5\`
   Excalifont (hand-drawn) / \`6\` Nunito. **Default to \`5\`** -- titles, descriptions and
   connector labels are prose about the drawing and belong in the same hand the user writes
   in. Use \`6\` only for FACTS (values, metrics, identifiers someone might transcribe) and
   \`3\` for code.
6. **Triangles/polygons/flames:** a closed \`line\` whose \`points\` return to origin
   (\`[0,0]\` last) + a \`backgroundColor\`/\`fillStyle\`. This is version-safe. A
   \`polygon: true\` flag exists in NEWER Excalidraw builds but is NOT in the pinned schema
   we ship -- prefer the closed-points form.
7. **Comments come back as SCENE DATA, not a side channel** (read \`draw.comments\`). When a
   user annotates a Draw block and submits, their notes are first-class \`text\` elements in
   the returned scene JSON -- there is no separate annotation field (unlike a Diagram/mermaid
   block's \`commentable\` -> \`values[id]={nodeId:note}\`).`,
  },
  {
    subject: 'draw.comments',
    title: 'User comments / the annotation layer convention',
    summary: 'Submitted comments are text elements in the scene; the recommended customData markers.',
    related: ['draw.gotchas', 'draw.base'],
    body: `# Comments / annotation layer

When the user edits a Draw block and submits, **their comments arrive as first-class
\`text\` elements inside the returned scene JSON** (plus a \`thumbUrl\` PNG alongside). There
is NO dedicated annotation channel for Draw.

To separate the user's notes from your drawing content on the reverse/diff path, two
complementary conventions (both consumed by the Scene-DSL reverse/diff pipeline):

- **\`customData.dslId\` (absence == annotation).** Elements YOU author via the compact
  Scene DSL carry a \`customData.dslId\`. User-added elements have no \`customData\`, so
  **absence of \`dslId\` is the signal that an element is a user annotation**, not authored
  content. If you hand-author raw elements you want EXCLUDED from the annotation layer,
  stamp them with your own \`customData.dslId\`.

- **\`customData.role: "comment"\` (recommended explicit marker).** Stamp deliberate
  annotation/note elements with \`customData: { "role": "comment" }\`. The reverse/diff path
  carries \`role\` through, so an agent can distinguish intentional notes from stray strokes.
  Use this when you programmatically add a note element you want treated as a comment.

Neither requires extra wiring on your side -- they are descriptive conventions the submit
pipeline already honors.`,
  },
  {
    subject: 'draw.recipes',
    title: 'Recipes (labelled box, two-node flow, filled triangle)',
    summary: 'Copy-paste fragments for the common authoring patterns.',
    related: ['draw.bindings', 'draw.elements.arrow', 'draw.colors', 'draw.examples'],
    body: `# Recipes

## Labelled box (text centered in a shape)
\`\`\`json
{ "id": "box", "type": "rectangle", "x": 100, "y": 100, "width": 200, "height": 80,
  "strokeColor": "#1e1e1e", "backgroundColor": "#a5d8ff", "roundness": {"type":3},
  "boundElements": [ {"id":"lbl","type":"text"} ] },
{ "id": "lbl", "type": "text", "x": 110, "y": 128, "width": 180, "height": 25,
  "text": "Service", "fontSize": 20, "fontFamily": 5, "textAlign": "center",
  "verticalAlign": "middle", "containerId": "box", "originalText": "Service" }
\`\`\`

## Two boxes connected by a bound arrow
\`\`\`json
{ "id": "a", "type": "rectangle", "x": 60,  "y": 80, "width": 140, "height": 60,
  "strokeColor": "#1e1e1e", "backgroundColor": "#b2f2bb",
  "boundElements": [ {"id":"arr","type":"arrow"} ] },
{ "id": "b", "type": "rectangle", "x": 320, "y": 80, "width": 140, "height": 60,
  "strokeColor": "#1e1e1e", "backgroundColor": "#ffec99",
  "boundElements": [ {"id":"arr","type":"arrow"} ] },
{ "id": "arr", "type": "arrow", "x": 200, "y": 110, "width": 120, "height": 0,
  "points": [ [0,0], [120,0] ], "endArrowhead": "arrow",
  "startBinding": {"elementId":"a","focus":0,"gap":4},
  "endBinding":   {"elementId":"b","focus":0,"gap":4} }
\`\`\`

## Filled triangle (closed polygon line)
\`\`\`json
{ "id": "tri", "type": "line", "x": 200, "y": 200, "width": 100, "height": 90,
  "strokeColor": "#e03131", "backgroundColor": "#ffc9c9", "fillStyle": "solid",
  "points": [ [0,90], [50,0], [100,90], [0,90] ] }
\`\`\`
(points return to the origin point -> a closed, fillable shape. See \`draw.gotchas\` #6.)`,
  },
  {
    subject: 'draw.examples',
    title: 'Validated example scenes',
    summary: 'Full render-tested scenes shipped as fixtures (rocket, robot, skyline).',
    related: ['draw', 'draw.recipes'],
    body: `# Validated example scenes

Three complete, render-tested scenes ship as golden fixtures (and stay live at their
URLs). Fetch one, study how it composes shapes/lines/text/colors, adapt it:

| scene | URL | ~elements |
|-------|-----|-----------|
| rocket | https://concentrator.frst.dev/file/y4o3nyykzlzn.json | 21 |
| robot | https://concentrator.frst.dev/file/2zpheg8zd6hi6.json | 16 |
| skyline | https://concentrator.frst.dev/file/13f679jdw20a5.json | 51 |

All three use the standard light palette (so the dark filter lands correctly), seed
\`appState.theme:"dark"\` + \`scrollToContent:true\`, and compose only the element types
documented under \`draw.elements\`. They are validated on every build: a test asserts each
parses to a well-formed scene with schema-conformant elements (see the taxonomy test).`,
  },
]
