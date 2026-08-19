/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { clipboardFiles } from './use-dialog-paste'

function file(name: string, type = 'image/png'): File {
  return new File(['x'], name, { type })
}

/** Minimal DataTransfer-ish stub: items (with kind + getAsFile) and a files list. */
function dt(opts: { items?: Array<{ kind: string; file?: File }>; files?: File[] }): DataTransfer {
  return {
    items: (opts.items ?? []).map(i => ({ kind: i.kind, getAsFile: () => i.file ?? null })),
    files: opts.files ?? [],
  } as unknown as DataTransfer
}

describe('clipboardFiles', () => {
  it('prefers file ITEMS (the screenshot path, which has no .files entry)', () => {
    const f = file('shot.png')
    const out = clipboardFiles(dt({ items: [{ kind: 'file', file: f }] }))
    expect(out).toEqual([f])
  })

  it('ignores string items (plain text paste yields no files)', () => {
    expect(clipboardFiles(dt({ items: [{ kind: 'string' }] }))).toEqual([])
  })

  it('falls back to the files list when there are no file items', () => {
    const f = file('doc.pdf', 'application/pdf')
    expect(clipboardFiles(dt({ items: [{ kind: 'string' }], files: [f] }))).toEqual([f])
  })

  it('returns [] for a null DataTransfer', () => {
    expect(clipboardFiles(null)).toEqual([])
  })
})
