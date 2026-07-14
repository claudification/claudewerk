/**
 * The dispatcher's USER-NOTES tools -- a small CRUD surface over the user's
 * permanent `user-notes.md` (notes.ts). This is what fires when the user says
 * "take my notes", "note that ...", "what were my notes", "scratch that note".
 *
 * Unlike the LLM-curated rolling memory (read_memory), these notes are the
 * USER's: written verbatim, never auto-pruned, mutated only by these tools.
 * `edit_notes` mirrors Claude Code's Edit tool (exact single-occurrence string
 * replace unless replaceAll). `write_notes` and `clear_notes` snapshot the
 * prior content first, so they are recoverable.
 */

import { z } from 'zod'
import { appendNotes, clearNotes, editNotes, readNotes, writeNotes } from './notes'
import { defineTool, type Toolset } from './tool-def'

export function notesTools(userId: string | null | undefined): Toolset {
  return {
    read_notes: defineTool({
      description:
        "Read the user's permanent notes file verbatim (what they asked you to remember). Use when the user asks about their notes, or before appending/editing so you know what is there. Returns the full text.",
      inputSchema: z.object({}),
      idempotent: true,
      execute: () => {
        const notes = readNotes(userId)
        return notes ? { notes } : { notes: '', note: 'no notes saved yet' }
      },
    }),
    append_notes: defineTool({
      description:
        'Append to the user\'s permanent notes. THIS is the "take my notes" / "note that ..." path: capture what the user dictated as a new block, verbatim, without disturbing what is already there. Prefer this over write_notes for adding a new note.',
      inputSchema: z.object({
        text: z.string().describe('The note to append, in the user`s words.'),
      }),
      execute: a => {
        const { text } = a as { text: string }
        return appendNotes(text, userId)
      },
    }),
    write_notes: defineTool({
      description:
        'Overwrite the ENTIRE notes file with new content. Destructive -- it replaces everything (the prior version is snapshotted, so it is recoverable). Use only when the user wants to rewrite/reorganize their whole notes; to add a note use append_notes, to change one part use edit_notes.',
      inputSchema: z.object({
        content: z.string().describe('The full new contents of the notes file.'),
      }),
      execute: a => {
        const { content } = a as { content: string }
        return writeNotes(content, userId)
      },
    }),
    edit_notes: defineTool({
      description:
        'Make a surgical edit to the notes: replace an exact string with another (like a find-and-replace). oldString must appear EXACTLY ONCE unless replaceAll is true. Fails cleanly (no write) if oldString is absent or ambiguous. Use for "fix that note", "change X to Y", "drop the line about Z" (replace it with "").',
      inputSchema: z.object({
        oldString: z.string().describe('The exact text to find. Must be unique unless replaceAll.'),
        newString: z.string().describe('The replacement text (empty string to delete the matched text).'),
        replaceAll: z
          .boolean()
          .nullable()
          .describe('Replace every occurrence instead of requiring uniqueness. Null = false.'),
      }),
      execute: a => {
        const { oldString, newString, replaceAll } = a as {
          oldString: string
          newString: string
          replaceAll: boolean | null
        }
        return editNotes(oldString, newString, replaceAll ?? false, userId)
      },
    }),
    clear_notes: defineTool({
      description:
        'Erase ALL of the user`s notes (the prior content is snapshotted, so it is recoverable). Irreversible from the user`s view -- only do this on an explicit "clear my notes" / "wipe my notes" request, never on your own initiative.',
      inputSchema: z.object({}),
      execute: () => clearNotes(userId),
    }),
  }
}
