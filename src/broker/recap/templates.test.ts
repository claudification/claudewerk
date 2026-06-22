import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildTemplateList,
  DEFAULT_TEMPLATE_ID,
  loadTemplates,
  loadTemplatesFromDir,
  pickTemplate,
  type RecapTemplate,
  type RecapTemplateOption,
  renderTemplateBody,
  resolveOptionFlags,
  resolveTemplateSignals,
  resolveTemplatesDir,
  type TemplateLoadEvent,
  templateManifestSchema,
  toTemplateInfo,
} from './templates'

const TEST_DIR = join(import.meta.dir, '.test-recap-templates')

// A minimal valid template body (no required fields beyond the schema).
const VALID_YML = `
id: project-recap
label: Project Recap
description: The default reflective recap.
sections: [features, bugs, fixes]
options:
  - id: terse
    label: Terse tone
    default: false
  - id: include_cost
    label: Include cost
    default: false
    signal: cost
body: |
  Write a recap for {{ period.human }}.
  {% if options.terse %}One line per item.{% endif %}
`

function write(file: string, contents: string): void {
  writeFileSync(join(TEST_DIR, file), contents)
}

function collectLogger(): { events: TemplateLoadEvent[]; log: (e: TemplateLoadEvent) => void } {
  const events: TemplateLoadEvent[] = []
  return { events, log: e => events.push(e) }
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('loadTemplatesFromDir', () => {
  it('loads a valid template and applies schema defaults', () => {
    write('project-recap.yml', VALID_YML)
    const { templates, skipped } = loadTemplatesFromDir(TEST_DIR, () => {})

    expect(skipped).toHaveLength(0)
    expect(templates.size).toBe(1)

    const t = templates.get('project-recap')
    if (!t) throw new Error('expected project-recap template to load')
    expect(t.label).toBe('Project Recap')
    expect(t.sections).toEqual(['features', 'bugs', 'fixes'])
    // Defaults filled in by the schema.
    expect(t.scope).toBe('fleet')
    expect(t.audience).toBe('human')
    expect(t.defaults).toEqual({ retrospect: false, customerFriendly: false, signals: [] })
    // Technical option carries its signal; prompt-tweak option does not.
    const byId = (id: string): RecapTemplateOption | undefined => t.options.find(o => o.id === id)
    expect(byId('include_cost')?.signal).toBe('cost')
    expect(byId('terse')?.signal).toBeUndefined()
  })

  it('skips a malformed YAML file and logs a structured event', () => {
    write('project-recap.yml', VALID_YML)
    write('broken.yml', 'id: broken\n  label: : : not valid yaml :')
    const { events, log } = collectLogger()

    const { templates, skipped } = loadTemplatesFromDir(TEST_DIR, log)

    // The valid one still loads; the broken one is skipped, not fatal.
    expect(templates.has('project-recap')).toBe(true)
    expect(templates.has('broken')).toBe(false)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.file).toBe('broken.yml')
    // Structured event was logged (LOG-EVERYTHING covenant).
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('recap_template_skipped')
    expect(events[0]?.reason).toContain('yaml parse failed')
  })

  it('rejects a template missing a required field', () => {
    // No `body` -- required, no default.
    write('nobody.yml', 'id: nobody\nlabel: No Body\ndescription: missing body field\n')
    const { events, log } = collectLogger()

    const { templates, skipped } = loadTemplatesFromDir(TEST_DIR, log)

    expect(templates.size).toBe(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.event).toBe('recap_template_skipped')
    expect(skipped[0]?.reason).toContain('schema invalid')
    expect(skipped[0]?.reason).toContain('body')
    expect(events).toHaveLength(1)
  })

  it('rejects a section outside the fixed frontmatter vocabulary', () => {
    write('badsection.yml', VALID_YML.replace('[features, bugs, fixes]', '[features, made_up_section]'))
    const { templates, skipped } = loadTemplatesFromDir(TEST_DIR, () => {})

    expect(templates.size).toBe(0)
    expect(skipped[0]?.reason).toContain('schema invalid')
    expect(skipped[0]?.reason).toContain('sections')
  })

  it('rejects a template body with a Liquid syntax error', () => {
    write(
      'badliquid.yml',
      VALID_YML.replace('{% if options.terse %}One line per item.{% endif %}', '{% if options.terse %}unclosed'),
    )
    const { templates, skipped } = loadTemplatesFromDir(TEST_DIR, () => {})

    expect(templates.size).toBe(0)
    expect(skipped[0]?.reason).toContain('liquid syntax error')
  })

  it('skips a duplicate id, keeping the first', () => {
    write('a.yml', VALID_YML)
    write('b.yml', VALID_YML.replace('label: Project Recap', 'label: Dup'))
    const { templates, skipped } = loadTemplatesFromDir(TEST_DIR, () => {})

    expect(templates.size).toBe(1)
    // Files are read in sorted order: a.yml wins, b.yml is the duplicate.
    expect(templates.get('project-recap')?.label).toBe('Project Recap')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.reason).toContain('duplicate id')
  })

  it('logs and returns empty when the dir is missing', () => {
    const { events, log } = collectLogger()
    const { templates, skipped } = loadTemplatesFromDir(join(TEST_DIR, 'does-not-exist'), log)

    expect(templates.size).toBe(0)
    expect(skipped[0]?.event).toBe('recap_templates_dir_missing')
    expect(events).toHaveLength(1)
  })
})

describe('resolveTemplatesDir / loadTemplates', () => {
  it('resolves to the repo dir when the prod bind-mount is absent', () => {
    // /srv/recap-templates does not exist in the test env -> dev fallback.
    expect(resolveTemplatesDir().endsWith('/recap-templates')).toBe(true)
  })

  it('loads the committed built-ins without throwing, including the anchor', () => {
    const { templates, skipped } = loadTemplates(() => {})
    // Phase 1 committed the default `project-recap` anchor template.
    expect(skipped).toHaveLength(0)
    expect(templates.has(DEFAULT_TEMPLATE_ID)).toBe(true)
    expect(templates.get(DEFAULT_TEMPLATE_ID)?.audience).toBe('human')
  })
})

describe('pickTemplate', () => {
  it('returns the requested template when present', () => {
    write('project-recap.yml', VALID_YML)
    const { templates } = loadTemplatesFromDir(TEST_DIR, () => {})
    expect(pickTemplate(templates, 'project-recap')?.id).toBe('project-recap')
  })

  it('falls back to the default template and logs when the requested id is missing', () => {
    write('project-recap.yml', VALID_YML)
    const { templates } = loadTemplatesFromDir(TEST_DIR, () => {})
    const { events, log } = collectLogger()

    const picked = pickTemplate(templates, 'no-such-template', log)
    expect(picked?.id).toBe(DEFAULT_TEMPLATE_ID)
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('recap_template_fallback')
  })

  it('returns undefined when even the default is absent', () => {
    const { templates } = loadTemplatesFromDir(TEST_DIR, () => {})
    expect(pickTemplate(templates, undefined, () => {})).toBeUndefined()
  })
})

// Build a fully-defaulted template object inline (no file I/O).
function tmpl(partial: Record<string, unknown>): RecapTemplate {
  return templateManifestSchema.parse({ label: 'L', description: 'D', body: 'B', ...partial })
}

describe('resolveOptionFlags (PLAN section 4: prompt-tweak wire)', () => {
  it('applies each option default when there is no override', () => {
    const t = tmpl({
      id: 'x',
      options: [
        { id: 'terse', label: 'Terse', default: true },
        { id: 'group', label: 'Group', default: false },
      ],
    })
    expect(resolveOptionFlags(t)).toEqual({ terse: true, group: false })
  })

  it('lets a user override win over the option default', () => {
    const t = tmpl({
      id: 'x',
      options: [
        { id: 'terse', label: 'Terse', default: true },
        { id: 'group', label: 'Group', default: false },
      ],
    })
    expect(resolveOptionFlags(t, { terse: false, group: true })).toEqual({ terse: false, group: true })
  })

  it('ignores override keys that are not declared options', () => {
    const t = tmpl({ id: 'x', options: [{ id: 'terse', label: 'Terse', default: false }] })
    expect(resolveOptionFlags(t, { terse: true, bogus: true })).toEqual({ terse: true })
  })

  it('a prompt-tweak option flips the matching Liquid boolean in the rendered body', () => {
    const t = tmpl({
      id: 'x',
      body: '{% if options.terse %}TERSE{% else %}NARRATIVE{% endif %}',
      options: [{ id: 'terse', label: 'Terse', default: false }],
    })
    expect(renderTemplateBody(t, { options: resolveOptionFlags(t) })).toBe('NARRATIVE')
    expect(renderTemplateBody(t, { options: resolveOptionFlags(t, { terse: true }) })).toBe('TERSE')
  })
})

describe('resolveTemplateSignals (PLAN section 4: technical wire)', () => {
  it('returns the template default signal set when no technical options fire', () => {
    const t = tmpl({ id: 'x', defaults: { signals: ['user_prompts', 'commits'] } })
    expect(resolveTemplateSignals(t, resolveOptionFlags(t))).toEqual(['commits', 'user_prompts'])
  })

  it('a technical option ADDS its signal when its resolved flag is true', () => {
    const t = tmpl({
      id: 'x',
      defaults: { signals: ['user_prompts'] },
      options: [{ id: 'include_cost', label: 'Cost', default: false, signal: 'cost' }],
    })
    // default false -> signal absent
    expect(resolveTemplateSignals(t, resolveOptionFlags(t))).toEqual(['user_prompts'])
    // user turns it on -> signal added
    expect(resolveTemplateSignals(t, resolveOptionFlags(t, { include_cost: true }))).toEqual(['cost', 'user_prompts'])
  })

  it('a technical option REMOVES its signal from the defaults when its flag is false', () => {
    const t = tmpl({
      id: 'x',
      defaults: { signals: ['user_prompts', 'commits'] },
      options: [{ id: 'commit_stats', label: 'Commits', default: true, signal: 'commits' }],
    })
    // default true -> commits stays
    expect(resolveTemplateSignals(t, resolveOptionFlags(t))).toEqual(['commits', 'user_prompts'])
    // user turns it off -> commits removed
    expect(resolveTemplateSignals(t, resolveOptionFlags(t, { commit_stats: false }))).toEqual(['user_prompts'])
  })

  it('a prompt-tweak option (no signal) never touches the signal set', () => {
    const t = tmpl({
      id: 'x',
      defaults: { signals: ['user_prompts'] },
      options: [{ id: 'terse', label: 'Terse', default: true }],
    })
    expect(resolveTemplateSignals(t, resolveOptionFlags(t, { terse: false }))).toEqual(['user_prompts'])
  })

  it('a combined option flips BOTH its signal AND its Liquid boolean', () => {
    const t = tmpl({
      id: 'x',
      body: '{% if options.commit_stats %}STATS{% else %}NO-STATS{% endif %}',
      defaults: { signals: ['user_prompts', 'commits'] },
      options: [{ id: 'commit_stats', label: 'Commits', default: true, signal: 'commits' }],
    })
    const onFlags = resolveOptionFlags(t)
    expect(resolveTemplateSignals(t, onFlags)).toEqual(['commits', 'user_prompts'])
    expect(renderTemplateBody(t, { options: onFlags })).toBe('STATS')

    const offFlags = resolveOptionFlags(t, { commit_stats: false })
    expect(resolveTemplateSignals(t, offFlags)).toEqual(['user_prompts'])
    expect(renderTemplateBody(t, { options: offFlags })).toBe('NO-STATS')
  })
})

describe('templateManifestSchema', () => {
  it('is exported for downstream wiring', () => {
    const parsed = templateManifestSchema.safeParse({
      id: 'x',
      label: 'X',
      description: 'd',
      body: 'hello',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('toTemplateInfo', () => {
  const base: RecapTemplate = {
    id: 'sample',
    label: 'Sample',
    description: 'd',
    scope: 'fleet',
    audience: 'human',
    defaults: { retrospect: false, customerFriendly: false, signals: ['commits'] },
    sections: ['features', 'fixes'],
    options: [
      { id: 'terse', label: 'Terse', default: false },
      { id: 'include_cost', label: 'Cost', default: true, signal: 'cost' },
    ],
    body: 'b',
  }

  it('projects the discovery shape and omits the Liquid body', () => {
    const info = toTemplateInfo(base)
    expect(info).not.toHaveProperty('body')
    expect(info).toMatchObject({ id: 'sample', label: 'Sample', audience: 'human', isDefault: false })
    expect(info.sections).toEqual(['features', 'fixes'])
  })

  it('emits signal only on technical options', () => {
    const info = toTemplateInfo(base)
    expect(info.options[0]).toEqual({ id: 'terse', label: 'Terse', default: false })
    expect(info.options[0]).not.toHaveProperty('signal')
    expect(info.options[1]).toEqual({ id: 'include_cost', label: 'Cost', default: true, signal: 'cost' })
  })

  it('marks the default template id', () => {
    expect(toTemplateInfo({ ...base, id: DEFAULT_TEMPLATE_ID }).isDefault).toBe(true)
  })
})

describe('buildTemplateList', () => {
  it('lists the built-in templates default-first, then alphabetical', () => {
    const { templates, defaultTemplateId } = buildTemplateList(() => {})
    expect(defaultTemplateId).toBe(DEFAULT_TEMPLATE_ID)
    expect(templates.length).toBeGreaterThan(0)
    // Default sorts first regardless of its alphabetical position.
    expect(templates[0].id).toBe(DEFAULT_TEMPLATE_ID)
    expect(templates[0].isDefault).toBe(true)
    const rest = templates.slice(1).map(t => t.id)
    expect(rest).toEqual([...rest].sort())
  })
})

describe('lessons-learned template (Lessons Scavenger)', () => {
  it('loads, validates, and is an agent retrospect template covering tech_discovered', () => {
    const { templates, skipped } = loadTemplates(() => {})
    expect(skipped).toHaveLength(0)
    const t = templates.get('lessons-learned')
    expect(t).toBeDefined()
    expect(t?.audience).toBe('agent')
    expect(t?.defaults.retrospect).toBe(true)
    expect(t?.sections).toContain('tech_discovered')
    expect(t?.sections).toContain('dead_ends')
  })

  it('renders both oneshot and synthesize paths to a tech-aware, parseable contract', () => {
    const { templates } = loadTemplates(() => {})
    const t = templates.get('lessons-learned')
    if (!t) throw new Error('lessons-learned template missing')
    const ctx = {
      options: {},
      audience: 'agent',
      scope_label: 'remote-claude',
      period: { human: 'this week', iso_range: '2026-06-15..2026-06-22' },
      frontmatter_spec: '',
      body_spec: '',
      stats: { conversations: 0, commits: 0, projects: [] },
    }
    for (const path of ['oneshot', 'synthesize'] as const) {
      const out = renderTemplateBody(t, { ...ctx, path })
      // The new first-class field + its outcome enum must be in the contract.
      expect(out).toContain('tech_discovered')
      expect(out).toContain('success | failure | mixed')
      // It must still ask for a YAML frontmatter block the parser can read.
      expect(out).toContain('YAML frontmatter')
      expect(out).toContain('## Dead ends')
      // Path-specific framing is present.
      expect(out).toContain(path === 'synthesize' ? 'SYNTHESIZING' : 'FUTURE AGENT')
    }
  })
})
