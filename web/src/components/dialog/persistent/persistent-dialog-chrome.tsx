/**
 * THE DIALOGUE — static chrome for the persistent dialog: the read-only footer
 * notes and the FooterNote primitive. Split out of persistent-dialog.tsx to keep
 * that component under the size bar.
 */

// react-doctor:only-export-components -- READONLY_NOTE is a tiny constant
// tightly coupled to FooterNote; splitting them hurts readability.
export const READONLY_NOTE: Record<string, string> = {
  orphaned: 'The agent is gone -- this dialog is read-only.',
  closed: 'Closed. Dismiss it with the X, or the agent can reopen it.',
}

export function FooterNote({ text }: { text: string }) {
  return (
    <div className="rounded border border-border/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{text}</div>
  )
}
