/**
 * Public API for <InputEditor> -- a markdown text input with pluggable backend.
 *
 * Two backends today:
 *   - 'legacy'      : textarea + transparent overlay highlight (markdown-input.tsx)
 *   - 'codemirror'  : CodeMirror 6 with @codemirror/lang-markdown
 *
 * Backend chosen via controlPanelPrefs.inputBackend. Same props for both.
 */

import type { TaskTokenContext } from '@/lib/cards/task-tokens'

export interface InputEditorProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** Second submit, fired on `Mod-Enter` (Cmd on macOS, Ctrl elsewhere).
   *  OPT-IN per instance exactly like `taskTokens`: absent everywhere but the
   *  Quick Task modal, so the prompt input never grows a second submit path.
   *  CodeMirror backend only -- the legacy textarea has no keymap layer, same
   *  as it has no task-token completion. */
  onSubmitAlt?: () => void
  disabled?: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
  /** Force inline mode: no mobile expand-on-focus, autoFocus works on mobile. */
  inline?: boolean
  /** Enable slash command / @ mention autocomplete. */
  enableAutocomplete?: boolean
  /** Highlight effort keywords (e.g. "ultrathink"). Prompt input only. */
  enableEffortKeywords?: boolean
  /** Called on Ctrl+S with the text that was in the editor (already cleared by CM). */
  onStash?: (text: string) => void
  /** Custom slash commands for the autocomplete popup. When set, these replace
   *  the conversation's slashCommands (used by the dispatcher overlay). */
  customSlashCommands?: Array<{ name: string; detail?: string }>
  /** Quick Task token completion (`@epic`, `!priority`, `+dep`, `&rel`, `#tag`).
   *  OPT-IN per instance: absent everywhere but the Quick Task modal, because
   *  `@` already means skills+agents in the prompt input. */
  taskTokens?: TaskTokenContext
}
