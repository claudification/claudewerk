import { formatResetIn } from '@shared/format-reset-time'
import { formatRateBucketName } from '@/lib/utils'
import type { SystemDescriber, SystemEntry } from './types'
import { num, str } from './types'

const apiRetry: SystemDescriber = entry => {
  const delayMs = num(entry.retry_delay_ms)
  const tail = delayMs === undefined ? '' : ` - retrying in ${Math.ceil(delayMs / 1000)}s`
  return {
    kind: 'text',
    text: `API retry ${entry.attempt}/${entry.max_retries} (${entry.error_status || 'timeout'})${tail}`,
    color: 'text-amber-400',
  }
}

/**
 * `system/api_error` -- CC's structured request failure. It is one of the two
 * subtypes headless force-forwards from the JSONL (see the agent host's
 * HEADLESS_LIVE_SYSTEM_SUBTYPES), so it ALWAYS reaches the transcript, and its
 * message lives at `error.formatted` (a display string) rather than `content`.
 * Reading `content` here is what made it render as a bare gray "[api_error]".
 */
const apiError: SystemDescriber = entry => {
  const error = (entry.error || {}) as SystemEntry
  const status = num(error.status)
  const connection = (error.connection || null) as SystemEntry | null
  const text = str(error.formatted) || str(error.message) || str(connection?.code) || 'API error'
  const prefix = error.is_network_down ? 'Network down' : 'API error'
  return {
    kind: 'text',
    text: `${prefix}${status ? ` ${status}` : ''}: ${text}`,
    color: 'text-red-400',
  }
}

const rateLimit: SystemDescriber = entry => {
  const retryMs = num(entry.retryAfterMs)
  const isNotice = (entry.isNotice as boolean | undefined) ?? retryMs === undefined
  const info = (entry.raw as SystemEntry | undefined)?.rate_limit_info as SystemEntry | undefined
  const formattedType = formatRateBucketName(str(info?.rateLimitType) || undefined)
  const resetTail = formatResetIn(num(entry.resetsAt))
  const tail = resetTail ? ` -- ${resetTail}` : ''
  return {
    kind: 'text',
    text: isNotice ? `Rate limit notice (${formattedType})${tail}` : `Rate limited (${formattedType})${tail}`,
    color: isNotice ? 'text-amber-400/50' : 'text-amber-400/80',
  }
}

const swap = (entry: SystemEntry) => `${str(entry.original_model) || '?'} -> ${str(entry.fallback_model) || '?'}`

const modelFallback: SystemDescriber = entry => {
  const trigger = str(entry.trigger)
  return {
    kind: 'text',
    text: `Model fallback: ${swap(entry)}${trigger ? ` (${trigger})` : ''}`,
    color: 'text-amber-400',
  }
}

/** A pre-send consent gate swapped the session off the requested model. */
const modelConsentFallback: SystemDescriber = entry => {
  const choice = str(entry.choice) || 'declined'
  const persisted = entry.persisted_as_default ? ', saved as default' : ''
  return {
    kind: 'text',
    text: `Model consent ${choice}: ${swap(entry)}${persisted}`,
    color: 'text-amber-400',
  }
}

/** The model refused; a fallback ran. `direction` says what the retry did. */
const modelRefusalFallback: SystemDescriber = entry => {
  const category = str(entry.api_refusal_category)
  const direction = str(entry.direction)
  const detail = [category, direction].filter(Boolean).join(', ')
  return {
    kind: 'text',
    text: `Model refusal: ${swap(entry)}${detail ? ` (${detail})` : ''}`,
    color: 'text-red-400/80',
  }
}

/** The model refused and NO retry ran -- terminal for that turn. */
const modelRefusalNoFallback: SystemDescriber = entry => {
  const category = str(entry.api_refusal_category)
  const explanation = str(entry.api_refusal_explanation) || str(entry.content)
  const head = `Model refused${category ? ` (${category})` : ''}, no fallback`
  return {
    kind: 'text',
    text: explanation ? `${head}: ${explanation}` : head,
    color: 'text-red-400',
  }
}

export const ERROR_DESCRIBERS: Record<string, SystemDescriber> = {
  api_retry: apiRetry,
  api_error: apiError,
  rate_limit: rateLimit,
  chat_api_error: entry => ({ kind: 'text', text: str(entry.content), color: 'text-red-400' }),
  model_fallback: modelFallback,
  model_consent_fallback: modelConsentFallback,
  model_refusal_fallback: modelRefusalFallback,
  model_refusal_no_fallback: modelRefusalNoFallback,
  mirror_error: entry => ({
    kind: 'text',
    text: `Transcript mirror error: ${str(entry.error) || 'unknown'}`,
    color: 'text-red-400',
  }),
}
