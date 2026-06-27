import { afterEach, expect, test } from 'bun:test'
import { _resetBrokerRpc, dispatchBrokerRpcResponse, setBrokerRpcSender } from './lib/broker-rpc'
import { registerWebControlTools } from './web-control'

afterEach(() => _resetBrokerRpc())

const tools = registerWebControlTools({} as any)

const callHandle = (name: string, params: Record<string, unknown>) => tools[name].handle(params as any, {} as any)

function captureSends() {
  const sent: Record<string, unknown>[] = []
  setBrokerRpcSender(m => sent.push(m as unknown as Record<string, unknown>))
  return sent
}

test('registers all 17 web_* tools including perf + execute_script', () => {
  const names = Object.keys(tools)
  expect(names).toHaveLength(17)
  for (const n of [
    'web_list_clients',
    'web_screenshot',
    'web_perf_report',
    'web_set_perf_monitor',
    'web_execute_script',
  ]) {
    expect(names).toContain(n)
  }
})

test('execute_script relays code + clamped timeout', () => {
  const sent = captureSends()
  void callHandle('web_execute_script', { code: 'return 1+1', timeoutMs: 90_000 })
  const msg = sent[0]
  expect(msg.op).toBe('execute_script')
  expect((msg.args as Record<string, unknown>).code).toBe('return 1+1')
  // timeoutMs is clamped (here unchanged) and forwarded so the broker + browser
  // race at the same bound; relayTimeoutMs scales the host brokerRpc accordingly.
  expect((msg.args as Record<string, unknown>).timeoutMs).toBe(90_000)
})

test('relays op + args and surfaces a string result', async () => {
  const sent = captureSends()
  const p = callHandle('web_set_perf_monitor', { enabled: true })
  expect(sent).toHaveLength(1)
  const msg = sent[0]
  expect(msg.type).toBe('web_control_relay')
  expect(msg.op).toBe('set_perf_monitor')
  expect(msg.args).toEqual({ enabled: true })
  expect(typeof msg.requestId).toBe('string')
  dispatchBrokerRpcResponse({ requestId: msg.requestId as string, ok: true, result: 'monitor on' })
  const res = await p
  expect(res.isError).toBeUndefined()
  expect(res.content[0].text).toBe('monitor on')
})

test('execute_command defaults args to [] and lifts clientId to the relay top level', async () => {
  const sent = captureSends()
  const p = callHandle('web_execute_command', { clientId: 'web_x', id: 'cmd.foo' })
  const msg = sent[0]
  expect(msg.clientId).toBe('web_x')
  expect(msg.op).toBe('execute_command')
  expect(msg.args).toEqual({ id: 'cmd.foo', args: [] })
  dispatchBrokerRpcResponse({ requestId: msg.requestId as string, ok: true, result: { ok: true } })
  await p
})

test('an ok:false broker reply becomes an isError tool result', async () => {
  const sent = captureSends()
  const p = callHandle('web_screenshot', {})
  // clientId omitted -> not present on the relay message
  expect(sent[0].clientId).toBeUndefined()
  dispatchBrokerRpcResponse({ requestId: sent[0].requestId as string, ok: false, error: 'No browser is opted-in' })
  const res = await p
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toContain('No browser is opted-in')
})

test('list_clients on an empty registry returns the friendly opt-in hint', async () => {
  const sent = captureSends()
  const p = callHandle('web_list_clients', {})
  expect(sent[0].op).toBe('list_clients')
  expect(sent[0].clientId).toBeUndefined()
  dispatchBrokerRpcResponse({ requestId: sent[0].requestId as string, ok: true, result: [] })
  const res = await p
  expect(res.content[0].text).toContain('No browser is opted-in')
})

test('handle returns a not-connected error when no broker RPC sender is set', async () => {
  _resetBrokerRpc() // clears the sender
  const res = await callHandle('web_terminal_list', {})
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toContain('broker connection not ready')
})
