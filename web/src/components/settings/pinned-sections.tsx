/**
 * Non-SettingItem sections pinned to a tab (custom layouts: tool output,
 * project links, notifications, shortcuts, virtualizer lab, version). Each
 * declares its tab + filter matcher so the dialog can treat them uniformly.
 */

import type { ReactNode } from 'react'
import type { ControlPanelPrefs, SettingsTab } from '@/lib/control-panel-prefs'
import { ProjectLinksSection } from './conversation-links-section'
import { openManageProjectLinks } from './manage-project-links-trigger'
import { NotificationsSection } from './notifications-section'
import { PlainRendererLabSection } from './plain-renderer-lab-section'
import { GroupHeader } from './settings-inputs'
import { ShortcutsSection, shortcutsSectionMatches } from './shortcuts-section'
import { ToolDisplaySection, toolDisplayMatches } from './tool-display-section'
import { VersionSection, versionMatches } from './version-section'
import { VirtualizerLabSection } from './virtualizer-lab-section'

export interface PinnedSection {
  id: string
  tab: SettingsTab
  matches: (filter: string) => boolean
  /** Hidden entirely (even under filter) when this returns false. */
  enabled?: (prefs: ControlPanelPrefs) => boolean
  render: (filter: string) => ReactNode
}

function ProjectLinksPinned() {
  return (
    <div>
      <div className="flex items-center justify-between pt-3 pb-1 border-t border-border first:border-t-0 first:pt-0">
        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Project Links</span>
        <button
          type="button"
          onClick={() => openManageProjectLinks()}
          className="text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors px-1"
        >
          [+]
        </button>
      </div>
      <ProjectLinksSection />
    </div>
  )
}

export const PINNED_SECTIONS: PinnedSection[] = [
  {
    id: 'shortcuts',
    tab: 'input',
    matches: shortcutsSectionMatches,
    render: filter => <ShortcutsSection filter={filter} />,
  },
  {
    id: 'tool-output',
    tab: 'sessions',
    matches: toolDisplayMatches,
    render: filter => <ToolDisplaySection filter={filter} />,
  },
  {
    id: 'project-links',
    tab: 'system',
    matches: f => 'links project connect persist'.includes(f),
    render: () => <ProjectLinksPinned />,
  },
  {
    id: 'notifications',
    tab: 'system',
    matches: f => 'notifications push notify bell'.includes(f),
    render: () => (
      <div>
        <GroupHeader label="Notifications" />
        <NotificationsSection />
      </div>
    ),
  },
  {
    // Only meaningful for the TanStack virtualizer, so hidden entirely unless
    // it is the chosen renderer (even under an active filter).
    id: 'virtualizer-lab',
    tab: 'experiments',
    enabled: prefs => prefs.transcriptRenderer === 'virtualized',
    matches: f => 'virtualizer lab experiments transcript scroll follow pin jumpy'.includes(f),
    render: () => (
      <div>
        <GroupHeader label="Virtualizer Lab" />
        <VirtualizerLabSection />
      </div>
    ),
  },
  {
    // Scroll-back anchoring knobs for the plain renderer; hidden unless it is
    // the chosen renderer (even under an active filter).
    id: 'plain-renderer-lab',
    tab: 'experiments',
    enabled: prefs => prefs.transcriptRenderer === 'plain',
    matches: f =>
      'plain renderer lab experiments transcript scrollback anchor content-visibility overflow-anchor jumpy'.includes(
        f,
      ),
    render: () => (
      <div>
        <GroupHeader label="Plain Renderer Lab" />
        <PlainRendererLabSection />
      </div>
    ),
  },
  {
    id: 'version',
    tab: 'system',
    matches: versionMatches,
    render: () => <VersionSection />,
  },
]
