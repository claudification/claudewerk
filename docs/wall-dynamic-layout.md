# THE WALL, dynamic -- widget backsides, size classes, a pane gallery

**Status: exploration + scoping. No layout engine is built by this document.**
It exists because `epic-the-wall` rule 6 said "the layout is HARD in v1, a
configurable pane grid is explicitly FUTURE, do not build a layout engine", and
this is the card that goes and looks at FUTURE.

Card: `explore-the-possibility-of-the-wall-dashbaord-being-dynamic-`
(epic `epic-the-wall-ii`). It asks for four things -- a per-pane
configuration backside like an Apple widget has, a fixed set of size classes
with column span, a minimize/collapse affordance, and a `+` to add more
widgets -- plus prior art, scoped into tranches.

---

## 1. The finding that shapes everything else

**The registry is already the seam. The wall does not need a layout engine, it
needs the registry split in two.**

`web/src/components/wall/wall-pane-registry.ts` is a static
`Record<WallColumn, WallPaneEntry[]>` where an entry is `{ code, feeds, load }`.
`wall-grid.tsx` maps it to three flex columns. Nothing else in the wall knows
where a pane sits.

Everything this card asks for is the same one change:

| today | after |
|---|---|
| ONE const that is both "what panes exist" and "where they go" | a **CATALOG** (what panes exist, what they are called, what they feed on, which sizes they can render) and a **LAYOUT** (per-user, persisted, ordered, sized, collapsed) |

That split is not an invention. It is the Apple widget gallery vs the home
screen, and Grafana's panel library vs the dashboard's `gridPos`. Collapse,
reorder, resize, add and remove are all *edits to the layout value*. The
backside is a *view of the catalog entry plus that pane's layout row*. Persist,
reset and presets are *serialising the layout value*.

Get that split landed with the render byte-identical to today and the remaining
five tranches are ordinary UI work. Skip it and every tranche invents its own
half of the same state.

## 2. What the wall actually is right now

Facts, read off the tree at `685a542f`, because the design has to survive them.

- **F1 -- the grid has no rows.** `.wall-grid` is
  `grid-template-columns: minmax(300px,5fr) minmax(280px,4fr) minmax(240px,3.2fr)`
  and `grid-template-rows: 1fr`. A `.wall-col` is a **flexbox column**. Panes are
  `flex: 0 0 auto`, `wall-pane-grow` is `flex: 1 1 auto`, and `maxHeight` is a
  per-pane cap expressed as a share of the column. There is no row track anywhere,
  so there is no such thing as `2x2` yet. Column A and B do not scroll; only C does.
- **F2 -- `WallPane` already owns the chrome** every pane wears: title, code,
  `stale`, count, `tabs`, the required `report()` copy button, `grow`,
  `maxHeight`, `hideInAmbient`, `rewind`. A flip button and a collapse chevron
  belong in `WallPaneHead` and nowhere else.
- **F3 -- there is almost nothing to put on a backside today.** The only
  pane-local option in the whole wall is A9's `metric` `useState`. The period
  control is deliberately wall-WIDE (`wall-period-tabs.tsx` explains at length why
  it renders in the pane head rather than the wall header) and only A2 obeys it.
- **F4 -- the feed census is folded off the static registry.**
  `WALL_PULL_FEEDS` is `new Set(entries.flatMap(e => e.feeds))` and
  `wall-revive-census.ts` reports `DECLARED - REGISTERED` as unrevived feeds.
- **F5 -- the order is pinned by a test with three human overrides in it.**
  `wall-pane-order.test.ts` asserts the exact column contents and three separate
  instructions Jonas gave on 2026-08-20/21 about where SOTU, SHEAF, FLEET and HOST
  VITALS sit relative to each other.
- **F6 -- detached is the same JS context.** `components/popout/popout-window.tsx`
  opens a blank `window.open('')` and portals React into it, adopting the
  stylesheets. Module-scope stores and React state cross the attach/detach
  boundary for free. Two *tabs* do not -- that needs a `storage` event, which
  `use-board-view-config.ts` already demonstrates.
- **F7 -- prior art for persisted panel state is in-tree and consistent.**
  `hooks/use-board-view-config.ts` (versioned key, clamped load, forward
  migration rather than a key bump, `storage` event sync) and
  `components/canvas-mode/use-layout-overrides.ts` (per-user override map,
  localStorage, explicit reset). Copy the first one's shape.
- **F8 -- dnd-kit is already a dependency** (`@dnd-kit/core`, `/sortable`,
  `/utilities`) and `components/ui/sortable-row.tsx` is the extracted
  grip-and-transform primitive that the board lanes, the workspace rail and the
  organize-projects modal all share.

## 3. The three problems that make this more than one card

**H1 -- size classes require a row model the wall does not have.**
`1x2`, `2x2`, `1x4` only mean something against explicit row tracks. Introducing
them turns `.wall-col` from a flex column into a grid area and reinterprets
`grow` and `maxHeight` on thirteen live panes. `grow` (take the leftover column
height) has no meaning in a fixed row grid, and every pane that relies on it
has a body that scrolls to fit. This is the expensive tranche and it must not be
bundled with anything else.

**H2 -- the feed census breaks the moment a pane can be removed or collapsed.**
F4 means the census asks "is every DECLARED feed REGISTERED?". Declaration comes
from the static table; registration comes from a mounted pane calling
`useWallRevive`. Unplace A8 and `pins` is declared forever and registered never,
so `unrevivedWallFeeds()` reports a permanent false alarm. **The census has to be
folded off the PLACED layout, not off the catalog**, and that has to land in the
same tranche as the layout store -- not after it, or the wall ships a resilience
check that cries wolf.

Collapse has the same shape with an extra decision in it: a collapsed pane that
unmounts stops polling (good for cost, bad if you wanted the number warm the
instant you expand it) and drops out of the census. **Recommendation: a collapsed
pane keeps its hook mounted and its header rendered.** It is a height change, not
an unmount. That also makes the card's "collapse *temporarily*" honest -- a
collapsed pane is always visible as a header bar, so it can never go quietly
missing the way a removed one can.

**H3 -- ambient mode wants a different layout, not the same one squashed.**
Ambient (W3) is fullscreen, no chrome, read from across the room, and
`hideInAmbient` is a *static per-pane* decision today. Once a human owns the
layout, "what shows on the TV" and "what shows on my desk" are different
questions, and answering them with one layout plus a per-pane boolean is how you
end up with a wall that is wrong in both modes. **Recommendation: ambient gets its
own named layout** (T6), which is also the answer to "can I have a desk view and
a wall view".

**H4 -- `wall-pane-order.test.ts` changes subject.** Its assertions are about the
registry; after the split they are about the DEFAULT layout. Three of them encode
explicit instructions from Jonas. Re-point them deliberately, in the tranche that
does the split, with the comments intact. Do not quietly delete them.

## 4. Prior art

Verified where a specific claim is made; the lesson column is the reason each one
is here.

| System | What it does | Lesson for the wall |
|---|---|---|
| **Apple WidgetKit** | `WidgetFamily` is a closed enum: `systemSmall`, `systemMedium`, `systemLarge`, `systemExtraLarge`, `systemExtraLargePortrait`, plus `accessoryCircular` / `accessoryRectangular` / `accessoryInline` / `accessoryCorner`. A widget **declares** which families it supports; the system never offers a size the widget cannot render. (verified: `developer.apple.com/documentation/widgetkit/widgetfamily`) | A small closed set of size classes, declared per pane. `sizes: readonly WallSize[]` on the catalog entry, and the size picker only offers what is in it. This is exactly what the card asks for and it is the single most valuable idea here. |
| **macOS Dashboard (2005)** | The literal backside: hovering a widget revealed a small `i` badge, clicking it flipped the widget over to its settings and back. Only widgets with settings showed the badge. | Discover the flip by hover, on the pane chrome. Show the affordance only when there is something behind it. |
| **iOS home screen** | Long-press enters an explicit **edit mode** (jiggle); the `+` gallery is only reachable from inside it; you leave it deliberately. | The wall is a READ surface that people leave open on a second monitor. Always-on drag handles would make an accidental drag a daily event. Edit mode, entered on purpose. |
| **Grafana** | Layout is DATA: each panel carries `gridPos {h, w, x, y}` against a 24-column grid where one `h` unit is 30px, saved in the dashboard JSON. (verified: Grafana "View dashboard JSON model" docs) | Layout as a serialisable value is what makes reset, presets, export and "send me your wall" possible. Design the value first (T1), the UI second. |
| **Home Assistant Lovelace** | Masonry vs sections layouts, a per-card edit dialog, and YAML as an always-available source of truth under the drag UI. | Ship a text escape hatch. A layout you can paste beats a drag interaction you have to get perfect. |
| **react-grid-layout v2** | Draggable + resizable free-form grid with responsive breakpoints; item shape `{i, x, y, w, h, minW, maxW, static, isDraggable, isResizable}`; React 18+, TS rewrite, actively maintained. (verified: repo README) | The library we would take if we wanted free-form. See D1 -- we do not. |
| **gridstack.js / Muuri** | The same free-form-grid category, framework-agnostic. | Same verdict as RGL. |

## 5. Decisions taken

**D1 -- fixed size classes over CSS Grid + dnd-kit. NOT react-grid-layout.**
The card asks for "a set number of sizes... 1x, 1x2, 2x2, 1x4", which is a size
CLASS model, not a free-form gridster. RGL positions absolutely and owns its own
DOM, which fights `.wall-col-scroll` and ambient's fullscreen reflow; it is a new
runtime dep in a surface we deliberately keep out of the index bundle; and a
closed set of classes makes the persisted layout small enough to read and hand
edit. dnd-kit is already here with an extracted primitive (F8).

**D2 -- localStorage first, versioned, in the shape of `use-board-view-config`.**
Same key discipline (`rclaude.wall-layout.v1`), same clamped-and-validated load,
same forward migration rather than a key bump, same `storage` listener so a
second tab follows. `/api/settings` exists but is a single GLOBAL admin-only blob
broadcast to everyone -- wrong grain for a per-viewer layout. Server-side sync is
a T6 concern, not a T1 one.

**D3 -- the backside is UNIVERSAL first, per-pane second.**
F3 says a backside built today would be mostly empty. But there is real content
every pane can fill with zero pane-side work, straight off the catalog entry and
the revive store: size class, column, collapse, ambient visibility, remove, the
pane's feed ids, its poll interval, when it last landed, and a preview of what
its `report()` would copy. That is a backside worth flipping to on day one. Panes
opt into more with a `settings?: ReactNode` slot, the way they already opt into
`tabs`.

**D4 -- a collapsed pane keeps its header and its hook.** See H2.

**D5 -- guests get the default layout and no edit mode.** Falls out of D2: the
layout is per-browser, and the wall is a read surface for a share guest.

Nothing here needs an answer before T1 can start.

## 6. The tranches

Six cards. T1 is the only one with a hard ordering constraint; it is also the one
that is invisible when it lands, which is the point.

| # | Card | What lands | Depends on |
|---|---|---|---|
| **T1** | `wall-layout-as-data` | Catalog / layout split. `useWallLayout` store + localStorage + reset. Census folded off the PLACED layout (H2). `wall-pane-order.test.ts` re-pointed at the default layout (H4). **Render is byte-identical to today.** | -- |
| **T2** | `wall-edit-mode-collapse-reorder` | An explicit edit mode in the wall header. dnd-kit reorder within and across columns. Per-pane collapse chevron in `WallPaneHead`. Both persist through T1. No size classes. | T1 |
| **T3** | `wall-pane-size-classes` | The row model (H1). `WallSize` closed set, `sizes` declared per catalog entry, column span, size picker. Reinterprets `grow` / `maxHeight` on every existing pane. | T1, T2 |
| **T4** | `wall-pane-backside` | The flip. Universal backside per D3, plus an opt-in `settings` slot; A9's metric moves onto it. | T1 (T3 for the size picker; can ship without it) |
| **T5** | `wall-pane-gallery` | The `+`. Browse the catalog, place a pane that is not placed, remove one that is, empty-slot state. | T1, T3 |
| **T6** | `wall-layout-presets` | Named layouts, a separate ambient layout (H3), export/import as text, reset to default, optional cross-device sync. | T1, T3 |

Suggested order: **T1 -> T2 -> T3 -> (T4 ∥ T5) -> T6.**
T4 can jump ahead of T3 if a backside without a size picker is acceptable.

## 7. What this document does not answer

- The exact size-class set. `1x1 / 1x2 / 2x1 / 2x2 / 1x4` is the card's sketch;
  the real set falls out of T3's row height once a row unit is picked against the
  thirteen panes that exist. Deciding it here would be guessing.
- Whether a pane can span columns *of different widths* (A is 5fr, C is 3.2fr).
  A span across unequal tracks is legal CSS and ugly UX. T3 owns it.
- Whether the wall keeps three columns at all once the layout is data.
