import { X } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  FONT_SIZES,
  FONTS,
  RENDERERS,
  saveTerminalSettings,
  type TerminalSettings,
  THEMES,
} from './terminal-settings-storage'

interface TerminalSettingsPanelProps {
  settings: TerminalSettings
  onChange: (settings: TerminalSettings) => void
  onClose: () => void
}

export function TerminalSettingsPanel({ settings, onChange, onClose }: TerminalSettingsPanelProps) {
  const [local, setLocal] = useState(settings)

  function update(patch: Partial<TerminalSettings>) {
    const next = { ...local, ...patch }
    setLocal(next)
    saveTerminalSettings(next)
    onChange(next)
  }

  return (
    <div className="absolute top-10 right-2 z-50 w-72 bg-surface-inset border border-primary/20 shadow-2xl font-mono text-xs">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-primary/20">
        <span className="text-[10px] uppercase tracking-wider text-comment">Terminal Settings</span>
        <button type="button" onClick={onClose} className="text-comment hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>

      {/* Theme */}
      <div className="px-3 py-2 border-b border-primary/20/50">
        <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Theme</div>
        <div className="grid grid-cols-3 gap-1">
          {Object.entries(THEMES).map(([id, theme]) => (
            <button
              key={id}
              type="button"
              onClick={() => update({ themeId: id })}
              className={cn(
                'px-1.5 py-1.5 text-[10px] rounded border transition-colors text-left',
                local.themeId === id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-comment hover:text-foreground hover:border-primary/20',
              )}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <div className="size-3 rounded-sm border border-white/10" style={{ background: theme.background }}>
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="w-1.5 h-0.5 rounded-full" style={{ background: theme.green }} />
                  </div>
                </div>
                <span className="truncate">{theme.name}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Font */}
      <div className="px-3 py-2 border-b border-primary/20/50">
        <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Font</div>
        <div className="space-y-0.5">
          {FONTS.map(font => (
            <button
              key={font.id}
              type="button"
              onClick={() => update({ fontId: font.id })}
              className={cn(
                'w-full px-2 py-1 text-left rounded transition-colors',
                local.fontId === font.id
                  ? 'text-foreground bg-primary/50'
                  : 'text-comment hover:text-foreground hover:bg-primary/25',
              )}
              style={{ fontFamily: font.family }}
            >
              {font.name}
            </button>
          ))}
        </div>
      </div>

      {/* Font Size */}
      <div className="px-3 py-2 border-b border-primary/20/50">
        <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Size</div>
        <div className="flex items-center gap-1 flex-wrap">
          {FONT_SIZES.map(size => (
            <button
              key={size}
              type="button"
              onClick={() => update({ fontSize: size })}
              className={cn(
                'w-7 h-7 flex items-center justify-center rounded transition-colors',
                local.fontSize === size
                  ? 'text-foreground bg-primary/50 border border-primary'
                  : 'text-comment hover:text-foreground border border-transparent hover:border-primary/20',
              )}
            >
              {size}
            </button>
          ))}
        </div>
      </div>

      {/* Renderer */}
      <div className="px-3 py-2">
        <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Renderer</div>
        <div className="space-y-0.5">
          {RENDERERS.map(r => (
            <button
              key={r.id}
              type="button"
              onClick={() => update({ rendererId: r.id })}
              className={cn(
                'w-full px-2 py-1 text-left rounded transition-colors',
                local.rendererId === r.id
                  ? 'text-foreground bg-primary/50'
                  : 'text-comment hover:text-foreground hover:bg-primary/25',
              )}
            >
              {r.name}
              <span className="block text-[9px] text-comment">{r.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
