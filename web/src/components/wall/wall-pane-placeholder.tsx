/**
 * The body every pane renders until its own card lands a real feed.
 *
 * Default export on purpose: it is what `WallPaneSpec.load` resolves to, and
 * React.lazy only speaks default exports.
 */

// fallow-ignore-next-line unused-export -- reached only through WallPaneSpec.load's dynamic import()
export default function WallPanePlaceholder() {
  return <p className="text-meta text-fg-faint px-0.5 py-1">no feed yet</p>
}
