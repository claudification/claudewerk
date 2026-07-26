/** Presentation table for the push-notification toggle. One row per state. */

export type PushState = 'loading' | 'unsupported' | 'prompt' | 'subscribing' | 'unsubscribing' | 'subscribed' | 'denied'

interface PushStateStyle {
  label: string
  /** Bell (on) vs BellOff (off) */
  bell: boolean
  className: string
}

const NEUTRAL = 'bg-transparent text-foreground border-border hover:border-primary'

export const PUSH_STATE_STYLES: Record<PushState, PushStateStyle> = {
  loading: { label: '...', bell: false, className: NEUTRAL },
  unsupported: {
    label: 'Not supported',
    bell: false,
    className: 'bg-muted text-muted-foreground border-border cursor-not-allowed',
  },
  prompt: { label: 'Enable', bell: false, className: NEUTRAL },
  subscribing: { label: 'Enabling...', bell: false, className: NEUTRAL },
  unsubscribing: { label: 'Disabling...', bell: true, className: NEUTRAL },
  subscribed: { label: 'Enabled', bell: true, className: 'bg-active/20 text-active border-active/50' },
  denied: { label: 'Denied', bell: false, className: 'bg-red-400/20 text-red-400 border-red-400/50' },
}

/** States where a click must not start new work. */
export const PUSH_BUSY: ReadonlySet<PushState> = new Set<PushState>([
  'loading',
  'subscribing',
  'unsubscribing',
  'unsupported',
])
