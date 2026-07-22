/** User/agent message-label styling (tag text, size, color). Server settings. */

import { ColorInput } from './color-inputs'
import { SizePicker } from './settings-inputs'
import { type SettingItem, TEXT_INPUT_CLS } from './settings-item'

const LABEL_INPUT_CLS = `${TEXT_INPUT_CLS} w-28 text-right`

export const LABEL_ITEMS: SettingItem[] = [
  {
    tab: 'display',
    group: 'Message labels',
    label: 'User label',
    description: 'Tag shown next to user messages',
    server: true,
    keywords: 'tag name',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="text"
        maxLength={20}
        value={(ctx.server.userLabel as string) ?? ''}
        placeholder="USER"
        onChange={e => ctx.setServer('userLabel', e.target.value)}
        className={LABEL_INPUT_CLS}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Message labels',
    label: 'User tag size',
    description: 'Size of the user label badge',
    server: true,
    render: (ctx, _ariaLabel) => (
      <SizePicker value={(ctx.server.userSize as string) ?? ''} onChange={v => ctx.setServer('userSize', v)} />
    ),
  },
  {
    tab: 'display',
    group: 'Message labels',
    label: 'User tag color',
    description: 'Background color for user label',
    server: true,
    fullWidth: true,
    keywords: 'colour background',
    render: (ctx, _ariaLabel) => (
      <ColorInput
        value={(ctx.server.userColor as string) ?? ''}
        onChange={v => ctx.setServer('userColor', v)}
        defaultColor="rgba(234,179,8,1)"
      />
    ),
  },
  {
    tab: 'display',
    group: 'Message labels',
    label: 'Agent label',
    description: 'Tag shown next to agent messages',
    server: true,
    keywords: 'tag name',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="text"
        maxLength={20}
        value={(ctx.server.agentLabel as string) ?? ''}
        placeholder="AGENT"
        onChange={e => ctx.setServer('agentLabel', e.target.value)}
        className={LABEL_INPUT_CLS}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Message labels',
    label: 'Agent tag size',
    description: 'Size of the agent label badge',
    server: true,
    render: (ctx, _ariaLabel) => (
      <SizePicker value={(ctx.server.agentSize as string) ?? ''} onChange={v => ctx.setServer('agentSize', v)} />
    ),
  },
  {
    tab: 'display',
    group: 'Message labels',
    label: 'Agent tag color',
    description: 'Background color for agent label',
    server: true,
    fullWidth: true,
    keywords: 'colour background',
    render: (ctx, _ariaLabel) => (
      <ColorInput
        value={(ctx.server.agentColor as string) ?? ''}
        onChange={v => ctx.setServer('agentColor', v)}
        defaultColor="rgba(168,85,247,1)"
      />
    ),
  },
]
