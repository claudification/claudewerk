import { Save } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import type { ControlPanelPrefs, SettingsTab } from '@/lib/control-panel-prefs'
import { PINNED_SECTIONS, type PinnedSection } from './settings/pinned-sections'
import { SettingsGroups } from './settings/settings-groups'
import type { SettingItem, SettingsContext } from './settings/settings-item'
import { DASHBOARD_TABS, SETTINGS } from './settings/settings-registry'
import { SettingsShell } from './settings/settings-shell'

function filterSettings(lowerFilter: string): SettingItem[] {
  return SETTINGS.filter(
    s =>
      s.label.toLowerCase().includes(lowerFilter) ||
      s.description.toLowerCase().includes(lowerFilter) ||
      s.group.toLowerCase().includes(lowerFilter) ||
      s.keywords?.toLowerCase().includes(lowerFilter),
  )
}

// Stored tab may be a removed legacy id ('general') -- fall back to Display.
function resolveActiveTab(stored: SettingsTab): SettingsTab {
  return DASHBOARD_TABS.some(t => t.id === stored) ? stored : 'display'
}

function visiblePinned(prefs: ControlPanelPrefs, activeTab: SettingsTab, lowerFilter: string): PinnedSection[] {
  return PINNED_SECTIONS.filter(sec => {
    if (sec.enabled && !sec.enabled(prefs)) return false
    return lowerFilter ? sec.matches(lowerFilter) : sec.tab === activeTab
  })
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [filter, setFilter] = useState('')
  const globalSettings = useConversationsStore(s => s.globalSettings)
  const prefs = useConversationsStore(s => s.controlPanelPrefs)
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)

  // Local draft of server settings (only committed on Save)
  const [serverDraft, setServerDraft] = useState<Record<string, unknown>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)

  // Sync draft from server on open or when globalSettings change
  useEffect(() => {
    setServerDraft({ ...globalSettings })
    setDirty(false)
  }, [globalSettings])

  function setServer(key: string, value: unknown) {
    setServerDraft(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  function handleSave() {
    setSaving(true)
    const sent = wsSend('update_settings', { settings: serverDraft })
    if (sent) setDirty(false)
    setSaving(false)
  }

  const ctx: SettingsContext = { server: serverDraft, setServer, prefs, updatePrefs }

  // Filter settings (flat view; tabs hidden while a filter is active)
  const lowerFilter = filter.toLowerCase()
  const isFiltering = lowerFilter.length > 0
  const filtered = useMemo(() => (lowerFilter ? filterSettings(lowerFilter) : SETTINGS), [lowerFilter])

  const activeTab = resolveActiveTab(prefs.settingsTab)
  const visibleItems = isFiltering ? filtered : SETTINGS.filter(s => s.tab === activeTab)
  const pinned = visiblePinned(prefs, activeTab, lowerFilter)

  // Focus filter on open
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => filterRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open])

  return (
    <SettingsShell
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      tabs={DASHBOARD_TABS}
      activeTab={activeTab}
      onTabChange={v => updatePrefs({ settingsTab: v as SettingsTab })}
      showTabs={!isFiltering}
      wide
      headerContent={
        <input
          aria-label="Search settings"
          ref={filterRef}
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter settings..."
          className="w-full px-3 py-1.5 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-ring"
        />
      }
      footer={
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border transition-colors ${
              dirty
                ? 'border-active/50 text-active hover:bg-active/20'
                : 'border-border text-muted-foreground/40 cursor-not-allowed'
            }`}
          >
            <Save className="size-3" />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      }
    >
      <SettingsGroups items={visibleItems} ctx={ctx} />
      {pinned.map(sec => (
        <div key={sec.id}>{sec.render(lowerFilter)}</div>
      ))}
    </SettingsShell>
  )
}
