import { memo, useEffect, useMemo, useState } from 'react'
import { toYaml } from './diag-yaml'
import { ensureLang, getHighlighter } from './transcript/syntax'

interface DiagViewProps {
  conversationId: string
}

// Shiki highlighter singleton (shared with transcript via static import)
let highlightPromise: Promise<{ codeToHtml: (code: string, opts: { lang: string; theme: string }) => string }> | null =
  null

function getDiagHighlighter() {
  if (!highlightPromise) {
    highlightPromise = getHighlighter()
  }
  return highlightPromise
}

// Memoized: the diag bundle is a one-shot fetch keyed on conversationId and never
// consumes the live transcript/event stream. Without memo, every conversation_update
// (token samples, status flips during active work) re-renders the parent
// (ConversationDetail -> TabContentPanels) and cascades into here, re-running the Shiki
// highlight reconciliation and clobbering the user's text selection -- making the
// panel impossible to copy from. conversationId is a stable string, so memo fully
// isolates this panel from the per-message render storm.
export const DiagView = memo(function DiagView({ conversationId }: DiagViewProps) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const mnemonic = `diag:${conversationId}`

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    setData(null)
    setError(null)
    setHighlighted(null)
    fetch(`/conversations/${conversationId}/diag`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then(setData)
      .catch(e => setError(String(e)))
  }, [conversationId])

  const yaml = useMemo(() => (data ? toYaml(data) : ''), [data])

  useEffect(() => {
    if (!yaml) return
    ensureLang('yaml')
      .then(() => getDiagHighlighter())
      .then(hl => {
        const html = hl.codeToHtml(yaml, { lang: 'yaml', theme: 'tokyo-night' })
        setHighlighted(html)
      })
      .catch(() => {})
  }, [yaml])

  function handleCopy() {
    const text = `# ${mnemonic}\n\n${yaml}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function handleCopyMnemonic() {
    navigator.clipboard.writeText(mnemonic)
  }

  if (error) {
    return <div className="p-4 text-red-400 font-mono text-xs">{error}</div>
  }

  if (!data) {
    return <div className="p-4 text-muted-foreground font-mono text-xs">Loading…</div>
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <DiagToolbar mnemonic={mnemonic} copied={copied} onCopy={handleCopy} onCopyMnemonic={handleCopyMnemonic} />
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {highlighted ? (
          <div
            className="text-[11px] font-mono [&_pre]:!bg-transparent [&_code]:!bg-transparent"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki syntax highlighter output (trusted)
            // react-doctor-disable-next-line react-doctor/no-danger
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <pre className="text-[11px] font-mono text-foreground/90 whitespace-pre-wrap">{yaml}</pre>
        )}
      </div>
    </div>
  )
})

interface DiagToolbarProps {
  mnemonic: string
  copied: boolean
  onCopy: () => void
  onCopyMnemonic: () => void
}

function DiagToolbar({ mnemonic, copied, onCopy, onCopyMnemonic }: DiagToolbarProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
      <button
        type="button"
        onClick={onCopyMnemonic}
        className="font-mono text-[11px] text-muted-foreground hover:text-accent transition-colors cursor-pointer select-all"
        title="Click to copy mnemonic"
      >
        {mnemonic}
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onCopy}
        className="px-2 py-1 text-[10px] font-mono border border-border hover:border-accent hover:text-accent text-muted-foreground transition-colors"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )
}
