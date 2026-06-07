/**
 * Global registry of live (mounted) xterm.js terminal surfaces, keyed by a
 * caller-chosen id (shellId for host-shells). A mounted XtermPane registers its
 * buffer-reader + container node here so the web debug-control dispatcher can
 * read terminal text and screenshot the terminal from outside React, without
 * threading refs through the component tree. Unmount (minimize / close)
 * unregisters, so the registry always reflects what is actually on screen.
 */

import type { Terminal } from '@xterm/xterm'

export interface XtermRegistryEntry {
  /** Serialize the visible+scrollback buffer to plain text. */
  read: (opts?: { maxLines?: number }) => string
  /** The container element xterm rendered into (for screenshots). */
  node: () => HTMLElement | null
}

const registry = new Map<string, XtermRegistryEntry>()

export function registerXterm(id: string, entry: XtermRegistryEntry): void {
  registry.set(id, entry)
}

export function unregisterXterm(id: string): void {
  registry.delete(id)
}

export function getXterm(id: string): XtermRegistryEntry | undefined {
  return registry.get(id)
}

/** Serialize an xterm buffer (scrollback + viewport) to trimmed text, capped to
 *  the last `maxLines` rows so a huge scrollback can't blow the wire/agent. */
export function serializeXtermBuffer(term: Terminal, maxLines = 2000): string {
  const buf = term.buffer.active
  const total = buf.length
  const start = Math.max(0, total - maxLines)
  const out: string[] = []
  for (let i = start; i < total; i++) {
    const line = buf.getLine(i)
    out.push(line ? line.translateToString(true) : '')
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}
