/**
 * The BASIC tab: the four things a schedule cannot be created without.
 *
 * The prompt gets the most room on the form deliberately -- every other field
 * has a defensible default, and this one is the entire payload. A schedule with
 * a perfect cron and a vague prompt is a schedule that wastes tokens on a timer.
 */

import type React from 'react'
import { cn } from '@/lib/utils'
import { CronField } from './cron-field'
import type { ScheduleDraft } from './use-schedule-draft'

const INPUT_CLASS =
  'w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">{label}</div>
      {children}
    </div>
  )
}

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

      <CronField
        cron={draft.cron}
        tz={draft.tz}
        onCronChange={cron => patch({ cron })}
        onTzChange={tz => patch({ tz })}
      />

      <Field label="Working directory">
        <input
          aria-label="Working directory"
          value={draft.cwd}
          onChange={e => patch({ cwd: e.target.value })}
          spellCheck={false}
          className={INPUT_CLASS}
        />
      </Field>
    </>
  )
}
