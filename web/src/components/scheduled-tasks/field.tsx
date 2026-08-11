/** The editor's label+control pair, shared by every tab so the BASIC and WHERE
 *  sections cannot drift apart visually. */

import type React from 'react'

export const INPUT_CLASS =
  'w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50'

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">{label}</div>
      {children}
    </div>
  )
}
