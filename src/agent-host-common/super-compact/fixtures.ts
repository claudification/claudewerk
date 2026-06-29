/**
 * A small but realistic Claude Code session used by the super-compact tests.
 * Shapes mirror captured 2.1.185 JSONL: a read -> edit -> "fixed" cycle (whose
 * read is superseded by the edit), then a human "run the tests" turn that forms
 * the protected-tail boundary, then a bash cycle.
 */

export const ORIG_SESSION_ID = 'orig-session-0001'

const base = {
  sessionId: ORIG_SESSION_ID,
  cwd: '/repo',
  version: '2.1.185',
  gitBranch: 'main',
  userType: 'external',
  timestamp: '2026-06-29T10:00:00.000Z',
}

const user = (uuid: string, parentUuid: string | null, content: unknown) => ({
  ...base,
  parentUuid,
  uuid,
  type: 'user',
  message: { role: 'user', content },
})

const assistant = (uuid: string, parentUuid: string, content: unknown[], stop = 'end_turn') => ({
  ...base,
  parentUuid,
  uuid,
  type: 'assistant',
  requestId: `req_${uuid}`,
  message: {
    id: `msg_${uuid}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  },
})

const thinking = (t: string) => ({ type: 'thinking', thinking: t, signature: `sig_${t.length}` })
const text = (t: string) => ({ type: 'text', text: t })
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, content })

function buildFixtureRows(): Array<Record<string, unknown>> {
  return [
    user('a1', null, 'Read foo.ts and fix the bug'),
    assistant(
      'a2',
      'a1',
      [thinking('let me read foo'), toolUse('tu_read', 'Read', { file_path: '/repo/foo.ts' })],
      'tool_use',
    ),
    user('a3', 'a2', [toolResult('tu_read', 'export const x = arr[i+1] // big file contents '.repeat(20))]),
    assistant(
      'a4',
      'a3',
      [
        thinking('off by one, edit it'),
        toolUse('tu_edit', 'Edit', { file_path: '/repo/foo.ts', old_string: 'i+1', new_string: 'i' }),
      ],
      'tool_use',
    ),
    user('a5', 'a4', [toolResult('tu_edit', 'File updated successfully')]),
    assistant('a6', 'a5', [text('Fixed the off-by-one in foo.ts.')]),
    user('a7', 'a6', 'now run the tests'),
    assistant('a8', 'a7', [toolUse('tu_bash', 'Bash', { command: 'bun test' })], 'tool_use'),
    user('a9', 'a8', [toolResult('tu_bash', '3 pass 0 fail')]),
    assistant('a10', 'a9', [text('All tests pass.')]),
  ]
}

export function buildFixture(): string {
  return `${buildFixtureRows()
    .map(r => JSON.stringify(r))
    .join('\n')}\n`
}

/** Deterministic id generator for stable test assertions. */
export function makeGenId(): () => string {
  let i = 0
  return () => `u${i++}`
}
