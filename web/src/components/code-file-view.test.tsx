import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { CodeFileView } from './code-file-view'

afterEach(cleanup)

describe('CodeFileView', () => {
  test('renders one .code-line per source line, blank lines included', () => {
    const { container } = render(<CodeFileView content={'const a = 1\n\nconst b = 2'} relPath="src/x.ts" />)
    expect(container.querySelectorAll('.code-line')).toHaveLength(3)
  })

  test('line numbers stay OUT of the text content (CSS counter, not DOM text)', () => {
    // The whole point of the ::before gutter: selecting the file must copy the
    // code, not "1const a = 1\n2const b = 2".
    const { container } = render(<CodeFileView content={'const a = 1\nconst b = 2'} relPath="src/x.ts" />)
    expect(container.querySelector('.code-file-lines')?.textContent).toBe('const a = 1const b = 2')
  })

  test('the gutter width var scales with the line count', () => {
    const { container } = render(<CodeFileView content={Array(120).fill('x').join('\n')} relPath="src/x.ts" />)
    expect(container.querySelector<HTMLElement>('.code-file-lines')?.style.getPropertyValue('--code-gutter-w')).toBe(
      '3ch',
    )
  })

  test('the plain (unhighlighted) fallback escapes HTML instead of injecting it', () => {
    // .txt has no shiki language, so this file NEVER leaves the fallback path.
    const { container } = render(<CodeFileView content={'<img src=x onerror=boom>'} relPath="notes.txt" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.code-line')?.textContent).toBe('<img src=x onerror=boom>')
  })
})
