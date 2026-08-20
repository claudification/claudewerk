/**
 * ONE waiting question: who is asking, what it asks, how long it has waited, and
 * the buttons that end it.
 *
 * THE CLOCK IS THE POINT. It is passed a `now` that ticks once a second rather
 * than reading the clock at render, so a row that nobody re-renders still counts
 * up. The twelve minutes a dialog sat unanswered on 2026-08-19 is the number
 * this cell exists to make impossible to miss.
 *
 * The project chip is a SIBLING of the row's content, and its click goes through
 * the filter store's own `toggleProject` -- the wall has exactly one
 * implementation of that action and it is not in this file.
 *
 * ONLY THE TITLE NAVIGATES. Every other target on this row ENDS the wait where
 * it stands: the answer buttons carry the conversation's own store action and
 * the chip filters the wall. A row that shipped you to the dashboard on any
 * click would make answering ten questions ten round trips, which is the exact
 * workflow this pane exists to remove.
 */

import { ProjectTag } from '@/components/project-tag'
import { formatDurationShort } from '@/lib/status-style'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import type { AttentionEntry } from './attention-entries'
import { navigateFromWall } from './wall-navigate'

export function AttentionRow({ entry, index, now }: { entry: AttentionEntry; index?: number; now: number }) {
  const toggleProject = useWallFilterStore(s => s.toggleProject)
  const waited = formatDurationShort(Math.max(0, now - entry.since))

  return (
    <li className="wall-att" data-tier={entry.tier} data-kind={entry.kind} data-key={entry.key}>
      <div className="wall-att-head">
        {index !== undefined && <span className="wall-att-num">{index}</span>}
        <button
          type="button"
          title={`Filter the whole wall to ${entry.project}`}
          onClick={() => toggleProject(entry.project)}
          className="wall-att-proj"
        >
          <ProjectTag name={entry.project} icon={entry.projectIcon} color={entry.projectColor} />
        </button>
        <button
          type="button"
          className="wall-att-title"
          title={`Open ${entry.title} in the main window -- the buttons below answer without leaving`}
          onClick={() => navigateFromWall({ kind: 'conversation', id: entry.conversationId, via: 'wall-attention' })}
        >
          {entry.title}
        </button>
        <span className="wall-att-wait" title={`waiting since ${new Date(entry.since).toLocaleTimeString()}`}>
          {waited}
        </span>
      </div>

      <p className="wall-att-q">{entry.question}</p>
      {entry.detail && <pre className="wall-att-detail">{entry.detail}</pre>}

      {entry.actions.length > 0 && (
        <div className="wall-att-acts">
          {entry.actions.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className="wall-btn wall-att-btn"
              data-tone={a.tone}
              data-primary={i === 0 || undefined}
              onClick={a.run}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {/* A row with no buttons has to SAY why, or it reads as "this one is fine". */}
      {entry.hint && <p className="wall-att-hint">{entry.hint}</p>}
    </li>
  )
}
