/**
 * Editor row of the Debug: control modal -- description, JSON payload textarea,
 * and the send button. Split out to keep the modal shell under the size bar.
 */
import type { ControlCommandSpec } from '@shared/cc-control-commands'

interface DebugCommandEditorProps {
  spec: ControlCommandSpec
  payloadText: string
  onPayloadChange: (text: string) => void
  payloadError: string | null
  onSend: () => void
}

export function DebugCommandEditor({
  spec,
  payloadText,
  onPayloadChange,
  payloadError,
  onSend,
}: DebugCommandEditorProps) {
  return (
    <>
      <div className="text-[10px] text-muted-foreground">{spec.description}</div>
      <textarea
        value={payloadText}
        onChange={e => onPayloadChange(e.target.value)}
        aria-label="Command payload"
        spellCheck={false}
        className="w-full h-28 bg-muted/40 border border-border text-[11px] font-mono px-2 py-1.5 outline-none focus:border-accent resize-none"
      />
      {payloadError && <div className="text-[10px] text-red-400">{payloadError}</div>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSend}
          className={`px-3 py-1 text-xs font-bold transition-colors ${spec.danger ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30' : 'bg-accent/20 text-accent hover:bg-accent/30'}`}
        >
          Send{spec.danger ? ' (DANGER)' : ''}
        </button>
        <span className="text-[10px] text-muted-foreground/60">
          {spec.channel} · {spec.transports.join(',')}
        </span>
      </div>
    </>
  )
}
