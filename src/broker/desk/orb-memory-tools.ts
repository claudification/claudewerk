/**
 * The orb's MEMORY verbs: remember / recall / list_memories / forget.
 *
 * Keyed and per-user (orb-memory.ts), so the orb can be told a fact once and
 * asked for it later -- and, just as importantly, told to drop one. A memory
 * that cannot be listed or deleted is a memory the user cannot correct, and a
 * voice agent WILL mishear something eventually.
 *
 * Nothing here touches the fleet: worst case it writes a wrong note about the
 * user, which he can hear back and delete.
 */

import { z } from 'zod'
import { forgetMemory, listMemories, MAX_VALUE_LENGTH, recallMemory, rememberMemory } from './orb-memory'
import { defineTool, type Toolset } from './tool-def'

/** Bind the memory verbs to one user. */
export function orbMemoryTools(userId: string | null | undefined): Toolset {
  return {
    remember: defineTool({
      description:
        'Save something the user wants you to remember for later ("remember that...", "from now on...", "my X is Y"). `key` is a SHORT name you will recognise it by later (e.g. "deploy ritual", "his timezone"); `value` is the fact itself. Saving over an existing key replaces it. Say back, briefly, that you have it.',
      inputSchema: z.object({
        key: z.string().describe('Short name for this memory. Reuse the same name to update it.'),
        value: z.string().describe(`The fact to keep, in plain words (max ${MAX_VALUE_LENGTH} chars).`),
      }),
      execute: a => {
        const { key, value } = a as { key: string; value: string }
        return rememberMemory(userId, key, value)
      },
    }),

    recall: defineTool({
      description:
        'Look up ONE thing you were told to remember, by its name. Returns null when nothing is stored under that name -- say so plainly rather than inventing it.',
      inputSchema: z.object({ key: z.string().describe('The memory name to look up.') }),
      idempotent: true,
      execute: a => {
        const { key } = a as { key: string }
        return { memory: recallMemory(userId, key) }
      },
    }),

    list_memories: defineTool({
      description:
        'Everything you have been told to remember for this user, newest first. Use it for "what do you remember?" -- then summarise, do NOT read the whole list aloud.',
      inputSchema: z.object({}),
      idempotent: true,
      execute: () => ({ memories: listMemories(userId) }),
    }),

    forget: defineTool({
      description:
        'Delete one memory by name ("forget that...", "that is wrong"). Returns what was removed so you can read it back -- a deletion he cannot hear is one he cannot correct.',
      inputSchema: z.object({ key: z.string().describe('The memory name to delete.') }),
      execute: a => {
        const { key } = a as { key: string }
        return forgetMemory(userId, key)
      },
    }),
  }
}
