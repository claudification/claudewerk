/**
 * S1 HOST VITALS -- cpu / ram / disk per sentinel.
 * Feed: the new sentinel heartbeat payload.
 *
 * STUB. Card `wall-host-vitals` rewrites THIS FILE and no other.
 */

import { WallPane } from '../wall-pane'
import { WallPaneEmpty } from '../wall-pane-empty'

// fallow-ignore-next-line unused-export -- mounted through the registry's dynamic import()
export default function HostVitalsPane() {
  return (
    <WallPane title="HOST VITALS" code="S1">
      <WallPaneEmpty />
    </WallPane>
  )
}
