/**
 * Renders the tool input a permission gate is asking about.
 *
 * Extracted from `conversation-banners.tsx` when the inline transcript card
 * became a second surface showing the same thing -- a Bash command has to read
 * identically whether you answer it from the banner, the notification panel, or
 * the card sitting at the tool call.
 *
 * `inputPreview` arrives TRUNCATED (the agent host caps it at 200 chars), so a
 * parse failure is the normal case for a long command, not an error: the catch
 * path pulls the known fields out with regex rather than showing nothing.
 */

import type { ReactNode } from 'react'

function relativizeTo(root: string | undefined, p: string): string {
  return root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p
}

/** Long values are clipped rather than allowed to blow out the card. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function CommandBlock({ children }: { children: string }) {
  return (
    <pre className="text-cyan-400 text-[11px] bg-background/50 px-2 py-1 rounded whitespace-pre-wrap">{children}</pre>
  )
}

function ContentBlock({ children }: { children: string }) {
  return (
    <pre className="text-muted-foreground text-[10px] bg-background/50 px-2 py-1 rounded max-h-16 overflow-hidden whitespace-pre-wrap">
      {children}
    </pre>
  )
}

function PathLine({ children }: { children: string }) {
  return <div className="text-amber-300 text-[11px] truncate">{children}</div>
}

/** Generic fallback: every key of the parsed input, one per line. */
function GenericInput({ input, root }: { input: Record<string, unknown>; root?: string }) {
  const entries = Object.entries(input)
  if (entries.length === 0) return null
  return (
    <div className="text-[10px] space-y-0.5">
      {entries.map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v)
        const display = typeof v === 'string' && root ? relativizeTo(root, val) : val
        return (
          <div key={k} className="flex gap-1.5">
            <span className="text-muted-foreground shrink-0">{k}:</span>
            <span className="text-foreground/80 truncate">{String(display).slice(0, 200)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Per-tool shaping of a successfully parsed input. */
const PARSED_RENDERERS: Record<string, (input: Record<string, unknown>, root?: string) => ReactNode> = {
  Write: renderFileWrite,
  Edit: renderFileWrite,
  Bash: (input): ReactNode => {
    const cmd = (input.command || input.cmd) as string | undefined
    return cmd ? <CommandBlock>{cmd}</CommandBlock> : null
  },
  Read: (input, root): ReactNode => {
    const path = (input.file_path || input.path) as string | undefined
    return path ? <div className="text-amber-300 text-[11px]">{relativizeTo(root, path)}</div> : null
  },
}

function renderFileWrite(input: Record<string, unknown>, root?: string): ReactNode {
  const path = (input.file_path || input.path) as string | undefined
  const content = (input.content || input.new_string) as string | undefined
  return (
    <>
      {path && <PathLine>{relativizeTo(root, path)}</PathLine>}
      {content && <ContentBlock>{clip(content, 300)}</ContentBlock>}
    </>
  )
}

function unquote(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"')
}

/** The fields worth salvaging from a preview cut mid-JSON. */
interface Salvaged {
  path?: string
  cmd?: string
  preview?: string
}

function salvageFields(inputPreview: string): Salvaged {
  return {
    path: inputPreview.match(/"file_path"\s*:\s*"([^"]+)"/)?.[1],
    cmd: inputPreview.match(/"command"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)?.[1],
    preview:
      inputPreview.match(/"old_string"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)?.[1] ||
      inputPreview.match(/"content"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)?.[1],
  }
}

/** Same per-tool shaping as the parsed path, over regex-salvaged fields.
 *  A renderer returning null means "nothing salvageable" -> raw fallback. */
const SALVAGE_RENDERERS: Record<string, (f: Salvaged, root?: string) => ReactNode> = {
  Write: renderSalvagedWrite,
  Edit: renderSalvagedWrite,
  Bash: ({ cmd }): ReactNode => (cmd ? <CommandBlock>{unquote(cmd)}</CommandBlock> : null),
  Read: ({ path }, root): ReactNode =>
    path ? <div className="text-amber-300 text-[11px]">{relativizeTo(root, path)}</div> : null,
}

function renderSalvagedWrite({ path, preview }: Salvaged, root?: string): ReactNode {
  if (!path) return null
  return (
    <>
      <PathLine>{relativizeTo(root, path)}</PathLine>
      {preview && <ContentBlock>{clip(unquote(preview), 300)}</ContentBlock>}
    </>
  )
}

/** Salvage from a truncated preview that no longer parses as JSON. */
function renderTruncated(toolName: string, inputPreview: string, root?: string): ReactNode {
  const salvaged = SALVAGE_RENDERERS[toolName]?.(salvageFields(inputPreview), root)
  if (salvaged) return salvaged
  return (
    <pre className="text-muted-foreground text-[10px] bg-background/50 px-2 py-1 rounded overflow-x-auto max-h-20 whitespace-pre-wrap break-all">
      {inputPreview}
    </pre>
  )
}

/**
 * @param root Project path, stripped from absolute file paths so the card shows
 *             `src/foo.ts` instead of the full home-directory prefix.
 */
export function formatPermissionInput(toolName: string, inputPreview: string, root?: string): ReactNode {
  try {
    const input = JSON.parse(inputPreview) as Record<string, unknown>
    const renderer = PARSED_RENDERERS[toolName]
    return renderer ? renderer(input, root) : <GenericInput input={input} root={root} />
  } catch {
    return renderTruncated(toolName, inputPreview, root)
  }
}
