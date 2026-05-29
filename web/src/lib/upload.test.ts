import { afterEach, describe, expect, test, vi } from 'vitest'
import { uploadFileWithPlaceholder } from './upload'

function mockUpload(filename: string, url: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ filename, url }) }) as unknown as Response),
  )
}

function run() {
  let text = ''
  const insert = (p: string) => {
    text = p
  }
  const replace = (search: string, replacement: string) => {
    text = text.replace(search, replacement)
  }
  return { insert, replace, read: () => text }
}

afterEach(() => vi.unstubAllGlobals())

describe('uploadFileWithPlaceholder markdown syntax', () => {
  test('image (by MIME) gets ![](url) embed syntax', async () => {
    mockUpload('shot.png', '/files/shot.png')
    const { insert, replace, read } = run()
    await uploadFileWithPlaceholder(new File(['x'], 'shot.png', { type: 'image/png' }), insert, replace)
    expect(read()).toBe('![shot.png](/files/shot.png)')
  })

  test('non-image (PDF) gets plain [](url) link, no bang', async () => {
    mockUpload('doc.pdf', '/files/doc.pdf')
    const { insert, replace, read } = run()
    await uploadFileWithPlaceholder(new File(['x'], 'doc.pdf', { type: 'application/pdf' }), insert, replace)
    expect(read()).toBe('[doc.pdf](/files/doc.pdf)')
  })

  test('type-less file falls back to extension for image detection', async () => {
    mockUpload('pic.jpg', '/files/pic.jpg')
    const { insert, replace, read } = run()
    await uploadFileWithPlaceholder(new File(['x'], 'pic.jpg', { type: '' }), insert, replace)
    expect(read()).toBe('![pic.jpg](/files/pic.jpg)')
  })

  test('type-less non-image extension stays a plain link', async () => {
    mockUpload('notes.txt', '/files/notes.txt')
    const { insert, replace, read } = run()
    await uploadFileWithPlaceholder(new File(['x'], 'notes.txt', { type: '' }), insert, replace)
    expect(read()).toBe('[notes.txt](/files/notes.txt)')
  })
})
