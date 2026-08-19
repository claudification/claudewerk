/**
 * @vitest-environment node
 */
import { Marked } from 'marked'
import { describe, expect, test } from 'vitest'

// Replicate the exact `==highlight==` setup from markdown.tsx (mirrors the
// strikethrough test's approach: same preprocess hook, same extension shape).
const marked = new Marked()
marked.setOptions({ gfm: true, async: false })

marked.use({
  hooks: {
    preprocess(src: string) {
      const parts = src.split(/(^```[^\n]*\n[\s\S]*?\n```$|`[^`\n]+`)/gm)
      return parts
        .map((part, i) => {
          if (i % 2 === 1) return part
          return part.replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?)>/g, '&lt;$1&gt;')
        })
        .join('')
    },
  },
})

marked.use({
  extensions: [
    {
      name: 'mark',
      level: 'inline' as const,
      start(src: string) {
        return src.indexOf('==')
      },
      tokenizer(src: string) {
        const match = src.match(/^==(?!=)(\S[\s\S]{0,198}?\S|\S)==(?!=)/)
        if (!match) return undefined
        const token = { type: 'mark', raw: match[0], text: match[1], tokens: [] as any[] }
        ;(this as any).lexer.inlineTokens(match[1], token.tokens)
        return token
      },
      renderer(token: any) {
        return `<mark>${this.parser.parseInline(token.tokens)}</mark>`
      },
    },
  ],
})

function render(input: string): string {
  return (marked.parse(input) as string).trim()
}

function hasMark(input: string): boolean {
  return render(input).includes('<mark>')
}

function getMarked(input: string): string | null {
  const match = render(input).match(/<mark>(.*?)<\/mark>/)
  return match ? match[1] : null
}

describe('highlight rendering', () => {
  describe('valid highlight', () => {
    test('basic ==word==', () => {
      expect(getMarked('==hello==')).toBe('hello')
    })

    test('==multiple words==', () => {
      expect(getMarked('==Got it. I see it.==')).toBe('Got it. I see it.')
    })

    test('mid-sentence', () => {
      expect(getMarked('before ==lit== after')).toBe('lit')
    })

    test('single character', () => {
      expect(getMarked('==x==')).toBe('x')
    })

    test('two in one line', () => {
      const html = render('==one== and ==two==')
      expect(html).toContain('<mark>one</mark>')
      expect(html).toContain('<mark>two</mark>')
    })

    test('nested bold', () => {
      const html = render('==**bold lit**==')
      expect(html).toContain('<mark>')
      expect(html).toContain('<strong>bold lit</strong>')
    })

    test('code inside mark', () => {
      const html = render('==has `code` inside==')
      expect(html).toContain('<mark>')
      expect(html).toContain('<code>code</code>')
    })

    test('followed by punctuation', () => {
      expect(hasMark('==lit==.')).toBe(true)
      expect(hasMark('(==lit==)')).toBe(true)
    })

    test('content at 200 chars matches', () => {
      expect(hasMark(`==${'x'.repeat(200)}==`)).toBe(true)
    })
  })

  describe('rejected - no highlight', () => {
    test('JS strict equality: a === b', () => {
      expect(hasMark('if (a === b) return')).toBe(false)
    })

    test('loose equality with spaces: a == b == c', () => {
      expect(hasMark('a == b and c == d')).toBe(false)
    })

    test('ascii rule: ======', () => {
      expect(hasMark('======')).toBe(false)
    })

    test('single equals: =hello=', () => {
      expect(hasMark('=hello=')).toBe(false)
    })

    test('content starts with space', () => {
      expect(hasMark('== spaced==')).toBe(false)
    })

    test('content ends with space', () => {
      expect(hasMark('==spaced ==')).toBe(false)
    })

    test('unmatched opening', () => {
      expect(hasMark('==hello')).toBe(false)
    })

    test('empty: ====', () => {
      expect(hasMark('====')).toBe(false)
    })

    test('content at 201 chars does NOT match', () => {
      expect(hasMark(`==${'x'.repeat(201)}==`)).toBe(false)
    })

    test('inside inline code', () => {
      const html = render('`==not lit==`')
      expect(html).not.toContain('<mark>')
      expect(html).toContain('==not lit==')
    })

    test('inside fenced code block', () => {
      const html = render('```\n==not lit==\n```')
      expect(html).not.toContain('<mark>')
    })

    test('shell env assignment: FOO==bar (unpaired)', () => {
      expect(hasMark('FOO==bar')).toBe(false)
    })
  })
})
