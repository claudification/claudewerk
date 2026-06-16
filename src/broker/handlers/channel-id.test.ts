import { describe, expect, it } from 'bun:test'
import {
  type ConversationLike,
  computeConversationSlug,
  computeLocalId,
  formatAmbiguityError,
  formatCrossProjectAmbiguityError,
  resolveByConversationName,
  resolveSendTarget,
} from './channel-id'

function s(id: string, title?: string, project = 'claude:///projects/arr'): ConversationLike {
  return { id, title, project }
}

describe('computeConversationSlug', () => {
  it('uses the title when set', () => {
    const a = s('aaaaaaaaaa', 'viral-zebra')
    expect(computeConversationSlug(a, [a])).toBe('viral-zebra')
  })

  it('falls back to a 8-char id slice when no title', () => {
    const a = s('abcdef0123456789')
    expect(computeConversationSlug(a, [a])).toBe('abcdef01')
  })

  it('disambiguates with a 6-char id suffix on collision', () => {
    const a = s('aaaaaa1111', 'rebel')
    const b = s('bbbbbb2222', 'rebel')
    expect(computeConversationSlug(a, [a, b])).toBe('rebel-aaaaaa')
    expect(computeConversationSlug(b, [a, b])).toBe('rebel-bbbbbb')
  })

  it('does not collide with itself in the siblingConversations', () => {
    const a = s('aaaaaaaa', 'solo')
    expect(computeConversationSlug(a, [a])).toBe('solo')
  })
})

describe('computeLocalId', () => {
  it('always produces compound ids -- even for a single-conversation project', () => {
    // This is the whole point of the always-compound rule: ids must not flip
    // shape when a second conversation spawns later.
    const a = s('xxxxxxxx', 'viral-zebra')
    expect(computeLocalId(a, 'arr', [a])).toBe('arr:viral-zebra')
  })

  it('appends disambiguated conversation slug when multiple share the project', () => {
    const a = s('aaaaaa1111', 'rebel')
    const b = s('bbbbbb2222', 'rebel')
    expect(computeLocalId(a, 'arr', [a, b])).toBe('arr:rebel-aaaaaa')
  })
})

// ─── resolveSendTarget ──────────────────────────────────────────────

const allLive = (_: ConversationLike) => true
const noneLive = (_: ConversationLike) => false

describe('resolveSendTarget', () => {
  describe('compound `project:session-slug`', () => {
    it('resolves an exact conversation-slug match', () => {
      const a = s('a', 'viral-zebra')
      const b = s('b', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: 'punk-jackal',
        conversationsAtProject: [a, b],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.conversation.id).toBe('b')
    })

    it('falls back to a prefix match when no exact', () => {
      const a = s('a', 'viral-zebra')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: 'viral',
        conversationsAtProject: [a],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.conversation.id).toBe('a')
    })

    it('returns not_found when no conversation matches', () => {
      const a = s('a', 'viral-zebra')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: 'nope',
        conversationsAtProject: [a],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('not_found')
    })
  })

  describe('bare `project` -- accepted only when single', () => {
    it('resolves to the lone live conversation', () => {
      const a = s('a', 'viral-zebra')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: undefined,
        conversationsAtProject: [a],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.conversation.id).toBe('a')
    })

    it('FAILS as ambiguous when multiple LIVE sessions share the project', () => {
      const a = s('a', 'viral-zebra')
      const b = s('b', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: undefined,
        conversationsAtProject: [a, b],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('ambiguous')
      if (r.kind === 'ambiguous') {
        expect(r.candidates).toHaveLength(2)
        expect(r.canonicalProject).toBe('arr')
      }
    })

    it('picks the unique LIVE conversation when there are dead siblings', () => {
      const live = s('live', 'viral-zebra')
      const dead = s('dead', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: undefined,
        conversationsAtProject: [live, dead],
        canonicalProject: 'arr',
        isLive: x => x.id === 'live',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.conversation.id).toBe('live')
    })

    it('FAILS as ambiguous when no live sessions but multiple inactive', () => {
      const a = s('a', 'viral-zebra')
      const b = s('b', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: undefined,
        conversationsAtProject: [a, b],
        canonicalProject: 'arr',
        isLive: noneLive,
      })
      expect(r.kind).toBe('ambiguous')
    })

    it('falls back to a single inactive conversation when none are live', () => {
      const a = s('a', 'viral-zebra')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: undefined,
        conversationsAtProject: [a],
        canonicalProject: 'arr',
        isLive: noneLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.conversation.id).toBe('a')
    })

    it('prefers a conversation whose own title matches the bare slug', () => {
      // Edge case: if a conversation is literally named "arr" inside project "arr",
      // bare addressing should target THAT conversation, not project-level dispatch.
      const namedArr = s('named', 'arr')
      const other = s('other', 'punk-jackal')
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: undefined,
        conversationsAtProject: [namedArr, other],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.conversation.id).toBe('named')
    })

    it('returns not_found when the project has no sessions at all', () => {
      const r = resolveSendTarget({
        projectSlug: 'arr',
        conversationSlug: undefined,
        conversationsAtProject: [],
        canonicalProject: 'arr',
        isLive: allLive,
      })
      expect(r.kind).toBe('not_found')
    })
  })
})

// ─── resolveByConversationName (cross-project name fallback) ─────────

describe('resolveByConversationName', () => {
  const A = 'claude:///projects/alpha'
  const B = 'claude:///projects/beta'

  it('resolves a uniquely-named conversation regardless of project slug', () => {
    // The whole point: a stale/wrong project slug should not block delivery when
    // the conversation NAME is unique. (The reported incident: nsf-brain:fluffy-puffin.)
    const target = s('t', 'fluffy-puffin', B)
    const other = s('o', 'grumpy-otter', A)
    const r = resolveByConversationName('fluffy-puffin', [target, other])
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.conversation.id).toBe('t')
  })

  it('normalizes a non-slug name before matching', () => {
    const target = s('t', 'Fluffy Puffin', B)
    const r = resolveByConversationName('Fluffy Puffin', [target])
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.conversation.id).toBe('t')
  })

  it('falls back to a prefix match when no exact title', () => {
    const target = s('t', 'fluffy-puffin', B)
    const r = resolveByConversationName('fluffy', [target])
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.conversation.id).toBe('t')
  })

  it('is ambiguous when the same name exists in two projects', () => {
    const a = s('a', 'twin', A)
    const b = s('b', 'twin', B)
    const r = resolveByConversationName('twin', [a, b])
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.candidates).toHaveLength(2)
  })

  it('prefers an exact match over a prefix match', () => {
    const exact = s('e', 'build', A)
    const longer = s('l', 'build-tooling', B)
    const r = resolveByConversationName('build', [exact, longer])
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.conversation.id).toBe('e')
  })

  it('returns not_found when nothing matches', () => {
    const r = resolveByConversationName('ghost', [s('a', 'real', A)])
    expect(r.kind).toBe('not_found')
  })

  it('resolves via an in-window former slug when no current title matches', () => {
    const now = 1_000_000_000
    const renamed: ConversationLike = {
      id: 'r',
      title: 'new-name',
      project: B,
      formerSlugs: [{ slug: 'old-name', retiredAt: now - 1000, lastUsedAt: now - 1000 }],
    }
    const r = resolveByConversationName('old-name', [renamed], now)
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.conversation.id).toBe('r')
      expect(r.viaAlias).toBe('old-name')
    }
  })

  it('does NOT resolve an expired former slug', () => {
    const now = 1_000_000_000
    const renamed: ConversationLike = {
      id: 'r',
      title: 'new-name',
      project: B,
      formerSlugs: [{ slug: 'old-name', retiredAt: now - 26 * 60 * 60 * 1000, lastUsedAt: now - 26 * 60 * 60 * 1000 }],
    }
    const r = resolveByConversationName('old-name', [renamed], now)
    expect(r.kind).toBe('not_found')
  })
})

describe('formatCrossProjectAmbiguityError', () => {
  it('lists per-project compound ids the caller should retry with', () => {
    const a = s('aaaaaa1111', 'twin', 'claude:///projects/alpha')
    const b = s('bbbbbb2222', 'twin', 'claude:///projects/beta')
    const msg = formatCrossProjectAmbiguityError([a, b])
    expect(msg).toContain('Ambiguous conversation name: 2 conversations match')
    expect(msg).toContain('alpha:twin')
    expect(msg).toContain('beta:twin')
  })
})

describe('formatAmbiguityError', () => {
  it('lists compound ids the caller should retry with', () => {
    const a = s('aaaaaa1111', 'viral-zebra')
    const b = s('bbbbbb2222', 'punk-jackal')
    const msg = formatAmbiguityError('arr', [a, b])
    expect(msg).toContain('Ambiguous target: 2 conversations at "arr"')
    expect(msg).toContain('arr:viral-zebra')
    expect(msg).toContain('arr:punk-jackal')
  })

  it('disambiguates colliding conversation titles in the suggested ids', () => {
    const a = s('aaaaaa1111', 'rebel')
    const b = s('bbbbbb2222', 'rebel')
    const msg = formatAmbiguityError('arr', [a, b])
    expect(msg).toContain('arr:rebel-aaaaaa')
    expect(msg).toContain('arr:rebel-bbbbbb')
  })
})

// ─── former-slug alias tier (rename-alias retention, Phase 2c) ────────
describe('resolveSendTarget former-slug aliases', () => {
  const NOW = 1_000_000_000
  const within = NOW - 1000 // lastUsedAt inside the 24h window
  const expired = NOW - 25 * 60 * 60 * 1000 // outside the window

  function withFormer(
    id: string,
    title: string,
    former: Array<{ slug: string; retiredAt: number; lastUsedAt: number }>,
  ): ConversationLike {
    return { id, title, project: 'claude:///projects/arr', formerSlugs: former }
  }

  it('resolves a conversation by an in-window former slug', () => {
    const a = withFormer('aaaaaaaa', 'new-name', [{ slug: 'old-name', retiredAt: within, lastUsedAt: within }])
    const r = resolveSendTarget({
      projectSlug: 'arr',
      conversationSlug: 'old-name',
      conversationsAtProject: [a],
      canonicalProject: 'arr',
      isLive: allLive,
      now: NOW,
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.conversation).toBe(a)
      expect(r.viaAlias).toBe('old-name')
    }
  })

  it('does NOT resolve an expired former slug', () => {
    const a = withFormer('aaaaaaaa', 'new-name', [{ slug: 'old-name', retiredAt: expired, lastUsedAt: expired }])
    const r = resolveSendTarget({
      projectSlug: 'arr',
      conversationSlug: 'old-name',
      conversationsAtProject: [a],
      canonicalProject: 'arr',
      isLive: allLive,
      now: NOW,
    })
    expect(r.kind).toBe('not_found')
  })

  it('a live CURRENT slug always beats a former-slug alias on another conversation', () => {
    // b currently answers to "shared"; a shed "shared" as a former slug.
    const a = withFormer('aaaaaaaa', 'a-now', [{ slug: 'shared', retiredAt: within, lastUsedAt: within }])
    const b = s('bbbbbbbb', 'shared')
    const r = resolveSendTarget({
      projectSlug: 'arr',
      conversationSlug: 'shared',
      conversationsAtProject: [a, b],
      canonicalProject: 'arr',
      isLive: allLive,
      now: NOW,
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.conversation).toBe(b) // current wins
      expect(r.viaAlias).toBeUndefined()
    }
  })

  it('two conversations sharing an in-window former slug is ambiguous', () => {
    const a = withFormer('aaaaaaaa', 'a-now', [{ slug: 'shared', retiredAt: within, lastUsedAt: within }])
    const b = withFormer('bbbbbbbb', 'b-now', [{ slug: 'shared', retiredAt: within, lastUsedAt: within }])
    const r = resolveSendTarget({
      projectSlug: 'arr',
      conversationSlug: 'shared',
      conversationsAtProject: [a, b],
      canonicalProject: 'arr',
      isLive: allLive,
      now: NOW,
    })
    expect(r.kind).toBe('ambiguous')
  })
})
