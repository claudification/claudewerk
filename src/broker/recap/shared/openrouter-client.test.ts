import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { NoApiKeyError, OpenRouterError, RateLimitError, TimeoutError } from './errors'
import { chat } from './openrouter-client'

interface CapturedCall {
  url: string
  init: RequestInit
}

function makeFetcher(handler: (call: CapturedCall, attempt: number) => Promise<Response> | Response) {
  let attempt = 0
  const calls: CapturedCall[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    attempt++
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return handler(call, attempt)
  }) as unknown as typeof fetch
  return { fn, calls, getAttempt: () => attempt }
}

const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY
beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'k_test'
})
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = ORIGINAL_KEY
})

function jsonResponse(content: string, usage: Record<string, unknown> = {}, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage, model: 'anthropic/claude-haiku-4-5' }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('chat()', () => {
  it('throws NoApiKeyError when no key is configured and no override is given', async () => {
    delete process.env.OPENROUTER_API_KEY
    const { fn } = makeFetcher(() => jsonResponse('hi'))
    await expect(
      chat({ feature: 'test', model: 'anthropic/claude-haiku-4-5', user: 'x', fetcher: fn }),
    ).rejects.toBeInstanceOf(NoApiKeyError)
  })

  it('packs system + user shorthand into messages array in order', async () => {
    const { fn, calls } = makeFetcher(() => jsonResponse('ok'))
    await chat({
      feature: 'test',
      model: 'anthropic/claude-haiku-4-5',
      system: 'sys',
      user: 'usr',
      maxTokens: 64,
      temperature: 0.2,
      fetcher: fn,
    })
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.model).toBe('anthropic/claude-haiku-4-5')
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ])
    expect(body.max_tokens).toBe(64)
    expect(body.temperature).toBe(0.2)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer k_test')
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
  })

  it('returns content + raw + usage', async () => {
    const { fn } = makeFetcher(() => jsonResponse('hello world', { prompt_tokens: 5, completion_tokens: 2 }))
    const res = await chat({ feature: 'test', model: 'anthropic/claude-haiku-4-5', user: 'x', fetcher: fn, retries: 0 })
    expect(res.content).toBe('hello world')
    expect(res.usage.inputTokens).toBe(5)
    expect(res.usage.outputTokens).toBe(2)
  })

  it('throws OpenRouterError with status on a 4xx response', async () => {
    const { fn } = makeFetcher(() => new Response('bad', { status: 400 }))
    let caught: unknown
    try {
      await chat({ feature: 'test', model: 'm', user: 'x', fetcher: fn, retries: 0 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OpenRouterError)
    expect((caught as OpenRouterError).status).toBe(400)
  })

  it('retries on 5xx and eventually succeeds', async () => {
    let n = 0
    const { fn, getAttempt } = makeFetcher(() => {
      n++
      if (n < 2) return new Response('boom', { status: 503 })
      return jsonResponse('finally')
    })
    const res = await chat({ feature: 'test', model: 'm', user: 'x', fetcher: fn, retries: 2 })
    expect(res.content).toBe('finally')
    expect(getAttempt()).toBe(2)
  })

  it('throws RateLimitError on 429 and respects Retry-After', async () => {
    const { fn } = makeFetcher(() => new Response('limit', { status: 429, headers: { 'Retry-After': '0' } }))
    let caught: unknown
    try {
      await chat({ feature: 'test', model: 'm', user: 'x', fetcher: fn, retries: 0 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RateLimitError)
    expect((caught as RateLimitError).status).toBe(429)
  })

  it('throws TimeoutError when fetch aborts', async () => {
    const { fn } = makeFetcher(async () => {
      // Simulate an abort by waiting forever; the AbortSignal will fire.
      await new Promise(r => setTimeout(r, 50))
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    let caught: unknown
    try {
      await chat({ feature: 'test', model: 'm', user: 'x', fetcher: fn, retries: 0, timeoutMs: 5 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TimeoutError)
  })

  it('throws OpenRouterError when the choice has empty content', async () => {
    const { fn } = makeFetcher(() => jsonResponse(''))
    let caught: unknown
    try {
      await chat({ feature: 'test', model: 'm', user: 'x', fetcher: fn, retries: 0 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OpenRouterError)
  })

  // --- resilience: enforced timeout (the recap-resilience B1 incident) ---

  // Resolve to the error chat() throws (or undefined if it unexpectedly succeeds),
  // so the timeout assertions don't each repeat a try/catch block.
  const catchErr = async (p: Promise<unknown>): Promise<unknown> => {
    try {
      await p
      return undefined
    } catch (err) {
      return err
    }
  }
  // A fetch that never resolves AND never honours abort -- the worst case the
  // 707s incident approximated. Without the Promise.race deadline this hangs.
  const neverSettles = () => new Promise<Response>(() => {})

  it('enforces timeoutMs even when the fetch never settles and ignores abort', async () => {
    const { fn, getAttempt } = makeFetcher(neverSettles)
    const caught = await catchErr(
      chat({ feature: 'test', model: 'm', user: 'x', fetcher: fn, retries: 0, timeoutRetries: 0, timeoutMs: 30 }),
    )
    expect(caught).toBeInstanceOf(TimeoutError)
    expect(getAttempt()).toBe(1)
  })

  it('bounds a slow body read (headers fast, json() hangs)', async () => {
    // fetch() resolves promptly but the body never finishes -- the exact shape
    // of a streamed-but-stalled completion. The deadline must cover res.json().
    const hangingBody = { ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response
    const { fn } = makeFetcher(() => hangingBody)
    const caught = await catchErr(
      chat({ feature: 'test', model: 'm', user: 'x', fetcher: fn, retries: 0, timeoutRetries: 0, timeoutMs: 30 }),
    )
    expect(caught).toBeInstanceOf(TimeoutError)
  })

  it('draws timeouts from their own (smaller) budget, not the rate-limit budget', async () => {
    // Always times out. retries=5 but timeoutRetries=1 -> exactly 2 attempts.
    const { fn, getAttempt } = makeFetcher(neverSettles)
    const caught = await catchErr(
      chat({ feature: 'test', model: 'm', user: 'x', fetcher: fn, retries: 5, timeoutRetries: 1, timeoutMs: 20 }),
    )
    expect(caught).toBeInstanceOf(TimeoutError)
    expect(getAttempt()).toBe(2)
  })

  it('keeps the full rate-limit budget even when timeoutRetries is 0', async () => {
    // A low timeoutRetries must NOT starve 429 handling -- they are separate.
    let n = 0
    const { fn, getAttempt } = makeFetcher(() => {
      n++
      if (n < 4) return new Response('slow down', { status: 429 })
      return jsonResponse('recovered')
    })
    const res = await chat({ feature: 'test', model: 'm', user: 'x', fetcher: fn, retries: 3, timeoutRetries: 0 })
    expect(res.content).toBe('recovered')
    expect(getAttempt()).toBe(4)
  })
})

function toolCallResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_a',
                type: 'function',
                function: { name: 'list_conversations', arguments: '{"status":"live"}' },
              },
            ],
          },
        },
      ],
      usage: {},
      model: 'anthropic/claude-haiku-4-5',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('chat() tool-calling', () => {
  it('serializes tools into the function-tool wire shape + tool_choice', async () => {
    const { fn, calls } = makeFetcher(() => toolCallResponse())
    await chat({
      feature: 'test',
      model: 'anthropic/claude-haiku-4-5',
      user: 'list everything',
      tools: [{ name: 'list_conversations', description: 'list', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'auto',
      fetcher: fn,
    })
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.tool_choice).toBe('auto')
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'list_conversations', description: 'list', parameters: { type: 'object', properties: {} } },
      },
    ])
  })

  it('parses tool_calls + finishReason and does NOT throw on empty content', async () => {
    const { fn } = makeFetcher(() => toolCallResponse())
    const res = await chat({ feature: 'test', model: 'anthropic/claude-haiku-4-5', user: 'x', fetcher: fn })
    expect(res.content).toBe('')
    expect(res.finishReason).toBe('tool_calls')
    expect(res.toolCalls).toEqual([{ id: 'call_a', name: 'list_conversations', arguments: '{"status":"live"}' }])
  })

  it('round-trips assistant tool_calls + tool result messages onto the wire', async () => {
    const { fn, calls } = makeFetcher(() => jsonResponse('done'))
    await chat({
      feature: 'test',
      model: 'anthropic/claude-haiku-4-5',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'ping', arguments: '{}' }] },
        { role: 'tool', content: 'pong', toolCallId: 'call_a' },
      ],
      fetcher: fn,
    })
    const msgs = JSON.parse(calls[0].init.body as string).messages
    expect(msgs[1].tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'ping', arguments: '{}' } },
    ])
    expect(msgs[2]).toEqual({ role: 'tool', content: 'pong', tool_call_id: 'call_a' })
  })
})

describe('spend log (the [openrouter] cost line)', () => {
  const original = console.log
  let lines: string[]
  beforeEach(() => {
    lines = []
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
  })
  afterEach(() => {
    console.log = original
  })
  const spendLines = () => lines.filter(l => l.startsWith('[openrouter]'))

  it('emits ONE feature-tagged line per successful call with tokens + cost + source', async () => {
    const { fn } = makeFetcher(() => jsonResponse('hi', { prompt_tokens: 12, completion_tokens: 4, cost: 0.0009 }))
    await chat({ feature: 'desk-agent', model: 'anthropic/claude-haiku-4-5', user: 'x', fetcher: fn, retries: 0 })
    expect(spendLines()).toHaveLength(1)
    const line = spendLines()[0]
    expect(line).toContain('feature=desk-agent')
    expect(line).toContain('model=anthropic/claude-haiku-4-5')
    expect(line).toContain('in=12 out=4')
    expect(line).toContain('cost=$0.000900')
    expect(line).toContain('src=openrouter')
    expect(line).toContain('ok=true')
  })

  it('logs cache token breakdown only when present', async () => {
    const { fn } = makeFetcher(() =>
      jsonResponse('hi', {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 80 },
      }),
    )
    await chat({ feature: 'recap-period', model: 'm', user: 'x', fetcher: fn, retries: 0 })
    expect(spendLines()[0]).toContain('cache_r=80')
  })

  it('still logs on FAILURE (ok=false + err, no token/cost) so failed spend is visible', async () => {
    const { fn } = makeFetcher(() => new Response('nope', { status: 400 }))
    await expect(
      chat({ feature: 'voice-refiner', model: 'm', user: 'x', fetcher: fn, retries: 0 }),
    ).rejects.toBeInstanceOf(OpenRouterError)
    expect(spendLines()).toHaveLength(1)
    const line = spendLines()[0]
    expect(line).toContain('feature=voice-refiner')
    expect(line).toContain('ok=false')
    expect(line).toContain('err=')
    expect(line).not.toContain('cost=$')
  })
})
