/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { parseAnvil } from './parse'
import { renderAnvilFence } from './render'

const CHOICE = `@choice id=deploy-target
? Where should I ship this?
: Staging is wiped nightly.
- prod   | Production  | live traffic, no undo
- !wipe  | Start over  | we bin the existing brand
- hold   | Nowhere yet`

describe('parseAnvil', () => {
  test('parses a choice: prompt, subtext, options, hints', () => {
    const [b] = parseAnvil(CHOICE).blocks
    expect(b?.kind).toBe('choice')
    expect(b?.id).toBe('deploy-target')
    expect(b?.derivedId).toBe(false)
    expect(b?.prompt).toBe('Where should I ship this?')
    expect(b?.subtext).toBe('Staging is wiped nightly.')
    expect(b?.options.map(o => o.value)).toEqual(['prod', 'wipe', 'hold'])
    expect(b?.options[0]?.hint).toBe('live traffic, no undo')
    expect(b?.options[1]?.danger).toBe(true)
    // A row with no hint cell must not invent one.
    expect(b?.options[2]?.hint).toBeUndefined()
  })

  test('attrs: quoted, bare-as-true, and plain', () => {
    const [b] = parseAnvil('@choice id=x select=many danger submit="Ship it"').blocks
    expect(b?.attrs.select).toBe('many')
    expect(b?.attrs.danger).toBe(true)
    expect(b?.attrs.submit).toBe('Ship it')
  })

  test('escaped pipe survives as a literal', () => {
    const [b] = parseAnvil('@choice id=x\n- a | Either \\| or | pick one').blocks
    expect(b?.options[0]?.label).toBe('Either | or')
    expect(b?.options[0]?.hint).toBe('pick one')
  })

  test('gallery cells are unordered and typed', () => {
    const src = '@gallery id=m render=swatch\n- ink | swatch=#111,#f5f2ea | Ink and paper | warm'
    const [b] = parseAnvil(src).blocks
    expect(b?.options[0]?.swatch).toEqual(['#111', '#f5f2ea'])
    expect(b?.options[0]?.label).toBe('Ink and paper')
    expect(b?.options[0]?.hint).toBe('warm')
  })

  test('fields: required star, type fallback, derived label', () => {
    const src = '@input id=c\n_ legal* | text | Legal name | Acme Ltd\n_ notes | wat\n_ site | url'
    const [b] = parseAnvil(src).blocks
    expect(b?.fields[0]).toMatchObject({ name: 'legal', required: true, placeholder: 'Acme Ltd' })
    expect(b?.fields[1]?.type).toBe('text')
    expect(b?.warnings.join()).toMatch(/unknown field type "wat"/)
    expect(b?.fields[2]?.label).toBe('Site')
  })

  test('dial default is clamped into the step range', () => {
    const src = '@scale id=t steps=5\n% a | Lo | Hi | 99\n% b | Lo | Hi | -4\n% c | Lo | Hi'
    const [b] = parseAnvil(src).blocks
    expect(b?.dials.map(d => d.value)).toEqual([5, 1, 3])
  })

  test('unknown block degrades to a warned note, never a throw', () => {
    const [b] = parseAnvil('@wormhole id=x\n? hi').blocks
    expect(b?.kind).toBe('note')
    expect(b?.attrs.tone).toBe('warn')
    expect(b?.warnings.join()).toMatch(/unknown block "@wormhole"/)
  })

  test('derived ids are content-derived and position-independent', () => {
    const a = parseAnvil('@choice\n- x | X').blocks[0]
    const b = parseAnvil('@note\n> filler\n\n@choice\n- x | X').blocks[1]
    expect(a?.derivedId).toBe(true)
    expect(a?.id).toBe(b?.id)
    // Different content must not collide.
    expect(parseAnvil('@choice\n- y | Y').blocks[0]?.id).not.toBe(a?.id)
  })

  test('comments never reach the output', () => {
    const [b] = parseAnvil('@choice id=x\n# secret note\n- a | A').blocks
    expect(b?.options).toHaveLength(1)
    expect(JSON.stringify(b)).not.toContain('secret note')
  })

  test('a line with no sigil folds into the prompt rather than vanishing', () => {
    const [b] = parseAnvil('@choice id=x\nplain words\n- a | A').blocks
    expect(b?.prompt).toBe('plain words')
  })

  test('over-long option lists warn but are never truncated', () => {
    const rows = Array.from({ length: 14 }, (_, i) => `- v${i} | Label ${i}`).join('\n')
    const [b] = parseAnvil(`@choice id=x\n${rows}`).blocks
    expect(b?.options).toHaveLength(14)
    expect(b?.warnings.join()).toMatch(/past the point a human scans/)
  })
})

describe('totality contract', () => {
  const FIXTURES = [
    CHOICE,
    '@gallery id=m render=image\n- a | A | img=https://x.test/a.jpg',
    '@input id=c\n_ a* | longtext | Notes',
    '@scale id=t steps=7\n% a | Lo | Hi | 2',
    '@note tone=warn\n> careful',
    '@choice id=x\n- a | A | b=|c\\| | img=',
  ]

  // The load-bearing test. An LLM emits these token by token, so EVERY prefix
  // of a fence is a real input the renderer will see. A throw here is a
  // white-screened transcript, not a bad block.
  test('no prefix of any fixture can make the parser or renderer throw', () => {
    for (const fixture of FIXTURES) {
      for (let i = 0; i <= fixture.length; i++) {
        const prefix = fixture.slice(0, i)
        expect(() => parseAnvil(prefix, { partial: true })).not.toThrow()
        expect(() => renderAnvilFence(prefix, false)).not.toThrow()
      }
    }
  })

  test('hostile and degenerate input is survivable', () => {
    const nasty = [
      '',
      '\n\n\n',
      '@',
      '@@@@',
      '- ',
      '_ ',
      '% ',
      '?',
      '#',
      '@choice id=\n- ',
      '@choice id="unclosed\n- a | A',
      '|||||',
      '\\|\\|\\|',
      '@choice\n- \\|',
      `@choice\n${'- a | A\n'.repeat(500)}`,
      '@scale\n% a | Lo | Hi | NaN',
      '@gallery\n- a | img=javascript:alert(1)',
      '@gallery\n- a | swatch=#fff;}</style><script>alert(1)</script>',
    ]
    for (const src of nasty) {
      expect(() => parseAnvil(src)).not.toThrow()
      expect(() => renderAnvilFence(src, true)).not.toThrow()
    }
  })
})

describe('renderAnvilFence', () => {
  test('emits a block per parsed block and marks streaming', () => {
    expect(renderAnvilFence(CHOICE, true)).toContain('data-anvil-id="deploy-target"')
    expect(renderAnvilFence(CHOICE, false)).toContain('anvil-doc-streaming')
  })

  test('every control is inert in the spike', () => {
    const html = renderAnvilFence(CHOICE, true)
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(b).toContain('disabled')
  })

  test('a non-hex swatch is dropped, not escaped into the style attr', () => {
    const html = renderAnvilFence('@gallery id=g render=swatch\n- a | swatch=#fff;}</style><x>', true)
    expect(html).not.toContain('</style>')
    expect(html).not.toContain('<x>')
  })

  test('a non-http img url never reaches src', () => {
    const html = renderAnvilFence('@gallery id=g\n- a | img=javascript:alert(1)', true)
    expect(html).not.toContain('javascript:')
    expect(html).toContain('anvil-img-missing')
  })

  test('a font family with quotes is refused rather than injected', () => {
    const html = renderAnvilFence("@gallery id=g render=type\n- a | font=x',y:url(z)", true)
    expect(html).not.toContain('url(z)')
  })

  test('icons are inline SVG, never a text glyph that could tofu', () => {
    const html = renderAnvilFence(CHOICE, true)
    expect(html).toContain('<svg class="anvil-svg"')
    expect(html).toContain('stroke="currentColor"')
    // No non-ASCII may reach the emitted markup: that is what tofu'd before.
    expect(/[^\x20-\x7E\n]/.test(html.replace(/[·]/g, ''))).toBe(false)
  })

  test('a gallery icon follows its render mode', () => {
    const swatch = renderAnvilFence('@gallery id=g render=swatch\n? P\n- a | A', true)
    const type = renderAnvilFence('@gallery id=g render=type\n? P\n- a | A', true)
    // palette has the distinctive blob path; type has the serif-T stem.
    expect(swatch).toContain('M12 22a1 1 0 0 1 0-20')
    expect(type).toContain('M12 4v16')
    expect(swatch).not.toContain('M12 4v16')
  })

  test('note tone picks its own icon and an unknown icon= falls back', () => {
    expect(renderAnvilFence('@note tone=danger\n> boom', true)).toContain('M15.312 2a2 2')
    const bogus = renderAnvilFence('@note tone=warn icon=nonsense\n> hm', true)
    expect(bogus).toContain('<svg')
    expect(bogus).toContain('m21.73 18-8-14') // fell back to triangle-alert
  })

  test('icon= overrides the kind default', () => {
    const html = renderAnvilFence('@choice id=x icon=palette\n? P\n- a | A', true)
    expect(html).toContain('M12 22a1 1 0 0 1 0-20')
  })

  test('secret renders masked, not as a plain text input', () => {
    const html = renderAnvilFence('@input id=i\n_ token | secret | Token', true)
    expect(html).toContain('type="password"')
  })

  test('every field type gets its own control', () => {
    const src =
      '@input id=i\n_ a | text | A\n_ b | number | B\n_ c | secret | C\n_ d | url | D\n_ e | date | E\n_ f | longtext | F\n_ g | bool | G'
    const html = renderAnvilFence(src, true)
    for (const t of ['text', 'number', 'password', 'url', 'date']) {
      expect(html).toContain(`type="${t}"`)
    }
    expect(html).toContain('<textarea')
    expect(html).toContain('anvil-switch')
  })

  test('single-select never gets a submit button; multi always does', () => {
    const one = '@choice id=x\n? Q\n- a | A'
    const many = '@choice id=x select=many\n? Q\n- a | A'
    const galleryOne = '@gallery id=g\n? Q\n- a | A'
    const galleryMany = '@gallery id=g select=many\n? Q\n- a | A'
    expect(renderAnvilFence(one, true)).not.toContain('anvil-submit')
    expect(renderAnvilFence(galleryOne, true)).not.toContain('anvil-submit')
    expect(renderAnvilFence(many, true)).toContain('anvil-submit')
    expect(renderAnvilFence(galleryMany, true)).toContain('anvil-submit')
    // input and scale always submit: there is no click that could stand in.
    expect(renderAnvilFence('@input id=i\n_ a | text | A', true)).toContain('anvil-submit')
    expect(renderAnvilFence('@scale id=s\n% a | Lo | Hi', true)).toContain('anvil-submit')
  })

  test('a note keeps its warnings inside the tinted box', () => {
    const html = renderAnvilFence('@wormhole id=x\n? hi', true)
    // The warning must sit within the note div, not trail after it as loose text.
    const noteEnd = html.lastIndexOf('</div></div>')
    const warnAt = html.indexOf('anvil-warn')
    expect(warnAt).toBeGreaterThan(-1)
    expect(warnAt).toBeLessThan(noteEnd)
  })

  test('warnings render above the action, not orphaned below it', () => {
    const html = renderAnvilFence('@input id=i\n_ x | nonsense | X', true)
    expect(html.indexOf('anvil-warn')).toBeLessThan(html.indexOf('anvil-submit'))
  })

  test('prompt text is escaped', () => {
    const html = renderAnvilFence('@choice id=x\n? <img src=x onerror=alert(1)>\n- a | A', true)
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})
