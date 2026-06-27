/**
 * Syntax-highlighted tool output renderers:
 * DiffView (Edit), WritePreview (Write), ShellCommand (Bash), BashOutput (structured)
 */

import { diffWords } from 'diff'
import { memo, useEffect, useMemo, useState } from 'react'
import JsonHighlight from '@/components/json-highlight'
import { useConversationsStore } from '@/hooks/use-conversations'
import { resolveToolDisplay, type ToolDisplayKey } from '@/lib/control-panel-prefs'
import { cn } from '@/lib/utils'
import { computeDiffHighlight, diffHighlightKey, getCachedDiffHighlight } from './diff-highlight'
import { AnsiText, cleanCdPrefix, cleanReplShCalls, TruncatedPre } from './shared'
import { langFromPath } from './syntax'
import { patchesEqual } from './tool-renderers-utils'
import { useBlockHighlight } from './use-block-highlight'
import { useConversationPath } from './use-conversation-path'

interface DiffLine {
  prefix: string
  content: string
  hunkHeader?: string
  wordDiffs?: Array<{ value: string; added?: boolean; removed?: boolean }>
}

function buildDiffLines(patches: Array<{ oldStart: number; lines: string[] }>): DiffLine[] {
  const allLines: DiffLine[] = []
  for (const patch of patches) {
    allLines.push({ prefix: '', content: '', hunkHeader: `@@ ${patch.oldStart} @@` })
    for (const line of patch.lines) {
      allLines.push({ prefix: line[0] || ' ', content: line.slice(1) })
    }
  }

  // Pair consecutive -/+ runs and compute word-level diffs
  let i = 0
  while (i < allLines.length) {
    if (allLines[i].prefix !== '-') {
      i++
      continue
    }
    const removeStart = i
    while (i < allLines.length && allLines[i].prefix === '-') i++
    const addStart = i
    while (i < allLines.length && allLines[i].prefix === '+') i++
    const addEnd = i

    const removeCount = addStart - removeStart
    const addCount = addEnd - addStart
    if (removeCount === 0 || addCount === 0) continue

    const pairCount = Math.min(removeCount, addCount)
    for (let p = 0; p < pairCount; p++) {
      const oldLine = allLines[removeStart + p]
      const newLine = allLines[addStart + p]
      const diffs = diffWords(oldLine.content, newLine.content)
      const oldDiffs: Array<{ value: string; removed?: boolean }> = []
      const newDiffs: Array<{ value: string; added?: boolean }> = []
      for (const d of diffs) {
        if (!d.added) oldDiffs.push({ value: d.value, removed: d.removed })
        if (!d.removed) newDiffs.push({ value: d.value, added: d.added })
      }
      oldLine.wordDiffs = oldDiffs
      newLine.wordDiffs = newDiffs
    }
  }

  return allLines
}

// Syntax-highlighted diff view for Edit operations.
// Custom memo equality: patches arrays get a fresh ref on every transcript
// rehydrate even when content is identical -- shallow memo would re-run Shiki
// on every render. patchesEqual compares hunks structurally.
export const DiffView = memo(
  function DiffView({
    patches,
    filePath,
  }: {
    patches: Array<{ oldStart: number; lines: string[] }>
    filePath?: string
  }) {
    const lang = filePath ? langFromPath(filePath) : undefined
    const cacheKey = useMemo(
      () => (lang && patches.length > 0 ? diffHighlightKey(lang, patches) : null),
      [lang, patches],
    )
    // Seed synchronously from the content-keyed cache: a REMOUNT (virtualizer
    // key change, e.g. the live-slot swap at turn end) then paints colored on
    // its first frame instead of flashing plain -> colored through the async
    // tokenize round-trip.
    const [highlighted, setHighlighted] = useState<Map<string, string> | null>(() =>
      cacheKey ? (getCachedDiffHighlight(cacheKey) ?? null) : null,
    )
    const [revealed, setRevealed] = useState(false)
    const prefs = useConversationsStore(s => s.controlPanelPrefs)
    const limit = resolveToolDisplay(prefs, 'Edit').lineLimit

    useEffect(() => {
      if (!cacheKey || !lang) return
      const cached = getCachedDiffHighlight(cacheKey)
      if (cached) {
        setHighlighted(prev => (prev === cached ? prev : cached))
        return
      }
      let alive = true
      computeDiffHighlight(cacheKey, lang, patches)
        .then(map => {
          if (alive && map) setHighlighted(map)
        })
        .catch(() => {})
      return () => {
        alive = false
      }
    }, [cacheKey, lang, patches])

    const allLines = useMemo(() => buildDiffLines(patches), [patches])
    const totalLines = allLines.length
    const needsTruncation = limit > 0 && totalLines > limit && !revealed
    const visibleLines = needsTruncation ? allLines.slice(0, limit) : allLines

    return (
      <div>
        <pre className="text-[10px] font-mono overflow-x-auto">
          {visibleLines.map((line, j) => {
            if (line.hunkHeader) {
              return (
                // react-doctor-disable-next-line react-doctor/no-array-index-key
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional, no stable IDs
                <div key={j} className="text-muted-foreground">
                  {line.hunkHeader}
                </div>
              )
            }
            const syntaxHtml = highlighted?.get(line.content)
            return (
              <div
                // react-doctor-disable-next-line react-doctor/no-array-index-key
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional, no stable IDs
                key={j}
                className={cn(line.prefix === '+' && 'bg-green-500/10', line.prefix === '-' && 'bg-red-500/10')}
              >
                <span
                  className={cn(
                    line.prefix === '+' && 'text-green-400',
                    line.prefix === '-' && 'text-red-400',
                    line.prefix !== '+' && line.prefix !== '-' && 'text-muted-foreground',
                  )}
                >
                  {line.prefix}
                </span>
                {line.wordDiffs ? (
                  <WordDiffLine
                    parts={line.wordDiffs}
                    mode={line.prefix === '+' ? 'add' : 'remove'}
                    syntaxHtml={syntaxHtml}
                  />
                ) : syntaxHtml ? (
                  <span
                    // react-doctor-disable-next-line react-doctor/no-danger
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki syntax-highlighter output (trusted)
                    dangerouslySetInnerHTML={{ __html: syntaxHtml }}
                  />
                ) : (
                  <span
                    className={cn(
                      line.prefix === '+' && 'text-green-400',
                      line.prefix === '-' && 'text-red-400',
                      line.prefix !== '+' && line.prefix !== '-' && 'text-muted-foreground',
                    )}
                  >
                    {line.content}
                  </span>
                )}
              </div>
            )
          })}
        </pre>
        {needsTruncation && (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="text-[10px] text-accent hover:text-accent/80 font-mono mt-0.5 px-2"
          >
            +{totalLines - limit} more lines
          </button>
        )}
      </div>
    )
  },
  (a, b) => a.filePath === b.filePath && patchesEqual(a.patches, b.patches),
)

interface SyntaxToken {
  text: string
  color?: string
}

function parseSyntaxHtml(html: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  const re = /<span style="color:(#[0-9A-Fa-f]+)">(.*?)<\/span>/g
  let lastIdx = 0
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (m.index > lastIdx) {
      tokens.push({ text: unescapeHtml(html.slice(lastIdx, m.index)) })
    }
    tokens.push({ text: unescapeHtml(m[2]), color: m[1] })
    lastIdx = re.lastIndex
  }
  if (lastIdx < html.length) {
    tokens.push({ text: unescapeHtml(html.slice(lastIdx)) })
  }
  return tokens
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

interface MergedSegment {
  text: string
  color?: string
  highlight: boolean
}

function mergeSyntaxAndDiffs(
  syntaxTokens: SyntaxToken[],
  diffParts: Array<{ value: string; added?: boolean; removed?: boolean }>,
  mode: 'add' | 'remove',
): MergedSegment[] {
  const result: MergedSegment[] = []
  let si = 0
  let sOff = 0
  let di = 0
  let dOff = 0

  while (si < syntaxTokens.length && di < diffParts.length) {
    const sRemain = syntaxTokens[si].text.length - sOff
    const dRemain = diffParts[di].value.length - dOff
    const take = Math.min(sRemain, dRemain)

    result.push({
      text: syntaxTokens[si].text.slice(sOff, sOff + take),
      color: syntaxTokens[si].color,
      highlight: mode === 'add' ? !!diffParts[di].added : !!diffParts[di].removed,
    })

    sOff += take
    dOff += take
    if (sOff >= syntaxTokens[si].text.length) {
      si++
      sOff = 0
    }
    if (dOff >= diffParts[di].value.length) {
      di++
      dOff = 0
    }
  }

  return result
}

const WordDiffLine = memo(function WordDiffLine({
  parts,
  mode,
  syntaxHtml,
}: {
  parts: Array<{ value: string; added?: boolean; removed?: boolean }>
  mode: 'add' | 'remove'
  syntaxHtml?: string
}) {
  if (syntaxHtml) {
    const syntaxTokens = parseSyntaxHtml(syntaxHtml)
    const merged = mergeSyntaxAndDiffs(syntaxTokens, parts, mode)
    return (
      <span>
        {merged.map((seg, i) => (
          <span
            // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
            // biome-ignore lint/suspicious/noArrayIndexKey: merged segments are positional
            key={i}
            style={seg.color ? { color: seg.color } : undefined}
            className={
              seg.highlight ? (mode === 'add' ? 'bg-green-500/30 rounded-sm' : 'bg-red-500/30 rounded-sm') : undefined
            }
          >
            {seg.text}
          </span>
        ))}
      </span>
    )
  }

  return (
    <span className={mode === 'add' ? 'text-green-400' : 'text-red-400'}>
      {parts.map((part, i) => {
        const isHighlighted = mode === 'add' ? part.added : part.removed
        return (
          <span
            // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
            // biome-ignore lint/suspicious/noArrayIndexKey: word diff parts are positional
            key={i}
            className={
              isHighlighted ? (mode === 'add' ? 'bg-green-500/30 rounded-sm' : 'bg-red-500/30 rounded-sm') : undefined
            }
          >
            {part.value}
          </span>
        )
      })}
    </span>
  )
})

/** Strip leading `# comment` line from shell commands -- redundant with the description field */
function stripLeadingComment(cmd: string): string {
  const m = cmd.match(/^#[^\n]*\\?\s*\n/)
  return m ? cmd.slice(m[0].length) : cmd
}

// Syntax-highlighted shell command block (max 10 lines by default)
export function ShellCommand({ command, maxLines = 10 }: { command: string; maxLines?: number }) {
  const root = useConversationPath()
  const stripped = stripLeadingComment(command)
  const cleaned = root ? cleanCdPrefix(stripped, root) : stripped
  const lines = cleaned.split('\n')
  const truncated = lines.length > maxLines
  const display = truncated ? lines.slice(0, maxLines).join('\n') : cleaned
  const html = useBlockHighlight('shellscript', display)

  return (
    <pre className="text-[10px] bg-black/30 p-2 overflow-auto whitespace-pre-wrap font-mono border-l-2 border-green-500/40">
      <span className="text-green-500/60 select-none">$ </span>
      {html ? (
        <code
          // react-doctor-disable-next-line react-doctor/no-danger
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki syntax-highlighter output (trusted)
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <span className="text-foreground/80">{display}</span>
      )}
      {truncated && <span className="text-muted-foreground/40">{`\n... ${lines.length - maxLines} more lines`}</span>}
    </pre>
  )
}

// Syntax-highlighted preview for Write operations
export function WritePreview({ content, filePath }: { content: string; filePath?: string }) {
  const [revealed, setRevealed] = useState(false)
  const writePrefs = useConversationsStore(s => s.controlPanelPrefs)
  const writeDisplay = resolveToolDisplay(writePrefs, 'Write')
  const limit = writeDisplay.lineLimit
  const truncated = content.length > 3000 ? content.slice(0, 3000) : content
  const lines = truncated.split('\n')
  const lineTruncate = limit > 0 && lines.length > limit && !revealed
  const html = useBlockHighlight(filePath ? langFromPath(filePath) : undefined, truncated)

  const gutterWidth = String(lines.length).length
  const visibleLines = lineTruncate ? limit : lines.length
  const htmlLines = html ? html.split('\n') : null

  return (
    <div>
      <pre className="text-[10px] font-mono overflow-x-auto">
        {htmlLines ? (
          <code>
            {htmlLines.slice(0, visibleLines).map((lineHtml, i) => (
              // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
              // biome-ignore lint/suspicious/noArrayIndexKey: file lines are positional, no stable IDs
              <div key={i} className="hover:bg-muted/20">
                <span
                  className="text-muted-foreground/40 select-none inline-block text-right mr-3"
                  style={{ width: `${gutterWidth + 1}ch` }}
                >
                  {i + 1}
                </span>
                <span
                  // react-doctor-disable-next-line react-doctor/no-danger
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki syntax-highlighter output (trusted)
                  dangerouslySetInnerHTML={{ __html: lineHtml }}
                />
              </div>
            ))}
          </code>
        ) : (
          <code className="text-foreground/70">
            {lines.slice(0, visibleLines).map((line, i) => (
              // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
              // biome-ignore lint/suspicious/noArrayIndexKey: file lines are positional, no stable IDs
              <div key={i} className="hover:bg-muted/20">
                <span
                  className="text-muted-foreground/40 select-none inline-block text-right mr-3"
                  style={{ width: `${gutterWidth + 1}ch` }}
                >
                  {i + 1}
                </span>
                {line}
              </div>
            ))}
          </code>
        )}
        {!lineTruncate && content.length > 3000 && (
          <div className="text-muted-foreground mt-1">... +{content.length - 3000} chars truncated</div>
        )}
      </pre>
      {lineTruncate && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-[10px] text-accent hover:text-accent/80 font-mono mt-0.5 px-2"
        >
          +{lines.length - limit} more lines
        </button>
      )}
    </div>
  )
}

// Parse structured bash output with <bash-input>, <bash-stdout>, <bash-stderr> tags
interface BashParts {
  input?: string
  stdout?: string
  stderr?: string
}

function parseBashTags(result: string): BashParts | null {
  const hasTag = /<bash-(input|stdout|stderr)>/.test(result)
  if (!hasTag) return null

  function extract(tag: string): string | undefined {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
    const m = result.match(re)
    return m ? m[1] : undefined
  }

  return {
    input: extract('bash-input'),
    stdout: extract('bash-stdout'),
    stderr: extract('bash-stderr'),
  }
}

// Structured bash output renderer - separates input/stdout/stderr
// Checks XML tags in result string first, falls back to extra.stdout/stderr
export function BashOutput({
  result,
  command,
  extra,
}: {
  result: string
  command?: string
  extra?: Record<string, unknown>
}) {
  const parts = parseBashTags(result)

  // Fallback: CC may put stdout/stderr in toolUseResult instead of XML tags
  const extraStdout = extra?.stdout as string | undefined
  const extraStderr = extra?.stderr as string | undefined

  if (!parts) {
    const hasExtra = extraStdout?.trim() || extraStderr?.trim()
    if (hasExtra) {
      return (
        <div className="space-y-1">
          {command && <ShellCommand command={command.trim()} />}
          {extraStdout?.trim() && <TruncatedPre text={extraStdout.trim()} tool="Bash" />}
          {extraStderr?.trim() && (
            <div className="border-l-2 border-red-500/40">
              <TruncatedPre text={extraStderr.trim()} tool="Bash" />
            </div>
          )}
        </div>
      )
    }
    return (
      <div className="space-y-1">
        {command && <ShellCommand command={command.trim()} />}
        {result && <TruncatedPre text={result} tool="Bash" />}
      </div>
    )
  }

  const hasStdout = parts.stdout && parts.stdout.trim().length > 0
  const hasStderr = parts.stderr && parts.stderr.trim().length > 0
  const displayCommand = parts.input || command

  return (
    <div className="space-y-1">
      {displayCommand && <ShellCommand command={displayCommand.trim()} />}
      {hasStdout && parts.stdout && <TruncatedPre text={parts.stdout.trim()} tool="Bash" />}
      {hasStderr && parts.stderr && (
        <div className="border-l-2 border-red-500/40">
          <TruncatedPre text={parts.stderr.trim()} tool="Bash" />
        </div>
      )}
      {!hasStdout && !hasStderr && !displayCommand && (
        <pre className="text-[10px] bg-black/30 p-2 font-mono text-muted-foreground">(no output)</pre>
      )}
    </div>
  )
}

// REPL code block - always visible, JS syntax highlighted
export function ReplView({ code, isError }: { code: string; isError?: boolean }) {
  const replPrefs = useConversationsStore(s => s.controlPanelPrefs)
  const replDisplay = resolveToolDisplay(replPrefs, 'REPL' as ToolDisplayKey)
  const lineLimit = replDisplay.lineLimit
  const [revealed, setRevealed] = useState(false)
  const root = useConversationPath()
  const displayCode = root ? cleanReplShCalls(code, root) : code
  const codeHtml = useBlockHighlight('javascript', displayCode)

  const codeLines = displayCode.split('\n')
  const codeTruncate = lineLimit > 0 && codeLines.length > lineLimit && !revealed
  const visibleCodeLines = codeTruncate ? lineLimit : codeLines.length
  const htmlLines = codeHtml ? codeHtml.split('\n') : null

  return (
    <div className="mt-1">
      <pre
        className={cn(
          'text-[10px] font-mono overflow-x-auto rounded px-2.5 py-1.5',
          isError ? 'bg-red-500/5' : 'bg-indigo-500/5',
        )}
      >
        {htmlLines ? (
          <code>
            {htmlLines.slice(0, visibleCodeLines).map((lineHtml, i) => (
              <div
                key={i}
                className="hover:bg-muted/20"
                // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key, react-doctor/no-danger
                // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki syntax-highlighter output (trusted)
                dangerouslySetInnerHTML={{ __html: lineHtml }}
              />
            ))}
          </code>
        ) : (
          <code className="text-foreground/70">
            {codeLines.slice(0, visibleCodeLines).map((line, i) => (
              // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
              // biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional
              <div key={i} className="hover:bg-muted/20">
                {line}
              </div>
            ))}
          </code>
        )}
      </pre>
      {codeTruncate && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-[10px] text-accent hover:text-accent/80 font-mono mt-0.5 px-2"
        >
          +{codeLines.length - lineLimit} more lines
        </button>
      )}
    </div>
  )
}

// REPL result/stdout/stderr - shown inside Collapsible (hidden by default)
export function ReplResult({ result, extra }: { result?: string; extra?: Record<string, unknown> }) {
  const structuredResult = extra?.result
  const stdout = extra?.stdout as string | undefined
  const stderr = extra?.stderr as string | undefined
  const hasStdout = stdout && stdout.trim().length > 0
  const hasStderr = stderr && stderr.trim().length > 0

  let resultContent: React.ReactNode = null
  if (structuredResult && typeof structuredResult === 'object') {
    resultContent = (
      <div className="text-[10px] font-mono bg-black/30 rounded px-2.5 py-2 overflow-x-auto">
        <pre className="whitespace-pre-wrap">
          <JsonHighlight data={structuredResult} />
        </pre>
      </div>
    )
  } else if (result) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(result)
    } catch {}
    if (parsed && typeof parsed === 'object') {
      resultContent = (
        <div className="text-[10px] font-mono bg-black/30 rounded px-2.5 py-2 overflow-x-auto">
          <pre className="whitespace-pre-wrap">
            <JsonHighlight data={parsed} />
          </pre>
        </div>
      )
    } else {
      resultContent = <TruncatedPre text={result} tool={'REPL' as ToolDisplayKey} />
    }
  }

  return (
    <div className="space-y-1.5">
      {resultContent}
      {hasStdout && (
        <div>
          <div className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider mb-0.5">stdout</div>
          <pre className="text-[10px] font-mono bg-black/20 rounded px-2.5 py-1.5 overflow-x-auto whitespace-pre-wrap text-foreground/70">
            <AnsiText text={stdout} />
          </pre>
        </div>
      )}
      {hasStderr && (
        <div>
          <div className="text-[9px] font-mono text-red-400/50 uppercase tracking-wider mb-0.5">stderr</div>
          {/* intentional visual treatment for the stderr block (UI design call) */}
          {/* biome-ignore lint/suspicious/noCommentText: react-doctor directive */}
          // react-doctor-disable-next-line react-doctor/no-side-tab-border
          <pre className="text-[10px] font-mono bg-red-500/5 border-l-2 border-red-500/40 rounded px-2.5 py-1.5 overflow-x-auto whitespace-pre-wrap text-red-400/80">
            <AnsiText text={stderr} />
          </pre>
        </div>
      )}
    </div>
  )
}
