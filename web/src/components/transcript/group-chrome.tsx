/**
 * Chrome groups -- the rows that are rclaude talking about itself (boot, launch,
 * spawn, shell, advisor, system) rather than conversation.
 *
 * Each has its own renderer and none of them share the label / bubble / fork
 * machinery a real turn needs, so they are dispatched off the front of GroupView
 * before any of that is computed. A `Record` rather than an if-chain: this is one
 * key with six answers, and a new group type should be one line here.
 *
 * A handler returning null means "not chrome after all" -- `system` only counts
 * when it actually carries notifications or a subtype; otherwise it falls through
 * and renders as a normal group.
 */

import type { ReactNode } from 'react'
import { AdvisorCard } from './advisor-card'
import { BootTimeline } from './boot-timeline'
import type { DisplayGroup } from './grouping'
import { LaunchTimeline } from './launch-timeline'
import { PermissionCard } from './permission-card'
import { ShellReceipt } from './shell-receipt'
import { SpawnNotification } from './spawn-notification'
import { SystemLine } from './system-line'
import { TaskNotificationLine } from './task-notification-line'

type ChromeRenderer = (group: DisplayGroup, ts?: string | number) => ReactNode | null

const CHROME_GROUPS: Record<string, ChromeRenderer> = {
  boot: group => <BootTimeline group={group} />,
  launch: group => <LaunchTimeline group={group} />,
  spawn_notification: group => <SpawnNotification group={group} />,
  permission: group => <PermissionCard group={group} />,
  shell: group => <ShellReceipt group={group} />,
  advisor: group => <AdvisorCard group={group} />,
  system: (group, ts) => {
    if (group.notifications?.length) {
      return (
        <div className="mb-2 space-y-1">
          {group.notifications.map((n, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
            // biome-ignore lint/suspicious/noArrayIndexKey: notifications are ordered display items, no stable IDs
            <TaskNotificationLine key={i} notification={n} ts={ts} />
          ))}
        </div>
      )
    }
    if (group.systemSubtype) return <SystemLine group={group} ts={ts} />
    return null
  },
}

/** The chrome rendering for this group, or null when it is a real turn. */
export function renderChromeGroup(group: DisplayGroup, ts?: string | number): ReactNode | null {
  return CHROME_GROUPS[group.type]?.(group, ts) ?? null
}
