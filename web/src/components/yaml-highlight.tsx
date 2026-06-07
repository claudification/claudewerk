/**
 * Human-friendly YAML view of structured data, with color coding.
 *
 * Default export + the only module that statically imports the `yaml` lib, so it
 * is loaded lazily (off the index bundle) per the LAZY LOAD covenant -- consumers
 * pull it in via React.lazy() only when the YAML format is actually shown.
 *
 * Block scalars (multi-line strings -- file contents, task summaries, tool
 * output) are the whole point: JSON crams them onto one escaped line, YAML shows
 * them as real text.
 */

import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { stringify } from 'yaml'

// `^(indent)(optional "- ")(key):(space or EOL)` -- key stops at the first colon.
const KEY_RE = /^(\s*)(- )?([^:#\s][^:]*?):(\s|$)/
const LIST_RE = /^(\s*)- (.*)$/
const BLOCK_RE = /^[|>][+-]?\d*\s*(#.*)?$/

function scalarClass(raw: string): string {
  const t = raw.trim()
  if (t === '') return 'text-muted-foreground'
  if (t === 'null' || t === '~') return 'text-red-400'
  if (t === 'true' || t === 'false') return 'text-amber-400'
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return 'text-cyan-400'
  return 'text-green-400'
}

function plainLine(line: string, key: number, cls: string): ReactElement {
  return (
    <div key={key} className={`${cls} whitespace-pre-wrap break-words`}>
      {line || ' '}
    </div>
  )
}

function keyLine(m: RegExpExecArray, value: string, key: number): ReactElement {
  const [, lead, dash, k] = m
  return (
    <div key={key} className="whitespace-pre-wrap break-words">
      <span>{lead}</span>
      {dash && <span className="text-muted-foreground">- </span>}
      <span className="text-purple-400">{k}</span>
      <span className="text-muted-foreground">:</span>
      {value !== '' && <span className={scalarClass(value)}> {value}</span>}
    </div>
  )
}

function listLine(lm: RegExpExecArray, key: number): ReactElement {
  return (
    <div key={key} className="whitespace-pre-wrap break-words">
      <span>{lm[1]}</span>
      <span className="text-muted-foreground">- </span>
      <span className={scalarClass(lm[2])}>{lm[2]}</span>
    </div>
  )
}

function colorize(src: string): ReactElement[] {
  // When inside a block scalar, more-indented lines are raw literal content and
  // must NOT be parsed as key/value pairs.
  let blockIndent: number | null = null

  return src.split('\n').map((line, i) => {
    const indent = line.length - line.trimStart().length
    const inBlock = blockIndent !== null && (line.trim() === '' || indent > blockIndent)
    if (inBlock) return plainLine(line, i, 'text-green-400/90')
    blockIndent = null

    const m = KEY_RE.exec(line)
    if (m) {
      const value = line.slice(m[0].length)
      if (BLOCK_RE.test(value.trim())) blockIndent = indent
      return keyLine(m, value, i)
    }

    const lm = LIST_RE.exec(line)
    if (lm) return listLine(lm, i)

    return plainLine(line, i, 'text-foreground/80')
  })
}

export default function YamlHighlight({ data, maxHeight = '50vh' }: { data: unknown; maxHeight?: string }) {
  const rendered = useMemo(() => {
    let text: string
    try {
      text = stringify(data, { lineWidth: 0 })
    } catch {
      text = String(data)
    }
    return colorize(text)
  }, [data])
  return (
    <pre className="bg-black/20 p-3 overflow-auto leading-relaxed" style={{ maxHeight }}>
      {rendered}
    </pre>
  )
}
