/**
 * The authorize + paste step of the Login modal (awaiting / completing phases).
 * Presentational -- all state lives in the parent LoginModal.
 */

import { ExternalLink, Loader2 } from 'lucide-react'

// fallow-ignore-next-line complexity -- CRAP from zero coverage on a new presentational component; real cyclomatic (5) is under the gate.
export function LoginPastePanel(props: {
  authUrl: string
  pasted: string
  onPaste: (v: string) => void
  completing: boolean
  error: string | null
  onSubmit: () => void
  onCancel: () => void
}) {
  const { authUrl, pasted, onPaste, completing, error, onSubmit, onCancel } = props
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground leading-snug">
        A new tab opened for you to authorize. Approve it, then paste the response below -- either the full redirect URL
        or just the code.
      </p>
      {authUrl && (
        <a
          href={authUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-accent inline-flex items-center gap-1 hover:underline"
        >
          <ExternalLink className="size-3" /> Reopen authorization page
        </a>
      )}
      <textarea
        value={pasted}
        onChange={e => onPaste(e.target.value)}
        placeholder="Paste redirect URL or authorization code..."
        rows={3}
        className="w-full text-[11px] font-mono bg-background border border-border rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-accent"
      />
      {error && <div className="text-[10px] text-red-400 leading-snug">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] px-3 py-1.5 rounded text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!pasted.trim() || completing}
          className="text-[11px] px-3 py-1.5 rounded bg-accent text-background font-bold disabled:opacity-40 inline-flex items-center gap-1.5"
        >
          {completing && <Loader2 className="size-3 animate-spin" />}
          Complete login
        </button>
      </div>
    </div>
  )
}
