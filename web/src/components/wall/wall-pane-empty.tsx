/**
 * The body a pane stub renders until its own card lands a feed. It says the pane
 * has no data YET, which is a different claim from "there is nothing to show" --
 * a pane with a real feed and nothing in it writes its own empty line.
 */

export function WallPaneEmpty() {
  return <p className="text-meta text-fg-faint px-0.5 py-1">no feed yet</p>
}
