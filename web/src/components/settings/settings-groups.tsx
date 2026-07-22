import { GroupHeader, SettingRow } from './settings-inputs'
import type { SettingItem, SettingsContext } from './settings-item'

/** Renders items grouped under their GroupHeaders, preserving item order. */
export function SettingsGroups({ items, ctx }: { items: SettingItem[]; ctx: SettingsContext }) {
  const groups = new Map<string, SettingItem[]>()
  for (const item of items) {
    const existing = groups.get(item.group)
    if (existing) existing.push(item)
    else groups.set(item.group, [item])
  }
  return (
    <>
      {Array.from(groups.entries()).map(([group, groupItems]) => (
        <div key={group}>
          <GroupHeader label={group} />
          <div className="space-y-3">
            {groupItems.map(item => (
              <SettingRow
                key={item.label}
                label={item.label}
                description={item.description}
                server={item.server}
                fullWidth={item.fullWidth}
              >
                {item.render(ctx, item.label)}
              </SettingRow>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
