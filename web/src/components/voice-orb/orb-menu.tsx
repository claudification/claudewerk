/**
 * THE ORB'S OWN MENU -- mute, rate, restart, dismiss, desk.
 *
 * Before this, the orb had a bare click (which opened the desk) and two tiny
 * text buttons floating beside it, so mute and dismiss were the only things
 * reachable and nothing said so. Everything the orb can do to ITSELF lives
 * behind this one surface.
 *
 * TWO PRIMITIVES, ONE SET OF ROWS -- and the reason is a11y, not taste.
 * The plain click now opens the TRANSCRIPT, so this menu cannot be a
 * DropdownMenu.Trigger on the orb: a Trigger claims pointerdown AND Enter/Space,
 * so a keyboard user pressing Enter on the orb would get this menu and could
 * never reach the transcript at all. It would also stamp `aria-haspopup="menu"`
 * on a button whose click does something else -- an outright lie to a screen
 * reader.
 *   - ORB -> ContextMenu: right-click on a mouse, and Radix's own 700ms
 *     long-press timer on touch. Claims neither click nor Enter.
 *   - PANEL BUTTON -> DropdownMenu, where `aria-haspopup="menu"` is the truth.
 * Both render `MenuRows`, so the two can never drift apart.
 *
 * The speaking rate is here rather than only in Settings on purpose: it is the
 * knob you want while it is talking at you, and having it next to the orb makes
 * "did that actually change anything?" answerable without leaving the screen.
 */

import { MoreHorizontal } from 'lucide-react'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'
import { nearestSpeedStep, ORB_SPEED_STEPS, speedLabel } from './orb-menu-model'

const itemClass =
  'flex items-center justify-between gap-6 px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'
const contentClass = 'min-w-48 border border-border bg-popover rounded-md py-1 shadow-lg z-[60]'
const labelClass = 'px-3 py-1 text-[10px] text-muted-foreground uppercase'

export interface OrbMenuActions {
  muted: boolean
  toggleMute(): void
  reload(): void
  dismiss(): void
  openDesk(): void
}

/** The parts both primitives expose under the same names. Structurally
 *  identical for everything used here, so the rows are written once. */
interface MenuKit {
  Item: typeof DropdownMenu.Item
  Separator: typeof DropdownMenu.Separator
  Label: typeof DropdownMenu.Label
  RadioGroup: typeof DropdownMenu.RadioGroup
  RadioItem: typeof DropdownMenu.RadioItem
}

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenu.Item,
  Separator: DropdownMenu.Separator,
  Label: DropdownMenu.Label,
  RadioGroup: DropdownMenu.RadioGroup,
  RadioItem: DropdownMenu.RadioItem,
}

const CONTEXT_KIT = {
  Item: ContextMenu.Item,
  Separator: ContextMenu.Separator,
  Label: ContextMenu.Label,
  RadioGroup: ContextMenu.RadioGroup,
  RadioItem: ContextMenu.RadioItem,
} as unknown as MenuKit // same props for what is used here; the scope generics differ

/** The rate rows. Writes the SAME pref the Settings slider writes, so the two
 *  surfaces can never disagree about what the orb is speaking at. */
function SpeedItems({ kit }: { kit: MenuKit }) {
  const speed = useConversationsStore(st => st.controlPanelPrefs.voiceOrbSpeed)
  const update = useConversationsStore(st => st.updateControlPanelPrefs)
  const ticked = nearestSpeedStep(speed)
  return (
    <kit.RadioGroup
      value={String(ticked)}
      onValueChange={v => {
        haptic('tap')
        update({ voiceOrbSpeed: Number(v) })
      }}
    >
      {ORB_SPEED_STEPS.map(step => (
        <kit.RadioItem key={step} value={String(step)} className={itemClass}>
          <span>{speedLabel(step)}</span>
          {step === ticked ? <span className="text-[10px] text-accent">on</span> : null}
        </kit.RadioItem>
      ))}
    </kit.RadioGroup>
  )
}

function MenuRows({ kit, actions }: { kit: MenuKit; actions: OrbMenuActions }) {
  const item = (label: string, onSelect: () => void, hint?: string) => (
    <kit.Item
      className={itemClass}
      onSelect={() => {
        haptic('tap')
        onSelect()
      }}
    >
      <span>{label}</span>
      {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
    </kit.Item>
  )
  return (
    <>
      {item('Open the desk', actions.openDesk)}
      {item(actions.muted ? 'Unmute the mic' : 'Mute the mic', actions.toggleMute, actions.muted ? 'muted' : undefined)}
      <kit.Separator className="h-px bg-border my-1" />
      <kit.Label className={labelClass}>Speaking rate</kit.Label>
      <SpeedItems kit={kit} />
      <kit.Separator className="h-px bg-border my-1" />
      {item('Restart the orb', actions.reload, 'fresh session')}
      {item('Dismiss the orb', actions.dismiss, 'frees the mic')}
    </>
  )
}

/** Wraps THE ORB. Right-click (mouse) or long-press (touch); the plain click
 *  belongs to the transcript and is never intercepted here. */
export function OrbMenu({ actions, children }: { actions: OrbMenuActions; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={contentClass}>
          <MenuRows kit={CONTEXT_KIT} actions={actions} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/** The same menu from an explicit button -- the transcript header's `⋯`. This
 *  is the route that does NOT depend on the user guessing at a long press. */
export function OrbMenuButton({ actions }: { actions: OrbMenuActions }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Open the orb's menu"
          className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={contentClass} side="top" align="end" sideOffset={8}>
          <MenuRows kit={DROPDOWN_KIT} actions={actions} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
