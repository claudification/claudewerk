import { describe, expect, it } from 'bun:test'
import {
  applySpawnTitle,
  applyTitleWrite,
  backfillTitleSetAt,
  decideTitleWrite,
  isEphemeralName,
  type TitleState,
} from './title-authority'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

/** A conversation renamed from the control panel one minute ago. */
function pinned(): TitleState {
  return { title: 'panel-name', titleUserSet: true, titleOrigin: 'user', titleSetAt: NOW - MINUTE }
}

describe('decideTitleWrite', () => {
  it('accepts the first title on a fresh conversation', () => {
    expect(decideTitleWrite({}, { title: 'first', origin: 'cc-observed' }, NOW)).toMatchObject({ accept: true })
  })

  it('rejects a write that changes nothing (this is what breaks the rename echo loop)', () => {
    const verdict = decideTitleWrite(pinned(), { title: 'panel-name', origin: 'user', at: NOW }, NOW)
    expect(verdict).toEqual({ accept: false, reason: 'unchanged' })
  })

  it('treats blank and whitespace-only titles as a clear, not a value', () => {
    expect(decideTitleWrite({ title: undefined }, { title: '   ', origin: 'user', at: NOW }, NOW)).toEqual({
      accept: false,
      reason: 'unchanged',
    })
  })

  describe('origin precedence', () => {
    it("rejects CC's undated custom-title against a user-set title", () => {
      const verdict = decideTitleWrite(pinned(), { title: 'cc-launch-name', origin: 'cc-observed' }, NOW)
      expect(verdict).toEqual({ accept: false, reason: 'pinned' })
    })

    it('rejects the CC launch name against a user-set title', () => {
      const verdict = decideTitleWrite(pinned(), { title: 'cc-launch-name', origin: 'cc-auto', at: NOW }, NOW)
      expect(verdict).toEqual({ accept: false, reason: 'pinned' })
    })

    it("SEEDS a title CC knows and we don't -- the adopted / imported-session case", () => {
      expect(decideTitleWrite({}, { title: 'from-cc', origin: 'cc-observed' }, NOW)).toMatchObject({ accept: true })
    })

    it('but never CHANGES a title we already hold, even an unpinned one', () => {
      // CC's copy is a mirror of what we told it: every custom-title value in
      // the fleet is a slug we generated or a name a spawn supplied. So a
      // DISAGREEMENT means we moved on, not that CC learned something.
      const auto: TitleState = { title: 'old-auto', titleOrigin: 'cc-observed' }
      expect(decideTitleWrite(auto, { title: 'new-auto', origin: 'cc-observed' }, NOW)).toEqual({
        accept: false,
        reason: 'pinned',
      })
    })

    it('honours an agent rename over a CC-set title', () => {
      const auto: TitleState = { title: 'old-auto', titleOrigin: 'cc-observed' }
      expect(decideTitleWrite(auto, { title: 'agent-name', origin: 'agent', at: NOW }, NOW)).toMatchObject({
        accept: true,
      })
    })
  })

  describe('replay protection by timestamp, never by isInitial', () => {
    it('rejects a replayed /rename that predates the stored title', () => {
      const verdict = decideTitleWrite(
        pinned(),
        { title: 'ancient-cc-rename', origin: 'user', at: NOW - 60 * MINUTE },
        NOW,
      )
      expect(verdict).toEqual({ accept: false, reason: 'stale' })
    })

    it('ACCEPTS a live /rename typed inside CC over a newer panel rename -- the whole point', () => {
      const verdict = decideTitleWrite(pinned(), { title: 'typed-in-cc', origin: 'user', at: NOW }, NOW)
      expect(verdict).toMatchObject({ accept: true, at: NOW })
    })

    it('accepts an equal timestamp with a different value (last arrival wins a tie)', () => {
      const state = { ...pinned(), titleSetAt: NOW }
      expect(decideTitleWrite(state, { title: 'other', origin: 'user', at: NOW }, NOW)).toMatchObject({ accept: true })
    })

    it('does not date-compare an undated write -- origin decides it, not the clock', () => {
      // An undated cc-observed write is rejected for being cc-observed against a
      // title we hold, NOT for being stale -- it has no clock to be stale by.
      const auto: TitleState = { title: 'old-auto', titleOrigin: 'cc-observed', titleSetAt: NOW }
      expect(decideTitleWrite(auto, { title: 'new-auto', origin: 'cc-observed' }, NOW)).toEqual({
        accept: false,
        reason: 'pinned',
      })
      // ...while an undated write onto an EMPTY title is accepted despite the
      // stored clock being newer than nothing.
      expect(decideTitleWrite({ titleSetAt: NOW }, { title: 'seed', origin: 'cc-observed' }, NOW)).toMatchObject({
        accept: true,
      })
    })
  })

  describe('clock skew', () => {
    it('clamps a future timestamp to now and flags it', () => {
      const verdict = decideTitleWrite(pinned(), { title: 'skewed', origin: 'user', at: NOW + 60 * MINUTE }, NOW)
      expect(verdict).toMatchObject({ accept: true, at: NOW, clamped: true })
    })

    it('a clamped write cannot pin the title into the future', () => {
      const state = pinned()
      applyTitleWrite(state, { title: 'skewed', origin: 'user', at: NOW + 60 * MINUTE }, NOW)
      expect(state.titleSetAt).toBe(NOW)
      // A later, honest write still wins rather than being locked out for an hour.
      expect(decideTitleWrite(state, { title: 'honest', origin: 'user', at: NOW + 1 }, NOW + 1)).toMatchObject({
        accept: true,
      })
    })
  })
})

describe('applyTitleWrite', () => {
  it('records value, origin and clock on accept', () => {
    const state = pinned()
    applyTitleWrite(state, { title: 'typed-in-cc', origin: 'user', at: NOW }, NOW)
    expect(state).toMatchObject({ title: 'typed-in-cc', titleOrigin: 'user', titleUserSet: true, titleSetAt: NOW })
  })

  it('leaves state untouched on reject', () => {
    const state = pinned()
    applyTitleWrite(state, { title: 'cc-launch-name', origin: 'cc-observed' }, NOW)
    expect(state).toEqual(pinned())
  })

  it('clearing a title unpins it so CC may auto-title again', () => {
    const state = pinned()
    applyTitleWrite(state, { title: undefined, origin: 'user', at: NOW }, NOW)
    expect(state).toMatchObject({ title: undefined, titleUserSet: false })
    expect(decideTitleWrite(state, { title: 'cc-auto-name', origin: 'cc-observed' }, NOW)).toMatchObject({
      accept: true,
    })
  })

  it('stamps `now` when the writer carried no clock', () => {
    const state: TitleState = {}
    applyTitleWrite(state, { title: 'undated', origin: 'cc-observed' }, NOW)
    expect(state.titleSetAt).toBe(NOW)
  })

  it('terminates the panel -> CC -> panel echo in one bounce', () => {
    const state: TitleState = {}
    // Panel renames.
    expect(applyTitleWrite(state, { title: 'new-name', origin: 'user', at: NOW }, NOW).accept).toBe(true)
    // Broker pushes set_title, CC renames itself and echoes the same name back.
    const echo = applyTitleWrite(state, { title: 'new-name', origin: 'user', at: NOW + 5 }, NOW + 5)
    expect(echo).toEqual({ accept: false, reason: 'unchanged' })
  })
})

describe('backfillTitleSetAt', () => {
  it('stamps a pin that predates this module so old JSONL renames cannot revert it', () => {
    const legacy: TitleState = { title: 'set-months-ago', titleUserSet: true }
    expect(backfillTitleSetAt(legacy, NOW)).toBe(true)
    expect(legacy).toMatchObject({ titleSetAt: NOW, titleOrigin: 'user' })
    expect(
      decideTitleWrite(legacy, { title: 'may-era-rename', origin: 'user', at: NOW - 90 * 24 * 3600_000 }, NOW),
    ).toEqual({ accept: false, reason: 'stale' })
  })

  it('still lets a LIVE rename through after the backfill', () => {
    const legacy: TitleState = { title: 'set-months-ago', titleUserSet: true }
    backfillTitleSetAt(legacy, NOW)
    expect(decideTitleWrite(legacy, { title: 'live', origin: 'user', at: NOW + 1 }, NOW + 1)).toMatchObject({
      accept: true,
    })
  })

  it('does not touch an unpinned or already-stamped conversation', () => {
    expect(backfillTitleSetAt({ title: 'auto' }, NOW)).toBe(false)
    expect(backfillTitleSetAt({ title: 'x', titleUserSet: true, titleSetAt: 5 }, NOW)).toBe(false)
  })
})

/**
 * THE FLAG (2026-08-19). A name is either INTENTIONAL or EPHEMERAL, and every
 * writer records which on the way in.
 *
 * Born from 1194 live conversations whose ephemeral petname carried
 * `titleUserSet: true` -- the legacy spawn path stamped the boolean on its own
 * generated name, so all of them read as human-authored and the automatic
 * renamer could never touch one. The lesson is not "sniff harder": it is that
 * intent must be RECORDED, never re-derived.
 */
describe('titleEphemeral -- intentional vs ephemeral', () => {
  it('an automatic write leaves the name ephemeral, so a better guess can replace it', () => {
    const state: TitleState = {}
    applyTitleWrite(state, { title: 'floppy-panda', origin: 'cc-auto' }, NOW)
    expect(isEphemeralName(state)).toBe(true)
    expect(decideTitleWrite(state, { title: 'fix spawn timeout', origin: 'cc-auto' }, NOW)).toMatchObject({
      accept: true,
    })
  })

  it('rename_conversation is an INTENTIONAL rename and clears the flag', () => {
    const state: TitleState = {}
    applyTitleWrite(state, { title: 'floppy-panda', origin: 'cc-auto' }, NOW)
    applyTitleWrite(state, { title: 'the wall', origin: 'agent', at: NOW }, NOW)
    expect(isEphemeralName(state)).toBe(false)
    expect(decideTitleWrite(state, { title: 'auto guess', origin: 'cc-auto' }, NOW)).toEqual({
      accept: false,
      reason: 'pinned',
    })
  })

  it('a human rename clears the flag too', () => {
    const state: TitleState = {}
    applyTitleWrite(state, { title: 'mine', origin: 'user', at: NOW }, NOW)
    expect(isEphemeralName(state)).toBe(false)
  })

  it('a conversation with no name at all is ephemeral', () => {
    expect(isEphemeralName({})).toBe(true)
  })

  it('clearing a title returns it to ephemeral', () => {
    const state: TitleState = {}
    applyTitleWrite(state, { title: 'mine', origin: 'user', at: NOW }, NOW)
    applyTitleWrite(state, { title: undefined, origin: 'user', at: NOW + 1 }, NOW + 1)
    expect(isEphemeralName(state)).toBe(true)
  })

  it('the flag wins over the legacy boolean once recorded', () => {
    const legacyLooksPinned: TitleState = { title: 'floppy-panda', titleUserSet: true, titleEphemeral: true }
    expect(isEphemeralName(legacyLooksPinned)).toBe(true)
    expect(decideTitleWrite(legacyLooksPinned, { title: 'real name', origin: 'cc-auto' }, NOW)).toMatchObject({
      accept: true,
    })
  })
})

describe('spawned conversations follow intent, not their spawn route', () => {
  it('pins a spawn whose requester supplied a name', () => {
    const state: TitleState = {}
    applySpawnTitle(state, 'nightly sweep', 'floppy-panda')
    expect(state.title).toBe('nightly sweep')
    expect(decideTitleWrite(state, { title: 'auto', origin: 'cc-auto' }, NOW)).toEqual({
      accept: false,
      reason: 'pinned',
    })
  })

  it('leaves an unnamed spawn fair game for the renamer', () => {
    const state: TitleState = {}
    applySpawnTitle(state, undefined, 'floppy-panda')
    expect(state.title).toBe('floppy-panda')
    expect(decideTitleWrite(state, { title: 'derived name', origin: 'cc-auto' }, NOW)).toMatchObject({ accept: true })
  })
})
