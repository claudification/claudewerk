import { describe, expect, it } from 'bun:test'
import { validateDialogLayout } from './dialog-schema'

// validateDialogLayout composes the base validator + validateLiveExtensions,
// so we exercise the live rules through the public entry point.

describe('dialog live extensions — width', () => {
  it('accepts normal | wide | full', () => {
    for (const width of ['normal', 'wide', 'full'] as const) {
      expect(validateDialogLayout({ title: 'T', width, body: [{ type: 'Markdown', content: 'x' }] })).toEqual([])
    }
  })

  it('rejects an unknown width', () => {
    expect(validateDialogLayout({ title: 'T', width: 'huge', body: [{ type: 'Markdown', content: 'x' }] })).toContain(
      'width must be one of normal|wide|full',
    )
  })
})

describe('dialog live extensions — persistent requires stable ids', () => {
  it('rejects a persistent layout with a block missing id', () => {
    const errors = validateDialogLayout({
      title: 'T',
      persistent: true,
      body: [{ type: 'Markdown', id: 'intro', content: 'x' }, { type: 'Divider' }],
    })
    expect(errors.some(e => e.includes('persistent dialog requires a stable id'))).toBe(true)
  })

  it('accepts a persistent layout with ids on every block (incl. nested)', () => {
    const errors = validateDialogLayout({
      title: 'T',
      persistent: true,
      body: [
        { type: 'Markdown', id: 'intro', content: 'x' },
        {
          type: 'Group',
          id: 'grp',
          label: 'S',
          children: [{ type: 'TextInput', id: 'name', label: 'Name' }],
        },
        { type: 'Button', id: 'send', label: 'Send', onClick: { action: 'agent', id: 'send-clicked' } },
      ],
    })
    expect(errors).toEqual([])
  })

  it('does not require ids when not persistent', () => {
    expect(validateDialogLayout({ title: 'T', body: [{ type: 'Markdown', content: 'x' }] })).toEqual([])
  })
})

describe('dialog live extensions — duplicate ids + handlers', () => {
  it('rejects duplicate block ids', () => {
    expect(
      validateDialogLayout({
        title: 'T',
        body: [
          { type: 'Markdown', id: 'dup', content: 'a' },
          { type: 'Markdown', id: 'dup', content: 'b' },
        ],
      }),
    ).toContain('duplicate block id: "dup"')
  })

  it('rejects a handler with a bad action', () => {
    expect(
      validateDialogLayout({
        title: 'T',
        body: [{ type: 'Button', id: 'b', label: 'Go', onClick: { action: 'explode', id: 'x' } }],
      }),
    ).toContain('onClick.action must be one of agent|navigate|close')
  })

  it('rejects a handler id that is missing or reserved', () => {
    const missing = validateDialogLayout({
      title: 'T',
      body: [{ type: 'Button', id: 'b', label: 'Go', onClick: { action: 'agent', id: '' } }],
    })
    expect(missing).toContain('onClick.id is required and must be a non-empty string')
    const reserved = validateDialogLayout({
      title: 'T',
      body: [{ type: 'Button', id: 'b', label: 'Go', onClick: { action: 'agent', id: '_close' } }],
    })
    expect(reserved.some(e => e.includes("must not start with '_'"))).toBe(true)
  })

  it('rejects a non-numeric debounce', () => {
    expect(
      validateDialogLayout({
        title: 'T',
        body: [{ type: 'Button', id: 'b', label: 'Go', onClick: { action: 'agent', id: 'x', debounce: 'soon' } }],
      }),
    ).toContain('onClick.debounce must be a number')
  })
})
