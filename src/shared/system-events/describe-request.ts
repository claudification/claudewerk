/** The request/model lane: everything that happens between us and the API. */
import { formatRateBucketName, formatResetIn } from '../format-reset-time'
import type { Describer, SystemEntry } from './types'
import { bag, num, str } from './types'

/**
 * `api-error` -- a structured request failure, in whichever dialect the backend speaks.
 * Claude Code puts the display string at `error.formatted` and is one of the two subtypes
 * headless force-forwards from the JSONL, so it ALWAYS reaches the transcript; the chat-api
 * and ACP backends put theirs at `content`. Reading only one of those is what made an API
 * failure render as a bare gray token with the reason dropped.
 */
const apiError: Describer = entry => {
  const error = bag(entry.error)
  const status = num(error.status)
  const text =
    str(error.formatted) || str(error.message) || str(entry.content) || str(bag(error.connection).code) || 'API error'
  const prefix = error.is_network_down ? 'Network down' : 'API error'
  return { text: `${prefix}${status ? ` ${status}` : ''}: ${text}`, severity: 'error' }
}

/**
 * `api-retry` -- a retry is in flight. Covers CC's own `api_retry` and the
 * `control_request_progress` frame, which reports the same thing for a long-running
 * client-originated control request (its `status` is "started" | "api_retry").
 */
const apiRetry: Describer = entry => {
  const attempt = num(entry.attempt)
  const max = num(entry.max_retries)
  const delayMs = num(entry.retry_delay_ms)
  if (attempt === undefined && str(entry.status) === 'started') return null // nothing failed yet
  const count = attempt === undefined ? '' : ` ${attempt}${max ? `/${max}` : ''}`
  const cause = str(entry.error_status) || num(entry.error_status) || 'timeout'
  const tail = delayMs === undefined ? '' : ` - retrying in ${Math.ceil(delayMs / 1000)}s`
  return { text: `API retry${count} (${cause})${tail}`, severity: 'warn' }
}

const rateLimit: Describer = entry => {
  const retryMs = num(entry.retryAfterMs)
  const isNotice = (entry.isNotice as boolean | undefined) ?? retryMs === undefined
  const info = bag(bag(entry.raw).rate_limit_info)
  const bucket = formatRateBucketName(str(info.rateLimitType) || undefined)
  const resetTail = formatResetIn(num(entry.resetsAt))
  const tail = resetTail ? ` -- ${resetTail}` : ''
  return {
    text: isNotice ? `Rate limit notice (${bucket})${tail}` : `Rate limited (${bucket})${tail}`,
    severity: isNotice ? 'muted' : 'warn',
  }
}

const swap = (entry: SystemEntry): string =>
  `${str(entry.original_model) || '?'} -> ${str(entry.fallback_model) || '?'}`

const modelFallback: Describer = entry => {
  const trigger = str(entry.trigger)
  return { text: `Model fallback: ${swap(entry)}${trigger ? ` (${trigger})` : ''}`, severity: 'warn' }
}

/** A pre-send consent gate swapped the conversation off the requested model. */
const modelConsent: Describer = entry => {
  const choice = str(entry.choice) || 'declined'
  const persisted = entry.persisted_as_default ? ', saved as default' : ''
  return { text: `Model consent ${choice}: ${swap(entry)}${persisted}`, severity: 'warn' }
}

/** The model refused; a fallback ran. `direction` says what the retry did. */
const modelRefusal: Describer = entry => {
  const detail = [str(entry.api_refusal_category), str(entry.direction)].filter(Boolean).join(', ')
  return { text: `Model refusal: ${swap(entry)}${detail ? ` (${detail})` : ''}`, severity: 'error' }
}

/** The model refused and NO retry ran -- terminal for that turn. */
const modelRefusalFinal: Describer = entry => {
  const category = str(entry.api_refusal_category)
  const explanation = str(entry.api_refusal_explanation) || str(entry.content)
  const head = `Model refused${category ? ` (${category})` : ''}, no fallback`
  return { text: explanation ? `${head}: ${explanation}` : head, severity: 'error' }
}

/** rclaude's own check: the model CC actually booted is not the one we asked for. */
const modelMismatch: Describer = entry => ({
  text: str(entry.content) || 'Model mismatch',
  severity: str(entry.level) === 'warning' ? 'warn' : 'notice',
})

export const REQUEST_DESCRIBERS: Record<string, Describer> = {
  'api-error': apiError,
  'api-retry': apiRetry,
  'rate-limit': rateLimit,
  'model-fallback': modelFallback,
  'model-consent': modelConsent,
  'model-refusal': modelRefusal,
  'model-refusal-final': modelRefusalFinal,
  'model-mismatch': modelMismatch,
  'mirror-error': entry => ({
    text: `Transcript mirror error: ${str(entry.error) || 'unknown'}`,
    severity: 'error',
  }),
}
