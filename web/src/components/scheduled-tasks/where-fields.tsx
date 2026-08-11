/**
 * WHERE a schedule runs: project, working directory, host.
 *
 * All three are seeded from the project you opened the editor on
 * (`projectDefaults`), so the common case is a form you never touch. They stay
 * three separate controls because they are three separate decisions: the
 * project is IDENTITY (permission scoping, the sidebar badge), the cwd is an
 * opaque path handed to the sentinel, and the host is routing.
 *
 * Changing the project re-seeds the other two -- a directory from the previous
 * project is worse than a default, since it may not exist on the new host.
 */

import { DEFAULT_SENTINEL_NAME } from '@shared/project-uri'
import { useState } from 'react'
import { ProjectUriBuilder } from '../launch-profiles/project-uri-builder'
import { SentinelPicker, useSentinelOptions } from '../sentinel-picker'
import { Field, INPUT_CLASS } from './field'
import { projectDefaults, type ScheduleDraft } from './use-schedule-draft'

export function WhereFields({ draft, patch }: { draft: ScheduleDraft; patch: (next: Partial<ScheduleDraft>) => void }) {
  // Open the builder unprompted when there is no project at all -- that form
  // cannot be saved, and the user should not have to discover why.
  const [building, setBuilding] = useState(!draft.projectUri)
  const options = useSentinelOptions()

  function applyProject(uri: string) {
    patch({ projectUri: uri, ...projectDefaults(uri) })
    setBuilding(false)
  }

  return (
    <>
      <Field label="Project">
        {building ? (
          <ProjectUriBuilder initialUri={draft.projectUri} onApply={applyProject} onClose={() => setBuilding(false)} />
        ) : (
          <div className="flex items-center justify-between gap-2">
            <code className="truncate font-mono text-[11px] text-primary">{draft.projectUri}</code>
            <button
              type="button"
              onClick={() => setBuilding(true)}
              className="shrink-0 px-2 py-0.5 text-[10px] font-mono text-comment hover:text-foreground transition-colors"
            >
              Change
            </button>
          </div>
        )}
      </Field>

      <Field label="Working directory">
        <input
          aria-label="Working directory"
          value={draft.cwd}
          onChange={e => patch({ cwd: e.target.value })}
          spellCheck={false}
          className={INPUT_CLASS}
        />
      </Field>

      <SentinelPicker
        label="Run on"
        options={options}
        // An unset sentinel means "the default host" to the broker, so that is
        // what the picker must show selected -- not an empty row.
        value={draft.sentinel ?? DEFAULT_SENTINEL_NAME}
        onChange={alias => patch({ sentinel: alias === DEFAULT_SENTINEL_NAME ? undefined : alias })}
        hint={draft.sentinel ? undefined : 'Unpinned -- the broker uses the default sentinel.'}
      />
    </>
  )
}
