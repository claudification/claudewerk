/**
 * Lazy-loaded CodeMirror editor pane for the file editor.
 *
 * Split out so @uiw/react-codemirror + language packs don't ship in the main
 * chunk. file-editor.tsx renders this behind React.lazy.
 */

import CodeMirror from '@uiw/react-codemirror'
import { buildFileEditorExtensions } from './codemirror-setup'

export default function FileEditorPane({
  content,
  onChange,
  filePath,
}: {
  content: string
  onChange: (value: string) => void
  filePath?: string
}) {
  // Remount on file change to pick up the new language; cheaper than reconfiguring
  // the compartment and matches prior behavior.
  const extensions = buildFileEditorExtensions(filePath)

  return (
    <CodeMirror
      key={filePath ?? ''}
      value={content}
      onChange={onChange}
      extensions={extensions}
      basicSetup={false}
      theme="dark"
      className="flex-1 min-h-0 overflow-hidden"
      height="100%"
    />
  )
}
