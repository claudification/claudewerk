/**
 * The BASIC tab: the things a schedule cannot be created without.
 *
 * The prompt gets the most room on the form deliberately -- every other field
 * has a defensible default, and this one is the entire payload. A schedule with
 * a perfect cron and a vague prompt is a schedule that wastes tokens on a timer.
 *
 * WHERE it runs (project / directory / host) is its own section in
 * `where-fields.tsx`: those three travel together and are seeded together.
 */

import { cn } from '@/lib/utils'
import { Field, INPUT_CLASS } from './field'
import type { ScheduleDraft } from './use-schedule-draft'
import { WhenField } from './when-field'
import { WhereFields } from './where-fields'

export function ScheduleBasicTab({
  draft,
  patch,
}: {
  draft: ScheduleDraft
  patch: (next: Partial<ScheduleDraft>) => void
}) {
  return (
    <>
      <Field label="Name">
        <input
          aria-label="Schedule name"
          value={draft.name}
          onChange={e => patch({ name: e.target.value })}
          placeholder="nightly audit"
          className={INPUT_CLASS}
        />
      </Field>

      <Field label="Prompt">
        <textarea
          aria-label="Prompt"
          value={draft.prompt}
          onChange={e => patch({ prompt: e.target.value })}
          rows={8}
          placeholder="What should this run do, every time it fires?"
          className={cn(INPUT_CLASS, 'resize-y min-h-[8rem] leading-relaxed')}
        />
      </Field>

      <div className="space-y-1">
        <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">Schedule</div>
        <WhenField draft={draft} patch={patch} />
      </div>

      <WhereFields draft={draft} patch={patch} />
    </>
  )
}
