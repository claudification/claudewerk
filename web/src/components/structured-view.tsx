/**
 * Structured-data viewer with a YAML | JSON toggle (YAML by default, for humans).
 *
 * - `coerceStructured` decides data-vs-text (and unwraps JSON-encoded strings).
 * - YAML rendering (and the `yaml` lib it carries) is React.lazy'd so it stays
 *   off the index bundle -- LAZY LOAD covenant.
 * - The chosen format persists in localStorage so it is shared across views.
 *
 * `StructuredView` is the self-contained widget (own toggle). For a dialog that
 * shows several sections under one toggle, use `useStructuredFormat` +
 * `FormatToggle` + `StructuredBody`.
 */

import { lazy, Suspense, useState } from 'react'
import { coerceStructured } from '@/lib/coerce-structured'
import JsonHighlight from './json-highlight'

const YamlHighlight = lazy(() => import('./yaml-highlight'))

export type StructuredFormat = 'yaml' | 'json'
const STORAGE_KEY = 'cw.structuredView.format'

function readFormat(): StructuredFormat {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'json' ? 'json' : 'yaml'
  } catch {
    return 'yaml'
  }
}

export function useStructuredFormat(): [StructuredFormat, (f: StructuredFormat) => void] {
  const [fmt, setFmt] = useState<StructuredFormat>(readFormat)
  function pick(f: StructuredFormat) {
    setFmt(f)
    try {
      localStorage.setItem(STORAGE_KEY, f)
    } catch {
      // ignore (private mode etc.)
    }
  }
  return [fmt, pick]
}

export function FormatToggle({
  fmt,
  onChange,
  note,
}: {
  fmt: StructuredFormat
  onChange: (f: StructuredFormat) => void
  note?: string
}) {
  return (
    <div className="flex items-center gap-1">
      {(['yaml', 'json'] as const).map(f => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wider rounded transition-colors ${
            fmt === f ? 'bg-accent/20 text-accent' : 'text-muted-foreground/50 hover:text-muted-foreground'
          }`}
        >
          {f}
        </button>
      ))}
      {note && <span className="text-[9px] text-muted-foreground/40 ml-1">{note}</span>}
    </div>
  )
}

/** Presentational body -- no toggle. Detects data-vs-text and renders accordingly. */
export function StructuredBody({
  value,
  fmt,
  maxHeight = '50vh',
}: {
  value: unknown
  fmt: StructuredFormat
  maxHeight?: string
}) {
  const coerced = coerceStructured(value)

  if (coerced.kind === 'text') {
    return (
      <pre
        className="whitespace-pre-wrap break-words text-foreground/80 bg-black/20 p-3 overflow-auto"
        style={{ maxHeight }}
      >
        {coerced.text}
      </pre>
    )
  }

  if (fmt === 'yaml') {
    return (
      <Suspense fallback={<div className="text-[10px] text-muted-foreground/50 p-3">loading YAML view...</div>}>
        <YamlHighlight data={coerced.data} maxHeight={maxHeight} />
      </Suspense>
    )
  }
  return <JsonHighlight data={coerced.data} maxHeight={maxHeight} />
}

/** Self-contained: toggle + body, format persisted. */
export function StructuredView({ value, maxHeight }: { value: unknown; maxHeight?: string }) {
  const [fmt, setFmt] = useStructuredFormat()
  const coerced = coerceStructured(value)
  return (
    <div className="flex flex-col gap-1">
      {coerced.kind === 'data' && (
        <FormatToggle
          fmt={fmt}
          onChange={setFmt}
          note={coerced.fromJsonString ? 'parsed from JSON string' : undefined}
        />
      )}
      <StructuredBody value={value} fmt={fmt} maxHeight={maxHeight} />
    </div>
  )
}
