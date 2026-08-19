/**
 * Harness-authored text that arrives wearing the USER's face.
 *
 * Claude Code injects its own prose as a `type: "user"` entry flagged `isMeta`,
 * with `message.content` as a plain STRING -- an image placeholder after a Read,
 * a commit nudge, a resume caveat, a malformed-tool-call retry. None of the
 * marker branches in `process-entry.ts` catch these: there is no
 * `<system-reminder>` wrapper, no `<command-name>`, no `hook feedback:` header,
 * and `isSkillContent` only looks at ARRAY content. So every one of them used to
 * render as a full user bubble -- the harness talking in the human's own color,
 * which is the one thing a transcript must never do.
 *
 * Generic by evidence, not by hope: across this repo's whole transcript corpus
 * (2.3k such entries) every single `isMeta` string entry is the harness. Not one
 * is a human turn. A real message that merely QUOTES a placeholder carries no
 * `isMeta` flag and is untouched.
 */

/**
 * The image-scale placeholder CC emits after reading an image, e.g.
 * `[Image: original 736x2854, displayed at 516x2000. Multiply coordinates by 1.43 ...]`.
 *
 * This one is DROPPED rather than drawn, because it is pure duplication: the
 * same four numbers already ride the Read row from `toolUseResult.file.dimensions`
 * (see `imageScale` in `read-binary.tsx`), where they sit next to the file they
 * describe instead of a screen below it, and are addressed to the reader rather
 * than to the model.
 */
const IMAGE_PLACEHOLDER_RE = /^\[Image:\s*original\s+\d+x\d+/i

export type MetaVerdict = 'drop' | 'line' | null

/**
 * What to do with a user entry: `drop` it, draw it as a muted system `line`, or
 * `null` for "not mine -- carry on down the branch list".
 *
 * Callers must run this AFTER the dedicated branches (hook feedback has its own
 * describer and a warmer severity), so a meta entry those already claim keeps
 * the better rendering.
 */
export function classifyHarnessMeta(isMeta: boolean | undefined, content: unknown): MetaVerdict {
  if (isMeta !== true || typeof content !== 'string') return null
  const text = content.trim()
  if (!text) return 'drop'
  return IMAGE_PLACEHOLDER_RE.test(text) ? 'drop' : 'line'
}
