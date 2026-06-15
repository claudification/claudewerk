/**
 * README section for the ProjectActionPanel. Fetches the project-root
 * README.md THROUGH THE SENTINEL (project-scoped, no live conversation) and
 * renders a collapsible inline preview at the bottom of the panel. A "Full
 * screen" button opens the shared markdown viewer modal for the whole
 * document. Renders nothing when the project has no README.
 */

import { useEffect, useState } from 'react'
import { useMarkdownViewer } from '@/hooks/use-markdown-viewer'
import { readProjectFile } from '@/hooks/use-project-tasks'
import { haptic } from '@/lib/utils'
import { Markdown } from '../markdown'

// Inline preview cap -- the full document opens in the modal, which does its
// own (1 MB) read. Keep the panel chunk light.
const PREVIEW_BYTES = 32_000

export function ProjectReadmeSection({ projectUri }: { projectUri: string }) {
  const openViewer = useMarkdownViewer(s => s.open)
  const [content, setContent] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setTruncated(false)
    void readProjectFile(projectUri, 'README.md', PREVIEW_BYTES).then(res => {
      if (cancelled) return
      if (res.ok && res.content?.trim()) {
        setContent(res.content)
        setTruncated(!!res.truncated)
      }
    })
    return () => {
      cancelled = true
    }
  }, [projectUri])

  // No README (or empty) -> show nothing.
  if (content === null) return null

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            setCollapsed(c => !c)
          }}
          className="text-[10px] text-sky-400/70 font-bold uppercase tracking-wider flex items-center gap-2 flex-1 min-w-0"
        >
          <span className="shrink-0 w-2 text-left">{collapsed ? '▸' : '▾'}</span>
          <span>Readme</span>
          <span className="flex-1 h-px bg-sky-400/20" />
        </button>
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            openViewer(projectUri, 'README.md')
          }}
          className="text-[10px] font-mono text-sky-400/70 hover:text-sky-400 transition-colors shrink-0"
        >
          FULL SCREEN
        </button>
      </div>
      {!collapsed && (
        <div className="max-h-80 overflow-y-auto border border-border px-3 py-2 text-[13px]">
          <Markdown>{content}</Markdown>
          {truncated && (
            <button
              type="button"
              onClick={() => {
                haptic('tap')
                openViewer(projectUri, 'README.md')
              }}
              className="mt-2 text-[10px] font-mono text-sky-400/70 hover:text-sky-400 transition-colors"
            >
              Truncated -- open full README
            </button>
          )}
        </div>
      )}
    </div>
  )
}
