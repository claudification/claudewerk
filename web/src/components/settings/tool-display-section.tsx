/** Per-tool output defaults (open/closed + line limit) -- Conversations tab. */

import { useConversationsStore } from '@/hooks/use-conversations'
import { resolveToolDisplay, TOOL_DISPLAY_KEYS } from '@/lib/control-panel-prefs'
import { GroupHeader } from './settings-inputs'

const SECTION_TERMS = 'tool output verbose'

export function toolDisplayMatches(filter: string): boolean {
  return SECTION_TERMS.includes(filter) || TOOL_DISPLAY_KEYS.some(t => t.toLowerCase().includes(filter))
}

export function ToolDisplaySection({ filter }: { filter: string }) {
  const prefs = useConversationsStore(s => s.controlPanelPrefs)
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)
  const sectionMatch = SECTION_TERMS.includes(filter)
  const tools = TOOL_DISPLAY_KEYS.filter(t => !filter || sectionMatch || t.toLowerCase().includes(filter))
  return (
    <div>
      <GroupHeader label="Tool output" />
      <div className="space-y-1">
        {tools.map(tool => {
          const effective = resolveToolDisplay(prefs, tool)
          const custom = prefs.toolDisplay?.[tool]
          return (
            <div key={tool} className="flex items-center gap-2 text-xs font-mono">
              <span className="w-20 text-muted-foreground truncate">{tool}</span>
              <button
                type="button"
                onClick={() => {
                  const td = { ...prefs.toolDisplay }
                  td[tool] = { ...td[tool], defaultOpen: !effective.defaultOpen }
                  updatePrefs({ toolDisplay: td })
                }}
                className={`px-1.5 py-0.5 text-[9px] border transition-colors ${
                  effective.defaultOpen
                    ? 'border-active/50 text-active bg-active/10'
                    : 'border-border text-muted-foreground'
                }`}
                title="Default expanded in verbose mode"
              >
                {effective.defaultOpen ? 'open' : 'closed'}
              </button>
              <select
                value={effective.lineLimit}
                onChange={e => {
                  const td = { ...prefs.toolDisplay }
                  td[tool] = { ...td[tool], lineLimit: Number(e.target.value) }
                  updatePrefs({ toolDisplay: td })
                }}
                className="bg-card border border-border text-foreground text-[10px] px-1 py-0.5"
                title="Line truncation limit (0 = no limit)"
              >
                {[0, 5, 10, 15, 20, 30, 50, 100].map(n => (
                  <option key={n} value={n}>
                    {n === 0 ? 'all' : `${n}L`}
                  </option>
                ))}
              </select>
              {custom && (
                <button
                  type="button"
                  onClick={() => {
                    const td = { ...prefs.toolDisplay }
                    delete td[tool]
                    updatePrefs({ toolDisplay: td })
                  }}
                  className="text-[8px] text-muted-foreground hover:text-foreground"
                  title="Reset to default"
                >
                  x
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
