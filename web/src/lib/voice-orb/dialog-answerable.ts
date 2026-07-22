/**
 * WHICH open questions the orb is allowed to answer OUT LOUD.
 *
 * Two surfaces reach the panel with a question the user must answer: a native
 * `AskUserQuestion` (the green banner) and a one-shot `dialog` (the modal).
 * Both are normalised here into ONE descriptor so the matcher, the announcer
 * and the tool all reason about a single shape.
 *
 * THE BAR IS DELIBERATELY HIGH. Voice can carry "the second one"; it cannot
 * carry a filled-in form, a drawing, or four questions at once. Anything that
 * is not a single single-select list of options is NOT answerable and is left
 * entirely to the visual dialog -- which stays fully usable throughout either
 * way. Refusing here is how a spoken half-answer never reaches an agent.
 *
 * And a PLAN APPROVAL is barred outright, by source, not by shape.
 */

import type { DialogComponent, DialogLayout, OptionsComponent } from '@shared/dialog-schema'

export interface VoiceOption {
  /** What gets submitted (the Options `value`, or the ask's option label). */
  value: string
  /** What the orb says. */
  label: string
  description?: string
}

export interface AnswerableDialog {
  /** Which submit path answers it. */
  kind: 'ask' | 'dialog'
  conversationId: string
  /** Identity of THIS pending interaction: toolUseId (ask) | dialogId (dialog).
   *  Everything downstream keys off it, so an answer can never land on the
   *  question that replaced the one the orb read out. */
  key: string
  /** Where the chosen value goes: the question text (ask) | block id (dialog). */
  fieldId: string
  title: string
  question: string
  options: VoiceOption[]
}

/** Blocks that take user input. Buttons are excluded on purpose: they only
 *  record an action, they are not a value the user has to supply. */
const INPUT_TYPES = new Set(['Options', 'TextInput', 'ImagePicker', 'Toggle', 'Slider', 'Draw'])

export interface PendingAsk {
  conversationId: string
  toolUseId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

export interface PendingDialog {
  conversationId: string
  dialogId: string
  layout: DialogLayout
  expired?: boolean
  /** What put the dialog up. `plan_approval` is BARRED (see below). */
  source?: string
}

/** A plan approval rides the same slot as an ordinary dialog, and submitting it
 *  means "exit plan mode and run". Nothing spoken gets to make that call, so it
 *  is refused BY NAME rather than by whatever its layout happens to look like. */
const BARRED_SOURCES = new Set(['plan_approval'])

/** Every input block in a layout, depth-first through containers. */
function inputBlocks(comps: DialogComponent[] | undefined, found: DialogComponent[] = []): DialogComponent[] {
  for (const c of comps ?? []) {
    if (INPUT_TYPES.has(c.type)) found.push(c)
    if ('children' in c) inputBlocks(c.children, found)
  }
  return found
}

function toOptions(opts: Array<{ value?: string; label: string; description?: string }>): VoiceOption[] {
  return opts
    .filter(o => typeof o.label === 'string' && o.label.trim() !== '')
    .map(o => ({ value: o.value ?? o.label, label: o.label, description: o.description }))
}

/**
 * A native AskUserQuestion, if voice can answer it whole.
 *
 * ONE question only: the response carries every answer in a single message, so
 * answering one of three by voice would submit a half-answer the agent then
 * acts on. Multi-select is out for the same reason -- "A and C" is a sentence,
 * not a selection.
 */
export function askAnswerable(ask: PendingAsk): AnswerableDialog | null {
  if (ask.questions.length !== 1) return null
  const [q] = ask.questions
  if (!q || q.multiSelect) return null
  const options = toOptions(q.options ?? [])
  if (options.length === 0) return null
  return {
    kind: 'ask',
    conversationId: ask.conversationId,
    key: ask.toolUseId,
    fieldId: q.question,
    title: q.header || 'question',
    question: q.question,
    options,
  }
}

/**
 * A one-shot dialog, if it is a pure pick-one.
 *
 * Refuses multi-page wizards (a submit only happens on the last page), expired
 * dialogs (the deadline is gone -- that is the pill's job), anything with a
 * second input block, and multi-select. What survives is a modal whose entire
 * content is one list of options.
 */
export function dialogAnswerable(pending: PendingDialog): AnswerableDialog | null {
  const { layout } = pending
  if (pending.expired) return null
  if (pending.source && BARRED_SOURCES.has(pending.source)) return null
  if (layout.pages && layout.pages.length > 1) return null
  const body = layout.body ?? layout.pages?.[0]?.body
  const inputs = inputBlocks(body)
  if (inputs.length !== 1) return null
  const [only] = inputs
  if (only?.type !== 'Options') return null
  const block = only as OptionsComponent
  if (block.multi) return null
  const options = toOptions(block.options ?? [])
  if (options.length === 0) return null
  return {
    kind: 'dialog',
    conversationId: pending.conversationId,
    key: pending.dialogId,
    fieldId: block.id,
    title: layout.title,
    question: block.label || layout.description || layout.title,
    options,
  }
}

/** Everything open right now that the orb may answer, asks first (an ask blocks
 *  the agent outright, a dialog only waits). */
export function answerableDialogs(asks: PendingAsk[], dialogs: PendingDialog[]): AnswerableDialog[] {
  const fromAsks = asks.map(askAnswerable)
  const fromDialogs = dialogs.map(dialogAnswerable)
  return [...fromAsks, ...fromDialogs].filter((d): d is AnswerableDialog => d !== null)
}
