/**
 * THE ORB'S OWN MENU.
 *
 * Before this, the orb had a bare click (which opened the desk) and two tiny
 * text buttons floating beside it -- so mute and dismiss were the only things
 * reachable, and nothing said so. Everything the orb can do to itself now lives
 * behind one surface, opened three ways: CLICK (and tap, which is the same
 * pointerdown on touch, so a long press opens it too) or RIGHT-CLICK.
 *
 * The speaking rate is here rather than only in Settings on purpose: it is the
 * knob you want while it is talking at you, and having it next to the orb makes
 * "did that actually change anything?" answerable without leaving the screen.
 */

import { DropdownMenu } from 'radix-ui'
import type { MouseEvent, ReactElement } from 'react'
import { cloneElement, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'
import { nearestSpeedStep, ORB_SPEED_STEPS, speedLabel } from './orb-menu-model'

const itemClass =
  'flex items-center justify-between gap-6 px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'
const contentClass = 'min-w-48 border border-border bg-popover rounded-md py-1 shadow-lg z-[60]'

export interface OrbMenuActions {
  muted: boolean
  toggleMute(): void
  reload(): void
  dismiss(): void
  openDesk(): void
}

function Item({ label, hint, onSelect }: { label: string; hint?: string; onSelect: () => void }) {
  return (
    <DropdownMenu.Item
      className={itemClass}
      onSelect={() => {
        haptic('tap')
        onSelect()
      }}
    >
      <span>{label}</span>
      {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
    </DropdownMenu.Item>
  )
}

/** The rate rows. Writes the SAME pref the Settings slider writes, so the two
 *  surfaces can never disagree about what the orb is speaking at. */
function SpeedItems() {
  const speed = useConversationsStore(st => st.controlPanelPrefs.voiceOrbSpeed)
  const update = useConversationsStore(st => st.updateControlPanelPrefs)
  const ticked = nearestSpeedStep(speed)
  return (
    <DropdownMenu.RadioGroup
      value={String(ticked)}
      onValueChange={v => {
        haptic('tap')
        update({ voiceOrbSpeed: Number(v) })
      }}
    >
      {ORB_SPEED_STEPS.map(step => (
        <DropdownMenu.RadioItem key={step} value={String(step)} className={itemClass}>
          <span>{speedLabel(step)}</span>
          {step === ticked ? <span className="text-[10px] text-accent">on</span> : null}
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  )
}

/** `children` is THE ORB button -- a single element, so the right-click handler
 *  can be cloned onto it. */
type OrbTrigger = ReactElement<{ onContextMenu?: (e: MouseEvent) => void }>

export function OrbMenu({ actions, children }: { actions: OrbMenuActions; children: OrbTrigger }) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      {/* Right-click gets the same menu the click does -- one surface, three ways
          in, so nobody has to guess which gesture this thing wants. The handler
          goes ON the orb button (cloned in) rather than on a wrapper: a plain
          span carrying interactions is a static-element a11y bug. */}
      <DropdownMenu.Trigger asChild>
        {cloneElement(children, {
          onContextMenu: (e: MouseEvent) => {
            e.preventDefault()
            setOpen(true)
          },
        })}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={contentClass} side="top" align="end" sideOffset={8}>
          <Item label="Open the desk" onSelect={actions.openDesk} />
          <Item
            label={actions.muted ? 'Unmute the mic' : 'Mute the mic'}
            hint={actions.muted ? 'muted' : undefined}
            onSelect={actions.toggleMute}
          />
          <DropdownMenu.Separator className="h-px bg-border my-1" />
          <DropdownMenu.Label className="px-3 py-1 text-[10px] text-muted-foreground uppercase">
            Speaking rate
          </DropdownMenu.Label>
          <SpeedItems />
          <DropdownMenu.Separator className="h-px bg-border my-1" />
          <Item label="Restart the orb" hint="fresh session" onSelect={actions.reload} />
          <Item label="Dismiss the orb" hint="frees the mic" onSelect={actions.dismiss} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
