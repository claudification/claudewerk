import { useConversations } from '@/hooks/use-conversations'
import { useDispatchStore } from './dispatch-store'

/** Resting state: the concierge greets you. No fleet, no stats -- just a warm
 *  opening and a quiet reminder that it knows everyone so you don't have to. */
export function DispatchGreeting() {
  const userId = useDispatchStore(s => s.userId)
  const liveCount = useConversations().filter(c => c.status !== 'ended').length
  const name = userId ? userId.charAt(0).toUpperCase() + userId.slice(1) : null

  return (
    <div className="px-6 pt-8">
      <p className="text-[22px] font-semibold leading-tight text-foreground">{name ? `Hey ${name}.` : 'Hey.'}</p>
      <p className="mt-1 text-[15px] text-comment">What do you need?</p>
      {liveCount > 0 && (
        <p className="mt-5 text-[12.5px] leading-relaxed text-comment/70">
          I'm keeping an eye on {liveCount} {liveCount === 1 ? 'conversation' : 'conversations'} right now. Just tell me
          what you're after and I'll take you to the right one.
        </p>
      )}
    </div>
  )
}
