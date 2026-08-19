import { EditDiff } from './edit-diff'
import { cleanCdPrefix } from './shared'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import { fileLabel, filePreview } from './tool-file-view'
import { BashOutput, DiffView, ReplResult, ReplView, ShellCommand } from './tool-renderers'

export function renderBash({
  input,
  result,
  toolUseResult,
  conversationPath,
  expandAll,
}: ToolCaseInput): ToolCaseResult {
  const cmd = input.command as string
  const bashDesc = input.description as string | undefined
  const displayCmd = conversationPath && cmd ? cleanCdPrefix(cmd, conversationPath) : cmd
  const summary = bashDesc || (displayCmd?.length > 80 && !expandAll ? `${displayCmd.slice(0, 80)}...` : displayCmd)
  let details = null
  if (result || toolUseResult?.stdout) {
    details = <BashOutput result={result || ''} command={cmd} extra={toolUseResult} />
  } else if (cmd) {
    details = <ShellCommand command={cmd} />
  }
  return { summary, details }
}

export function renderRepl({ input, result, toolUseResult, isError }: ToolCaseInput): ToolCaseResult {
  const replDesc = input.description as string | undefined
  const replCode = input.code as string
  const summary = replDesc || (replCode?.length > 80 ? `${replCode.slice(0, 80)}...` : replCode)
  let inlineContent = null
  let details = null
  if (replCode) {
    inlineContent = <ReplView code={replCode} isError={isError} />
    const hasResult = result || toolUseResult?.result
    const hasStdout = toolUseResult?.stdout && (toolUseResult.stdout as string).trim()
    const hasStderr = toolUseResult?.stderr && (toolUseResult.stderr as string).trim()
    if (hasResult || hasStdout || hasStderr) {
      details = <ReplResult result={result} extra={toolUseResult} />
    }
  }
  return { summary, details, inlineContent }
}

export function renderEdit({ input, toolUseResult, isError }: ToolCaseInput): ToolCaseResult {
  const path = input.path as string
  const oldText = input.oldText as string | undefined
  const newText = input.newText as string | undefined
  const summary = fileLabel(path)
  let details = null
  if (!isError) {
    const patches = (toolUseResult as { structuredPatch?: Array<{ oldStart: number; lines: string[] }> })
      ?.structuredPatch
    if (patches?.length) {
      details = <DiffView patches={patches} filePath={path} />
    } else if (oldText && newText) {
      const originalFile = (toolUseResult as { originalFile?: string })?.originalFile
      details = <EditDiff oldText={oldText} newText={newText} originalFile={originalFile} filePath={path} />
    }
  }
  return { summary, details }
}

export function renderWrite({ input }: ToolCaseInput): ToolCaseResult {
  const path = input.path as string
  const content = input.content as string
  const summary = (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate text-foreground/90">{fileLabel(path)}</span>
      <span className="text-fg-dim shrink-0">({content?.length || 0} chars)</span>
    </span>
  )
  let details = null
  if (content) {
    details = filePreview(path, content)
  }
  return { summary, details }
}
