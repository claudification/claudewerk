/**
 * `watch_conversations` -- the orb SUBSCRIBING to conversations, so a status
 * change comes to it instead of it having to keep asking.
 *
 * ONE verb, five modes, because five near-identical tools (watch / unwatch /
 * list / clear / replace) is five chances for the model to pick the wrong one
 * off a misheard sentence. The mode is an enum the model must choose
 * deliberately, and every mode returns the SAME shape -- the full watch list
 * after the change -- so the orb can always say what it is now watching without
 * a second call.
 *
 * It mutates NOTHING in the fleet: a watch is a note about what this orb wants
 * to hear about. That is why it sits in the voice READ set next to the status
 * reads, not behind the spoken confirm the action verbs get.
 *
 * The subscription is keyed on the calling orb's instance id, which arrives via
 * `ctx.origin` (stamped by the voice seam), NOT from the model's arguments --
 * an orb must not be able to subscribe some other browser by saying its id.
 */

import { z } from 'zod'
import { addressesMatching } from './desk-addresses'
import { applyWatch, MAX_PATTERNS_PER_ORB, WATCH_TTL_MS, type WatchMode } from './orb-status-watch'
import type { DispatchRuntime } from './runtime'
import { defineTool, type Toolset } from './tool-def'

const WATCH_MODES = ['add', 'remove', 'replace', 'clear', 'list'] as const

const DESCRIPTION = [
  'SUBSCRIBE to conversations so their status changes come to you unasked -- "keep an eye on X",',
  '"tell me when the nightshift one finishes", "watch that project", "let me know if anything breaks".',
  'A watched conversation reaching a new state (done / needs_you / blocked / working) arrives as a',
  '"[status]" line; nothing else changes, and you keep no other hold on it.',
  '',
  'PATTERNS are `project:conversation`, the same address list_conversations shows you, with two globs:',
  '`remote-claude:*` (or just `remote-claude`) = every conversation in that project;',
  '`remote-claude:nightshift` = that one; `*:fix-*` = anything named fix-* anywhere; `*` = the whole fleet.',
  'Only `*` and `?` are globs -- regex is REFUSED, and a rejected pattern is named back to you so you can',
  'ask him what he meant instead of guessing. Do NOT reach for `*` unless he actually asked for everything.',
  '',
  'MODES: `add` (the default thing he means), `remove`, `replace` (swap the whole list), `clear` (stop',
  'watching entirely), `list` (what am I watching -- takes no patterns).',
  `Watches expire on their own after ${Math.round(WATCH_TTL_MS / 3_600_000)} hours and are lost if the broker restarts; say so if he asks how long.`,
  '',
  'The result tells you `matchesNow` -- the conversations the patterns hit RIGHT NOW. Empty is not an',
  'error (a watch can wait for work that has not started), but if he named a specific one and it matches',
  'nothing, he probably misremembered the name: say so rather than confirming a watch on a typo.',
].join('\n')

/** Bind the watch verb to a runtime. `rt` is only read (to say what a pattern
 *  currently matches); the subscription itself lives in orb-status-watch.ts. */
export function orbWatchTools(rt: DispatchRuntime): Toolset {
  return {
    watch_conversations: defineTool({
      description: DESCRIPTION,
      inputSchema: z.object({
        mode: z.enum(WATCH_MODES).describe('What to do with the patterns. Use `add` unless he said otherwise.'),
        patterns: z
          .array(z.string())
          .nullable()
          .describe(
            `Addresses or globs, e.g. ["remote-claude:*"]. Null or empty for \`list\` and \`clear\`. Max ${MAX_PATTERNS_PER_ORB} held at once.`,
          ),
      }),
      execute: (a, ctx) => {
        const { mode, patterns } = a as { mode: WatchMode; patterns: string[] | null }
        // The orb id comes from the SEAM, never from the model's args.
        const orbId = ctx.origin?.orbId ?? null
        const change = applyWatch(orbId, mode, patterns ?? [])

        const out: Record<string, unknown> = {
          watching: change.patterns,
          matchesNow: addressesMatching(rt.store.getAllConversations(), change.patterns),
        }
        // Only surface the failure modes when they actually happened -- an
        // always-present `rejected: []` invites the model to mention it.
        if (change.rejected.length > 0) out.rejected = change.rejected
        if (change.clipped) out.clipped = `kept the first ${MAX_PATTERNS_PER_ORB}; ask him which ones to drop`
        if (change.expiresAt) out.expiresAt = new Date(change.expiresAt).toISOString()
        if (change.patterns.length === 0) out.note = 'watching nothing -- no status will reach you unasked'
        return out
      },
    }),
  }
}
