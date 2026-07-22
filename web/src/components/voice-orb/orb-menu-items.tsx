/**
 * THE ORB MENU'S ROWS -- mute, speaking rate, voice, tone, restart, dismiss.
 *
 * One `MenuRows` written against `MenuKit`, so the ContextMenu (on the orb) and
 * the DropdownMenu (on the `⋯` button) can never drift apart.
 *
 * SPEED is a flat radio (five taps, the knob you want while it is talking at
 * you). VOICE (ten) and TONE (four) are one-tap-deep `DialSubmenu`s so the flat
 * menu does not balloon. All three write the SAME control-panel prefs the
 * Settings pickers write, so the two surfaces can never disagree about how the
 * orb sounds. Voice applies to the live session at once; tone is baked at mint,
 * so it lands on the next summon -- the submenu says so.
 */

import { asVoiceOrbTone, asVoiceOrbVoice, VOICE_ORB_TONES, VOICE_ORB_VOICES } from '@shared/voice-orb-options'
import { ChevronRight } from 'lucide-react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'
import { contentClass, itemClass, labelClass, type MenuKit, type OrbMenuActions } from './orb-menu-kit'
import { nearestSpeedStep, ORB_SPEED_STEPS, speedLabel, TONE_LABEL, VOICE_LABEL } from './orb-menu-model'

/** The lit "on" marker every radio row shares. */
const onMark = <span className="text-[10px] text-accent">on</span>

/** The rate rows. Flat, numeric, and off-grid values still tick their nearest. */
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
          {step === ticked ? onMark : null}
        </kit.RadioItem>
      ))}
    </kit.RadioGroup>
  )
}

/** A one-tap-deep dial: the trigger shows the current pick (readable without
 *  opening it), the panel is a radio over `options`. `note` prints atop the
 *  panel -- tone uses it for its next-summon caveat. */
function DialSubmenu<T extends string>({
  kit,
  label,
  options,
  current,
  optionLabel,
  onPick,
  note,
}: {
  kit: MenuKit
  label: string
  options: readonly T[]
  current: T
  optionLabel: (o: T) => string
  onPick: (o: T) => void
  note?: string
}) {
  return (
    <kit.Sub>
      <kit.SubTrigger className={itemClass}>
        <span>{label}</span>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {current}
          <ChevronRight className="size-3" />
        </span>
      </kit.SubTrigger>
      <kit.Portal>
        <kit.SubContent className={contentClass} sideOffset={4} alignOffset={-4}>
          {note ? <kit.Label className={labelClass}>{note}</kit.Label> : null}
          <kit.RadioGroup
            value={current}
            onValueChange={v => {
              haptic('tap')
              onPick(v as T)
            }}
          >
            {options.map(o => (
              <kit.RadioItem key={o} value={o} className={itemClass}>
                <span>{optionLabel(o)}</span>
                {o === current ? onMark : null}
              </kit.RadioItem>
            ))}
          </kit.RadioGroup>
        </kit.SubContent>
      </kit.Portal>
    </kit.Sub>
  )
}

export function MenuRows({ kit, actions }: { kit: MenuKit; actions: OrbMenuActions }) {
  const update = useConversationsStore(st => st.updateControlPanelPrefs)
  const voice = asVoiceOrbVoice(useConversationsStore(st => st.controlPanelPrefs.voiceOrbVoice))
  const tone = asVoiceOrbTone(useConversationsStore(st => st.controlPanelPrefs.voiceOrbTone))
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
      <DialSubmenu
        kit={kit}
        label="Voice"
        options={VOICE_ORB_VOICES}
        current={voice}
        optionLabel={v => VOICE_LABEL[v] ?? v}
        onPick={v => update({ voiceOrbVoice: v })}
      />
      <DialSubmenu
        kit={kit}
        label="Tone"
        options={VOICE_ORB_TONES}
        current={tone}
        optionLabel={t => TONE_LABEL[t] ?? t}
        onPick={t => update({ voiceOrbTone: t })}
        note="Applies on next summon"
      />
      <kit.Separator className="h-px bg-border my-1" />
      {item('Restart the orb', actions.reload, 'fresh session')}
      {item('Dismiss the orb', actions.dismiss, 'frees the mic')}
    </>
  )
}
