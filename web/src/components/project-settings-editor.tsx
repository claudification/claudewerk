import { projectIdentityKey } from '@shared/project-uri'
import { OPENCODE_TOOL_PERMISSION_OPTIONS, type OpenCodeToolPermission } from '@shared/spawn-schema'
import { Check, Pencil, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { SecurityPanel } from '@/components/project-settings/security-panel'
import { GroupHeader, SettingRow } from '@/components/settings/settings-inputs'
import { SettingsShell, type SettingsShellTab } from '@/components/settings/settings-shell'
import {
  deleteProjectSettings,
  generateProjectKeyterms,
  updateProjectSettings,
  useConversationsStore,
} from '@/hooks/use-conversations'
import { extractProjectLabel, type ProjectSettings } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ICONS } from './project-icons'

// Color palette - works on dark bg
const COLOR_OPTIONS = [
  '', // none/default
  '#7aa2f7', // blue (accent)
  '#9ece6a', // green
  '#e0af68', // amber
  '#f7768e', // red/pink
  '#bb9af7', // purple
  '#7dcfff', // cyan
  '#ff9e64', // orange
  '#c0caf5', // light blue/white
  '#73daca', // teal
  '#db4b4b', // dark red
]

interface ProjectSettingsEditorProps {
  project: string
  onClose: () => void
}

const PROJECT_TABS: SettingsShellTab[] = [
  { id: 'general', label: 'General' },
  { id: 'launch', label: 'Launch' },
  { id: 'security', label: 'Security' },
]

export function ProjectSettingsEditor({ project, onClose }: ProjectSettingsEditorProps) {
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const setProjectSettings = useConversationsStore(s => s.setProjectSettings)
  const current = projectSettings[projectIdentityKey(project)] || {}

  const [activeTab, setActiveTab] = useState('general')
  const [label, setLabel] = useState(current.label || '')
  const [icon, setIcon] = useState(current.icon || '')
  const [color, setColor] = useState(current.color || '')
  const [description, setDescription] = useState(current.description || '')
  const [keyterms, setKeyterms] = useState<string[]>(current.keyterms || [])
  const [trustLevel, setTrustLevel] = useState<string>(current.trustLevel || 'default')
  const [launchMode, setLaunchMode] = useState<string>(current.defaultLaunchMode || 'headless')
  const [effort, setEffort] = useState<string>(current.defaultEffort || 'default')
  const [model, setModel] = useState<string>(current.defaultModel || '')
  const [openCodeModel, setOpenCodeModel] = useState<string>(current.defaultOpenCodeModel || '')
  const [openCodeToolPermission, setOpenCodeToolPermission] = useState<OpenCodeToolPermission>(
    (current.defaultOpenCodeToolPermission ?? 'safe') as OpenCodeToolPermission,
  )
  const [keytermInput, setKeytermInput] = useState('')
  const [iconSearch, setIconSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  useEffect(() => {
    const c = projectSettings[projectIdentityKey(project)] || {}
    setLabel(c.label || '')
    setIcon(c.icon || '')
    setColor(c.color || '')
    setDescription(c.description || '')
    setKeyterms(c.keyterms || [])
    setTrustLevel(c.trustLevel || 'default')
    setLaunchMode(c.defaultLaunchMode || 'headless')
    setEffort(c.defaultEffort || 'default')
    setModel(c.defaultModel || '')
    setOpenCodeModel(c.defaultOpenCodeModel || '')
    setOpenCodeToolPermission((c.defaultOpenCodeToolPermission ?? 'safe') as OpenCodeToolPermission)
  }, [projectSettings, project])

  const filteredIcons = useMemo(() => {
    if (!iconSearch.trim()) return ICONS
    const q = iconSearch.toLowerCase().trim()
    return ICONS.filter(e => e.id.includes(q) || e.keywords.includes(q))
  }, [iconSearch])

  async function handleSave() {
    setSaving(true)
    const settings: ProjectSettings = {
      label: label.trim() || '',
      icon: icon || '',
      color: color || '',
      description: description.trim() || '',
      keyterms: keyterms.length ? keyterms : [],
      trustLevel: trustLevel === 'default' ? undefined : (trustLevel as 'open' | 'benevolent'),
      defaultLaunchMode: launchMode === 'headless' ? undefined : (launchMode as 'pty'),
      defaultEffort: effort === 'default' ? undefined : (effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max'),
      defaultModel: model.trim() || undefined,
      defaultOpenCodeModel: openCodeModel.trim() || undefined,
      defaultOpenCodeToolPermission: openCodeToolPermission === 'safe' ? undefined : openCodeToolPermission,
    }
    updateProjectSettings(project, settings)
    setSaving(false)
    onClose()
  }

  async function handleGenerateKeyterms() {
    setGenerating(true)
    setGenerateError(null)
    try {
      const result = await generateProjectKeyterms(project)
      if (result) {
        setKeyterms(result.keyterms)
        setProjectSettings(result.settings)
      }
    } catch (err: unknown) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate')
    }
    setGenerating(false)
  }

  function addKeyterm() {
    const term = keytermInput.trim()
    if (term && !keyterms.includes(term)) {
      setKeyterms([...keyterms, term])
      setKeytermInput('')
    }
  }

  function removeKeyterm(term: string) {
    setKeyterms(keyterms.filter(t => t !== term))
  }

  function handleClear() {
    setSaving(true)
    deleteProjectSettings(project)
    setSaving(false)
    onClose()
  }

  const hasChanges =
    label.trim() !== (current.label || '') ||
    icon !== (current.icon || '') ||
    color !== (current.color || '') ||
    description.trim() !== (current.description || '') ||
    JSON.stringify(keyterms) !== JSON.stringify(current.keyterms || []) ||
    trustLevel !== (current.trustLevel || 'default') ||
    launchMode !== (current.defaultLaunchMode || 'headless') ||
    effort !== (current.defaultEffort || 'default') ||
    model.trim() !== (current.defaultModel || '') ||
    openCodeModel.trim() !== (current.defaultOpenCodeModel || '') ||
    openCodeToolPermission !== ((current.defaultOpenCodeToolPermission ?? 'safe') as OpenCodeToolPermission)

  const hasAnySettings =
    current.label ||
    current.icon ||
    current.color ||
    current.description ||
    (current.keyterms?.length ?? 0) > 0 ||
    current.trustLevel

  return (
    <SettingsShell
      open
      onOpenChange={v => {
        if (!v) onClose()
      }}
      title="Project Configuration"
      tabs={PROJECT_TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      maxWidth="md"
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border transition-colors',
              hasChanges
                ? 'border-accent bg-accent/20 text-accent hover:bg-accent/30'
                : 'border-border text-muted-foreground cursor-not-allowed',
            )}
          >
            <Check className="size-3" />
            Save
          </button>
          {hasAnySettings && (
            <button
              type="button"
              onClick={handleClear}
              disabled={saving}
              className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border border-red-500/50 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 className="size-3" />
              Reset All
            </button>
          )}
        </div>
      }
    >
      <div className="text-xs space-y-3">
        {/* ── General tab ──────────────────────────────────────────── */}
        {activeTab === 'general' && (
          <>
            <div className="text-[10px] text-muted-foreground/60 font-mono truncate mb-2" title={project}>
              {project}
            </div>
            <GroupHeader label="Identity" />
            <SettingRow label="Label" description="Display name for this project">
              <input
                aria-label="Project label"
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder={extractProjectLabel(project) || 'project name'}
                className="w-40 bg-background border border-border px-2 py-1.5 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                style={{ fontSize: '16px' }}
              />
            </SettingRow>

            <div>
              <SettingRow label="Description" description="Visible to other conversations via list_conversations">
                <span />
              </SettingRow>
              <textarea
                aria-label="Project description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="e.g. Send all music generation requests here"
                rows={2}
                className="w-full bg-background border border-border px-2 py-1.5 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50 resize-none mt-1"
                style={{ fontSize: '16px' }}
              />
            </div>

            <GroupHeader label="Appearance" />

            {/* Icon picker */}
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Icon</div>
              <div className="relative mb-1.5">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
                <input
                  aria-label="Search icons"
                  type="text"
                  value={iconSearch}
                  onChange={e => setIconSearch(e.target.value)}
                  placeholder="Search icons..."
                  className="w-full bg-background border border-border pl-6 pr-2 py-1 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                  style={{ fontSize: '16px' }}
                />
              </div>
              <div className="flex flex-wrap gap-1 max-h-[120px] overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setIcon('')}
                  className={cn(
                    'w-8 h-8 flex items-center justify-center border transition-colors',
                    icon === ''
                      ? 'border-accent bg-accent/20 text-accent'
                      : 'border-border hover:border-primary hover:bg-muted/30 text-muted-foreground',
                  )}
                >
                  <span className="text-[10px]">--</span>
                </button>
                {filteredIcons.map(entry => {
                  const IconComp = entry.icon
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setIcon(entry.id)}
                      title={entry.id}
                      className={cn(
                        'w-8 h-8 flex items-center justify-center border transition-colors',
                        icon === entry.id
                          ? 'border-accent bg-accent/20 text-accent'
                          : 'border-border hover:border-primary hover:bg-muted/30 text-muted-foreground',
                      )}
                    >
                      <IconComp className="size-4" />
                    </button>
                  )
                })}
                {filteredIcons.length === 0 && (
                  <span className="text-muted-foreground text-[10px] py-2 px-1">No icons match "{iconSearch}"</span>
                )}
              </div>
              {icon && (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  Selected: <span className="text-accent">{icon}</span>
                </div>
              )}
            </div>

            {/* Color picker */}
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Color</div>
              <div className="flex flex-wrap gap-1">
                {COLOR_OPTIONS.map(c => (
                  <button
                    key={c || '__none__'}
                    type="button"
                    onClick={() => setColor(c)}
                    className={cn(
                      'w-8 h-8 border transition-colors',
                      color === c ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-primary',
                    )}
                    style={c ? { backgroundColor: c } : undefined}
                  >
                    {!c && (
                      <span className="text-muted-foreground text-[10px] flex items-center justify-center h-full">
                        --
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <GroupHeader label="Voice" />

            {/* Keyterms */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Keyterms</span>
                <button
                  type="button"
                  onClick={handleGenerateKeyterms}
                  disabled={generating}
                  className="text-[10px] text-accent hover:text-accent/80 disabled:text-muted-foreground transition-colors"
                >
                  {generating ? 'Generating...' : 'Auto-generate'}
                </button>
              </div>
              {generateError && <div className="text-[10px] text-red-400 mb-1">{generateError}</div>}
              <div className="flex flex-wrap gap-1 mb-1.5">
                {keyterms.map(term => (
                  <span
                    key={term}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-accent/10 border border-accent/30 text-accent text-[10px] font-mono"
                  >
                    {term}
                    <button type="button" onClick={() => removeKeyterm(term)} className="hover:text-red-400 ml-0.5">
                      <X className="size-2.5" />
                    </button>
                  </span>
                ))}
                {keyterms.length === 0 && (
                  <span className="text-muted-foreground text-[10px]">
                    No keyterms -- voice transcription uses defaults
                  </span>
                )}
              </div>
              <div className="flex gap-1">
                <input
                  aria-label="Add keyterm for voice transcription"
                  type="text"
                  value={keytermInput}
                  onChange={e => setKeytermInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addKeyterm()
                    }
                  }}
                  placeholder="Add term..."
                  className="flex-1 bg-background border border-border px-2 py-1 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                  style={{ fontSize: '16px' }}
                />
                <button
                  type="button"
                  onClick={addKeyterm}
                  disabled={!keytermInput.trim()}
                  className="px-2 py-1 text-[10px] font-bold border border-border text-muted-foreground hover:text-accent hover:border-accent disabled:opacity-30 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Launch tab ───────────────────────────────────────────── */}
        {activeTab === 'launch' && (
          <>
            <GroupHeader label="Conversation Defaults" />

            <SettingRow label="Launch mode" description="Used when spawning/reviving conversations for this project">
              <div className="flex gap-1">
                {[
                  { value: 'headless', label: 'Headless' },
                  { value: 'pty', label: 'PTY' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setLaunchMode(opt.value)}
                    className={cn(
                      'px-2 py-1 text-[10px] font-mono border rounded transition-colors',
                      launchMode === opt.value
                        ? opt.value === 'headless'
                          ? 'border-cyan-500 bg-cyan-500/20 text-cyan-400'
                          : 'border-purple-500 bg-purple-500/20 text-purple-400'
                        : 'border-border/50 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </SettingRow>

            <SettingRow label="Effort" description="Passed as --effort flag when launching conversations">
              <div className="flex gap-1 flex-wrap">
                {[
                  { value: 'default', label: 'Default' },
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Med' },
                  { value: 'high', label: 'High' },
                  { value: 'xhigh', label: 'XH' },
                  { value: 'max', label: 'Max' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEffort(opt.value)}
                    className={cn(
                      'px-1.5 py-0.5 text-[10px] font-mono border rounded transition-colors',
                      effort === opt.value
                        ? opt.value === 'default'
                          ? 'border-border bg-muted text-foreground'
                          : opt.value === 'low'
                            ? 'border-blue-500 bg-blue-500/20 text-blue-400'
                            : opt.value === 'medium'
                              ? 'border-green-500 bg-green-500/20 text-green-400'
                              : opt.value === 'high'
                                ? 'border-orange-500 bg-orange-500/20 text-orange-400'
                                : 'border-red-500 bg-red-500/20 text-red-400'
                        : 'border-border/50 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </SettingRow>

            <SettingRow label="Model" description="Passed as --model flag when launching conversations">
              <input
                aria-label="Default model for launches"
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="e.g. sonnet, opus"
                className="w-36 bg-background border border-border px-2 py-1.5 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                style={{ fontSize: '16px' }}
              />
            </SettingRow>

            <SettingRow
              label="OpenCode model"
              description="Default for OpenCode spawns from this project (empty = use global, then opencode-go/glm-5.1)"
            >
              <input
                aria-label="Default OpenCode model for this project"
                type="text"
                value={openCodeModel}
                onChange={e => setOpenCodeModel(e.target.value)}
                placeholder="opencode-go/glm-5.1"
                spellCheck={false}
                autoCapitalize="off"
                className="w-72 bg-background border border-border px-2 py-1.5 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                style={{ fontSize: '16px' }}
              />
            </SettingRow>

            {project.startsWith('opencode://') && (
              <SettingRow
                label="OpenCode tools"
                description={
                  OPENCODE_TOOL_PERMISSION_OPTIONS.find(o => o.value === openCodeToolPermission)?.info ||
                  'Tool permission tier for OpenCode spawns in this project'
                }
              >
                <select
                  value={openCodeToolPermission}
                  onChange={e => setOpenCodeToolPermission(e.target.value as OpenCodeToolPermission)}
                  className="bg-background border border-border px-2 py-1.5 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                  style={{ fontSize: '16px' }}
                >
                  {OPENCODE_TOOL_PERMISSION_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </SettingRow>
            )}
          </>
        )}

        {/* ── Security tab ─────────────────────────────────────────── */}
        {activeTab === 'security' && (
          <SecurityPanel project={project} trustLevel={trustLevel} onTrustLevelChange={setTrustLevel} />
        )}
      </div>
    </SettingsShell>
  )
}

// Small edit button to open settings editor
export function ProjectSettingsButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:text-accent transition-colors p-0.5"
      title="Edit project settings"
    >
      <Pencil className="size-3" />
    </button>
  )
}
