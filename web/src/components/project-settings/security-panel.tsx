import { PermissionRulesEditor } from '@/components/settings/permission-rules-editor'
import { GroupHeader, SettingRow } from '@/components/settings/settings-inputs'
import { cn } from '@/lib/utils'

const TRUST_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'open', label: 'Open' },
  { value: 'benevolent', label: 'Benevolent' },
] as const

function trustButtonClass(opt: string, current: string): string {
  if (current !== opt) {
    return 'border-border/50 text-muted-foreground hover:text-foreground'
  }
  if (opt === 'open') return 'border-green-500 bg-green-500/20 text-green-400'
  if (opt === 'benevolent') return 'border-amber-500 bg-amber-500/20 text-amber-400'
  return 'border-border bg-muted text-foreground'
}

export function SecurityPanel({
  project,
  trustLevel,
  onTrustLevelChange,
}: {
  project: string
  trustLevel: string
  onTrustLevelChange: (next: string) => void
}) {
  return (
    <>
      <GroupHeader label="Trust" />
      <SettingRow label="Trust level" description="Controls inter-conversation messaging approval">
        <div className="flex gap-1">
          {TRUST_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onTrustLevelChange(opt.value)}
              className={cn(
                'px-2 py-1 text-[10px] font-mono border rounded transition-colors',
                trustButtonClass(opt.value, trustLevel),
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingRow>
      <GroupHeader label="Permission Rules" />
      <div className="text-[9px] text-muted-foreground mb-2">
        Auto-approve permission requests. Use Allow All for full trust, or fine-tune per tool. Stored in
        .rclaude/rclaude.json.
      </div>
      <PermissionRulesEditor project={project} />
    </>
  )
}
