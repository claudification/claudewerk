import { BUBBLE_COLOR_OPTIONS } from '@/components/transcript/group-view'
import { hexToRgba, OPACITY_STEPS, PALETTE, parseRgbaHex, parseRgbaOpacity } from '@/lib/color-utils'
import { cn } from '@/lib/utils'

// --- Color input with live preview ---

export function ColorInput({
  value,
  onChange,
  defaultColor,
}: {
  value: string
  onChange: (v: string) => void
  defaultColor: string
}) {
  const preview = value || defaultColor
  const currentHex = (value && parseRgbaHex(value)) || null
  const currentOpacity = value ? parseRgbaOpacity(value) : 100

  function pickColor(hex: string) {
    onChange(hexToRgba(hex, currentOpacity))
  }

  function pickOpacity(opacity: number) {
    const hex = currentHex || parseRgbaHex(defaultColor) || PALETTE[0]
    onChange(hexToRgba(hex, opacity))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {PALETTE.map(hex => (
          <button
            key={hex}
            type="button"
            aria-label={`Select color ${hex}`}
            onClick={() => pickColor(hex)}
            className={`w-5 h-5 border transition-transform hover:scale-125 ${
              currentHex === hex ? 'border-white scale-110' : 'border-border/50'
            }`}
            style={{ backgroundColor: hex }}
            title={hex}
          />
        ))}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-muted-foreground w-8 shrink-0">alpha</span>
        <div className="flex gap-0.5 flex-1">
          {OPACITY_STEPS.map(op => (
            <button
              key={op}
              type="button"
              onClick={() => pickOpacity(op)}
              className={`flex-1 h-5 text-[8px] font-mono border transition-colors ${
                currentOpacity === op
                  ? 'border-white text-foreground'
                  : 'border-border/50 text-muted-foreground hover:border-border'
              }`}
              style={{ backgroundColor: hexToRgba(currentHex || parseRgbaHex(defaultColor) || PALETTE[0], op) }}
            >
              {op}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="size-6 border border-border shrink-0" style={{ backgroundColor: preview }} />
        <span className="text-[10px] font-mono text-muted-foreground flex-1 truncate">{value || defaultColor}</span>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-[9px] text-muted-foreground hover:text-foreground shrink-0 border border-border px-1.5 py-0.5"
          >
            reset
          </button>
        )}
      </div>
    </div>
  )
}

// --- Bubble color picker ---

const BUBBLE_PREVIEW_COLORS: Record<string, string> = {
  blue: 'bg-blue-600',
  teal: 'bg-teal-600',
  purple: 'bg-purple-600',
  green: 'bg-emerald-600',
  orange: 'bg-amber-600',
  pink: 'bg-pink-600',
  indigo: 'bg-indigo-600',
}

export function BubbleColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex gap-1.5">
      {BUBBLE_COLOR_OPTIONS.map(color => (
        <button
          key={color}
          type="button"
          aria-label={`Select bubble color ${color}`}
          onClick={() => onChange(color)}
          className={cn(
            'w-5 h-5 rounded-full transition-all',
            BUBBLE_PREVIEW_COLORS[color],
            value === color
              ? 'ring-2 ring-white ring-offset-1 ring-offset-background scale-110'
              : 'opacity-70 hover:opacity-100',
          )}
          title={color}
        />
      ))}
    </div>
  )
}
