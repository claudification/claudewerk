/**
 * The scanner opt-in as it actually persists: tick a box, hit Save, and see what
 * goes on the wire.
 *
 * The panel's own test covers the rendering. This one covers the two things only
 * the editor can get wrong -- packing the toggles before sending them, and never
 * sending `scannersLastRun`, which the broker owns and a shallow merge would
 * otherwise let the UI erase.
 */

import { projectIdentityKey } from '@shared/project-uri'
import type { ProjectSettings } from '@shared/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSettingsEditor } from './project-settings-editor'

const PROJECT = 'claude://default/Users/jonas/projects/demo'
const KEY = projectIdentityKey(PROJECT)

// Hoisted, because `vi.mock`'s factory is lifted above every other statement in
// the file and would otherwise read these before they exist.
const { storeState, updateProjectSettings } = vi.hoisted(() => ({
  storeState: { projectSettings: {} as Record<string, unknown>, setProjectSettings: vi.fn() },
  updateProjectSettings: vi.fn(),
}))

vi.mock('@/hooks/use-conversations', () => {
  const useConversationsStore = (selector: (s: typeof storeState) => unknown) => selector(storeState)
  useConversationsStore.getState = () => storeState
  return {
    useConversationsStore,
    updateProjectSettings,
    deleteProjectSettings: vi.fn(),
    generateProjectKeyterms: vi.fn(),
  }
})
// The Security tab's editor reaches for the same hook module for config RPCs the
// mock above does not carry. This panel is not what is under test.
vi.mock('@/components/settings/permission-rules-editor', () => ({
  PermissionRulesEditor: () => <div data-testid="permission-rules" />,
}))

function open(current: ProjectSettings = {}) {
  storeState.projectSettings = { [KEY]: current }
  render(<ProjectSettingsEditor project={PROJECT} onClose={vi.fn()} />)
  // MOUSEDOWN, not click: a Radix tab switches on mousedown/focus, and a bare
  // click event in jsdom leaves the shell sitting on the General tab.
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Scanners' }))
}

/** What `updateProjectSettings` was last handed. */
function saved(): ProjectSettings {
  return updateProjectSettings.mock.calls.at(-1)?.[1] as ProjectSettings
}

beforeEach(() => {
  updateProjectSettings.mockClear()
})
afterEach(cleanup)

describe('ProjectSettingsEditor -- the Scanners tab', () => {
  it('starts with every box off for a project that was never configured', () => {
    open()
    for (const box of screen.getAllByRole('checkbox')) expect((box as HTMLInputElement).checked).toBe(false)
  })

  it('sends only the ticked scanner, packed', () => {
    open()
    fireEvent.click(screen.getByLabelText('Enable the Epics scanner for this project'))
    fireEvent.click(screen.getByText('Save'))
    expect(saved().scanners).toEqual({ epics: true })
  })

  it('sends `undefined` when the last box is unticked, so all-off leaves no row', () => {
    open({ scanners: { epics: true } })
    fireEvent.click(screen.getByLabelText('Enable the Epics scanner for this project'))
    fireEvent.click(screen.getByText('Save'))
    expect(saved().scanners).toBeUndefined()
  })

  it('never sends the last-run stamps back -- the broker owns those', () => {
    open({ scanners: { epics: true }, scannersLastRun: { epics: 1234 } })
    fireEvent.click(screen.getByLabelText('Enable the Refine scanner for this project'))
    fireEvent.click(screen.getByText('Save'))
    expect(saved().scanners).toEqual({ epics: true, refine: true })
    expect('scannersLastRun' in saved()).toBe(false)
  })

  it('leaves Save dark until something actually changes', () => {
    open({ scanners: { epics: true } })
    expect((screen.getByText('Save').closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('lights Save when a box is ticked, and darkens it again when it is unticked', () => {
    open({ scanners: { epics: true } })
    const box = screen.getByLabelText('Enable the Refine scanner for this project')
    const save = () => screen.getByText('Save').closest('button') as HTMLButtonElement
    fireEvent.click(box)
    expect(save().disabled).toBe(false)
    fireEvent.click(box)
    expect(save().disabled).toBe(true)
  })

  it('shows the saved stamp for a scanner that has run', () => {
    open({ scanners: { epics: true }, scannersLastRun: { epics: Date.now() - 120_000 } })
    expect(screen.getByText('last ran 2m ago')).toBeDefined()
  })
})
