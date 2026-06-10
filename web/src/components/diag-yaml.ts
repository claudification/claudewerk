// Simple JSON -> YAML-ish string (no dependency needed). Used by the Diag panel to
// render the diagnostic bundle as readable, copy-friendly YAML.

// A primitive-only array short enough to render inline as `[a, b, c]`, else null.
function inlinePrimitiveArray(arr: unknown[]): string | null {
  if (!arr.every(v => typeof v !== 'object' || v === null)) return null
  const inline = `[${arr.map(v => (typeof v === 'string' ? `"${v}"` : String(v))).join(', ')}]`
  return inline.length < 80 ? inline : null
}

function scalarToYaml(pad: string, obj: unknown): string {
  if (obj === null || obj === undefined) return `${pad}~`
  if (typeof obj === 'boolean' || typeof obj === 'number') return `${pad}${obj}`
  if (typeof obj === 'string') {
    if (obj.includes('\n')) {
      const lines = obj.split('\n').map(l => `${pad}  ${l}`)
      return `${pad}|\n${lines.join('\n')}`
    }
    if (obj.match(/[:#{}[\],&*?|>!%@`]/)) return `${pad}"${obj.replace(/"/g, '\\"')}"`
    return `${pad}${obj}`
  }
  return `${pad}${String(obj)}`
}

function arrayToYaml(pad: string, indent: number, arr: unknown[]): string {
  if (arr.length === 0) return `${pad}[]`
  const inline = inlinePrimitiveArray(arr)
  if (inline) return `${pad}${inline}`
  return arr.map(item => objectArrayItemToYaml(pad, indent, item)).join('\n')
}

function objectArrayItemToYaml(pad: string, indent: number, item: unknown): string {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return `${pad}- ${toYaml(item, 0).trimStart()}`
  }
  const entries = Object.entries(item)
  const first = entries[0]
  const firstLine = first ? `${pad}- ${first[0]}: ${toYaml(first[1], 0).trimStart()}` : `${pad}-`
  const restLines = entries.slice(1).map(([k, v]) => `${pad}  ${k}: ${toYaml(v, indent + 2).trimStart()}`)
  return [firstLine, ...restLines].join('\n')
}

function objectToYaml(pad: string, indent: number, obj: Record<string, unknown>): string {
  const entries = Object.entries(obj)
  if (entries.length === 0) return `${pad}{}`
  return entries.map(([k, v]) => objectEntryToYaml(pad, indent, k, v)).join('\n')
}

function objectEntryToYaml(pad: string, indent: number, k: string, v: unknown): string {
  const isNonEmpty =
    typeof v === 'object' && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)
  if (!isNonEmpty) return `${pad}${k}: ${toYaml(v, 0).trimStart()}`
  if (Array.isArray(v)) {
    const inline = inlinePrimitiveArray(v)
    if (inline) return `${pad}${k}: ${inline}`
  }
  return `${pad}${k}:\n${toYaml(v, indent + 1)}`
}

export function toYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (Array.isArray(obj)) return arrayToYaml(pad, indent, obj)
  if (typeof obj === 'object' && obj !== null) return objectToYaml(pad, indent, obj as Record<string, unknown>)
  return scalarToYaml(pad, obj)
}
