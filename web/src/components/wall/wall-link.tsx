/**
 * THE HEADER'S LINK INDICATOR AND ITS REFRESH.
 *
 * The dot used to be `<span className="wall-livedot" />` -- a green circle on a
 * pulse animation, wired to nothing at all, which said LIVE with the socket down
 * and LIVE over panes showing pre-disconnect numbers. There was also no way to
 * ask the wall to re-read itself: every pull-fed pane healed only on its own
 * timer, up to five minutes.
 *
 * Both halves live here because they are one question. The dot says whether the
 * wall is current; the button is what you press when it says it is not.
 */

import { useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { wallLinkState } from '@/lib/wall/link-state'
import { heldFreshness, refreshHeldFeeds } from '@/lib/wall/revive-store'
import { useWallReviveVersion } from '@/lib/wall/use-wall-revive'

/** Re-reads every pane's feed. Disabled while one is in flight, so a bored
 *  finger cannot stack six identical rounds of HTTP onto a slow broker. */
function RefreshButton({ connectSeq }: { connectSeq: number }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="wall-btn wall-hide-ambient"
      disabled={busy}
      title="Re-read every pane's data now. The websocket half heals itself; this is the HTTP half."
      onClick={() => {
        setBusy(true)
        void refreshHeldFeeds(connectSeq).finally(() => setBusy(false))
      }}
    >
      {busy ? 'READING' : 'REFRESH'}
    </button>
  )
}

/** The dot + the word. The word matters: a colour alone is unreadable to a third
 *  of the people who might look at this, and unreadable at four feet to everyone
 *  once the dot is 7px.
 *
 *  `rewound` is W1's cursor, not the socket's, and it OVERRIDES the link colour
 *  on purpose (`.wall-livedot[data-rewound]` is declared after every
 *  `[data-link]` rule). A wall showing the past is not live no matter how
 *  healthy the socket is, and the pulse is the thing a room reads as LIVE from
 *  four metres away. */
export function WallLinkDot({ rewound }: { rewound?: boolean }) {
  const connected = useConversationsStore(s => s.isConnected)
  const connectSeq = useConversationsStore(s => s.connectSeq)
  // Subscribes to the revive ledger, so a feed landing re-renders this.
  useWallReviveVersion()
  const view = wallLinkState({ connected, feeds: heldFreshness(connectSeq) })

  return (
    <span className="wall-link" title={view.why}>
      <span
        className="wall-livedot"
        data-link={view.link}
        data-pulse={(!rewound && view.pulse) || undefined}
        data-rewound={rewound || undefined}
      />
      <span className="wall-link-label">{view.label}</span>
    </span>
  )
}

export function WallRefresh() {
  const connectSeq = useConversationsStore(s => s.connectSeq)
  return <RefreshButton connectSeq={connectSeq} />
}
