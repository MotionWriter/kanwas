import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOpenAI } from '@ai-sdk/openai'
import { jsonSchema, stepCountIs, streamText, tool as defineTool } from 'ai'
import {
  ChatGPTPlanTransportError,
  createChatGPTPlanFetch,
  prepareChatGPTPlanRequest,
} from '../../libs/agent/providers/chatgpt_plan_transport.js'

const endpoint = 'https://api.openai.com/v1/responses'
const headers = { 'content-type': 'application/json' }
const functionTool = {
  type: 'function',
  name: 'edit_board',
  description: 'Edit the current board.',
  parameters: {
    type: 'object' as const,
    properties: { title: { type: 'string' as const } },
    required: ['title'],
    additionalProperties: false,
  },
  strict: true,
}
const base = () => ({ model: 'offline-model', stream: true, store: false, input: [{ role: 'user', content: 'Hello' }] })
const completed = {
  type: 'response.completed',
  response: { usage: { input_tokens: 3, output_tokens: 2 }, incomplete_details: null },
}
function sse(events: unknown[], newline = '\n'): string {
  return events.map((event) => `data: ${JSON.stringify(event)}${newline}${newline}`).join('')
}
function streamed(events: unknown[], chunkBytes = 0, newline = '\n'): Response {
  const bytes = new TextEncoder().encode(sse(events, newline))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunkBytes) {
        for (let offset = 0; offset < bytes.length; offset += chunkBytes)
          controller.enqueue(bytes.slice(offset, offset + chunkBytes))
      } else controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-offline' } })
}
async function requestWith(response: Response): Promise<Response> {
  const fetch = createChatGPTPlanFetch({ getAccessToken: async () => 'oauth-test', fetch: async () => response })
  return fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(base()) })
}

test('enforces streaming/stateless input and rewrites system roles without changing input', () => {
  const body = {
    ...base(),
    store: true,
    input: [{ type: 'message', role: 'system', content: 'Instructions' }],
    temperature: 0.2,
    top_p: 0.5,
    top_logprobs: 2,
    max_output_tokens: 100,
    max_tool_calls: 5,
    metadata: { test: 'value' },
    prompt_cache_retention: '24h',
    safety_identifier: 'id',
    user: 'id',
    truncation: 'auto',
    background: false,
    reasoning: { effort: 'high' },
    text: { verbosity: 'low' },
  }
  const original = structuredClone(body)
  const adapted = prepareChatGPTPlanRequest(body)
  assert.deepEqual(body, original)
  assert.equal(adapted.store, false)
  assert.deepEqual(adapted.input, [{ type: 'message', role: 'developer', content: 'Instructions' }])
  assert.deepEqual(Object.keys(adapted).sort(), ['input', 'model', 'reasoning', 'store', 'stream', 'text'])
  assert.throws(() => prepareChatGPTPlanRequest({ ...base(), stream: false }), /streamText/)
  assert.throws(() => prepareChatGPTPlanRequest({ ...base(), stream: undefined }), /streamText/)
  assert.throws(() => prepareChatGPTPlanRequest({ ...base(), input: 'Hello' }), /input array/)
})

test('moves client tools to additional_tools and preserves names, calls, and results', () => {
  const history = [
    { type: 'function_call', name: 'edit_board', call_id: 'call-1', arguments: '{"title":"Campaign"}' },
    { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' },
    { type: 'custom_tool_call', name: 'patch', call_id: 'call-2', input: 'Patch contents' },
    { type: 'custom_tool_call_output', call_id: 'call-2', output: 'Applied' },
  ]
  const custom = { type: 'custom', name: 'patch', format: { type: 'text' } }
  const web = { type: 'web_search_preview', search_context_size: 'low' }
  const adapted = prepareChatGPTPlanRequest({
    ...base(),
    input: history,
    tools: [functionTool, custom, web],
    tool_choice: { type: 'function', name: 'edit_board' },
  })
  assert.deepEqual(adapted.tools, [web])
  assert.deepEqual(adapted.input, [
    { type: 'additional_tools', role: 'developer', tools: [functionTool, custom] },
    ...history,
  ])
  assert.deepEqual(adapted.tool_choice, { type: 'function', name: 'edit_board' })
  assert.equal(prepareChatGPTPlanRequest({ ...base(), tools: [functionTool] }).tools, undefined)
})

test('rejects unsupported native/hosted tools and ambiguous local tool contracts', () => {
  for (const type of [
    'image_generation',
    'file_search',
    'code_interpreter',
    'computer',
    'mcp',
    'tool_search',
    'programmatic_tool_calling',
    'shell',
    'apply_patch',
    'namespace',
  ]) {
    assert.throws(() => prepareChatGPTPlanRequest({ ...base(), tools: [{ type }] }), /Unsupported tool type/)
  }
  for (const tool of [
    { ...functionTool, defer_loading: true },
    { ...functionTool, async: true },
    { ...functionTool, allowed_callers: ['programmatic'] },
    { ...functionTool, unrecognized: true },
  ])
    assert.throws(() => prepareChatGPTPlanRequest({ ...base(), tools: [tool] }), ChatGPTPlanTransportError)
  assert.throws(
    () => prepareChatGPTPlanRequest({ ...base(), tools: [functionTool, functionTool] }),
    /Duplicate tool name/
  )
  assert.throws(
    () => prepareChatGPTPlanRequest({ ...base(), tool_choice: { type: 'function', name: 'missing' } }),
    /declared client tool/
  )
})

test('rejects unsupported state/execution fields instead of silently losing context', () => {
  for (const field of [
    'previous_response_id',
    'conversation',
    'prompt',
    'background',
    'moderation',
    'multi_agent',
    'unknown_future_field',
  ]) {
    assert.throws(() => prepareChatGPTPlanRequest({ ...base(), [field]: 'value' }), /Unsupported/)
  }
  assert.throws(
    () => prepareChatGPTPlanRequest({ ...base(), input: [{ type: 'item_reference', id: 'stored' }] }),
    /complete history/
  )
  assert.throws(
    () => prepareChatGPTPlanRequest({ ...base(), input: [{ type: 'reasoning', id: 'stored', summary: [] }] }),
    /encrypted content/
  )
  assert.throws(
    () =>
      prepareChatGPTPlanRequest({
        ...base(),
        input: [{ type: 'function_call', namespace: 'crm', name: 'edit_board', call_id: 'c', arguments: '{}' }],
      }),
    /Namespaced history/
  )
})

test('accepts inline image/file inputs and encrypted reasoning, rejects audio and Files IDs', () => {
  const input = [
    {
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
        { type: 'input_file', filename: 'brief.pdf', file_data: 'data:application/pdf;base64,AA==' },
      ],
    },
    { type: 'reasoning', encrypted_content: 'encrypted-reasoning', summary: [] },
  ]
  assert.deepEqual(prepareChatGPTPlanRequest({ ...base(), input }).input, input)
  for (const content of [
    { type: 'input_audio', data: 'AA==' },
    { type: 'input_video', video_url: 'https://example.test/movie' },
    { type: 'input_file', file_id: 'file-1' },
    { type: 'input_image', file_id: 'file-2' },
  ])
    assert.throws(
      () => prepareChatGPTPlanRequest({ ...base(), input: [{ role: 'user', content: [content] }] }),
      ChatGPTPlanTransportError
    )
})

test('resolves fresh OAuth tokens and overwrites API-key/billing headers immediately before send', async () => {
  const sent: Request[] = []
  let resolutions = 0
  const transport = createChatGPTPlanFetch({
    getAccessToken: async () => `oauth-${++resolutions}`,
    fetch: async (input, init) => {
      assert.equal(init?.redirect, 'error')
      sent.push(new Request(input, init))
      return streamed([completed])
    },
  })
  for (let i = 0; i < 2; i++) {
    const response = await transport(
      new Request(endpoint, {
        method: 'POST',
        headers: {
          ...headers,
          'authorization': 'Bearer separately-billed-api-key',
          'openai-organization': 'org',
          'openai-project': 'proj',
        },
        body: JSON.stringify(base()),
      })
    )
    await response.text()
  }
  assert.equal(resolutions, 2)
  for (let i = 0; i < 2; i++) {
    assert.equal(sent[i].headers.get('authorization'), `Bearer oauth-${i + 1}`)
    assert.equal(sent[i].headers.get('openai-organization'), null)
    assert.equal(sent[i].headers.get('openai-project'), null)
    assert.equal(sent[i].headers.get('accept'), 'text/event-stream')
    const body = (await sent[i].json()) as { store: boolean }
    assert.equal(body.store, false)
  }
})

test('rejects wrong destinations/methods before reading credentials or making network requests', async () => {
  let called = false
  const transport = createChatGPTPlanFetch({
    getAccessToken: async () => {
      called = true
      return 'oauth'
    },
    fetch: async () => {
      called = true
      return new Response()
    },
  })
  for (const url of [
    'https://example.test/v1/responses',
    'https://chatgpt.com/backend-api/codex/responses',
    'http://api.openai.com/v1/responses',
    'https://api.openai.com/v1/chat/completions',
    'https://api.openai.com/v1/responses?destination=other',
    'https://api.openai.com/v1/responses#fragment',
    'https://api.openai.com/v1/files',
    'https://api.openai.com/v1/responses/response-id',
  ])
    await assert.rejects(
      transport(url, { method: 'POST', headers, body: JSON.stringify(base()) }),
      ChatGPTPlanTransportError
    )
  await assert.rejects(transport(endpoint, { method: 'GET' }), /method or endpoint/)
  await assert.rejects(
    transport(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...base(), stream: false }) }),
    /streamText/
  )
  assert.equal(called, false)
})

test('allows only the documented GET model catalog with current OAuth credentials', async () => {
  let sent: Request | undefined
  const transport = createChatGPTPlanFetch({
    getAccessToken: async () => 'oauth',
    fetch: async (input, init) => {
      sent = new Request(input, init)
      return Response.json({ models: [{ slug: 'available-model', visibility: 'list', display_name: 'Available' }] })
    },
  })
  const response = await transport('https://api.openai.com/v1/models')
  assert.equal(sent?.headers.get('authorization'), 'Bearer oauth')
  const body = (await response.json()) as { models: { slug: string }[] }
  assert.equal(body.models[0].slug, 'available-model')
})

test('preserves HTTP admission errors, response body and request IDs', async () => {
  const original = new Response('{"detail":"Unavailable serving region"}', {
    status: 403,
    headers: { 'x-request-id': 'req-admission' },
  })
  const response = await requestWith(original)
  assert.equal(response, original)
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('x-request-id'), 'req-admission')
  assert.deepEqual(await response.json(), { detail: 'Unavailable serving region' })
})

test('passes SSE bytes unchanged across one-byte chunks, CRLF and UTF-8 boundaries', async () => {
  const events = [{ type: 'response.output_text.delta', item_id: 'msg-1', delta: 'Hello 🧩' }, completed]
  const response = await requestWith(streamed(events, 1, '\r\n'))
  assert.equal(await response.text(), sse(events, '\r\n'))
})

test('fails on late usage-limit events and preserves their code/request ID', async () => {
  const response = await requestWith(
    streamed(
      [
        { type: 'response.output_text.delta', item_id: 'm', delta: 'Partial' },
        {
          type: 'response.failed',
          response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit reached' } },
        },
      ],
      10
    )
  )
  await assert.rejects(
    response.text(),
    (error: unknown) =>
      error instanceof ChatGPTPlanTransportError &&
      error.code === 'subscription_sharing_usage_limit_exceeded' &&
      error.requestId === 'req-offline'
  )
})

test('fails on incomplete, explicit error, malformed and interrupted streams', async () => {
  for (const events of [
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }],
    [{ type: 'error', code: 'server_error', message: 'Unavailable' }],
    [{ type: 'response.output_text.delta', item_id: 'm', delta: 'Partial' }],
  ]) {
    const response = await requestWith(streamed(events))
    await assert.rejects(response.text(), ChatGPTPlanTransportError)
  }
  const malformed = await requestWith(
    new Response('data: invalid\n\n', { headers: { 'content-type': 'text/event-stream' } })
  )
  await assert.rejects(malformed.text(), /Malformed/)
  await assert.rejects(requestWith(Response.json({ output: [] })), /streaming Responses/)
})

test('forwards abort state and rejects absent tokens without API-key fallback', async () => {
  const controller = new AbortController()
  controller.abort()
  const transport = createChatGPTPlanFetch({
    getAccessToken: async () => 'oauth',
    fetch: async (_input, init) => {
      assert.equal(init?.signal?.aborted, true)
      throw new DOMException('Aborted', 'AbortError')
    },
  })
  await assert.rejects(
    transport(endpoint, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(base()) }),
    { name: 'AbortError' }
  )
  for (const token of ['', 'invalid token']) {
    const missing = createChatGPTPlanFetch({
      getAccessToken: async () => token,
      fetch: async () => {
        assert.fail('Should not send a request')
      },
    })
    await assert.rejects(missing(endpoint, { method: 'POST', headers, body: JSON.stringify(base()) }), /Sign in again/)
  }
})

test('pinned SDK receives unchanged function names and serializes complete tool-result history', async () => {
  const requests: Record<string, unknown>[] = []
  const item = {
    type: 'function_call',
    id: 'fc-1',
    call_id: 'call-1',
    name: 'edit_board',
    arguments: '{"title":"Campaign"}',
    namespace: 'edit_board',
    status: 'completed',
  }
  const fetch = createChatGPTPlanFetch({
    getAccessToken: async () => 'oauth',
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return streamed(
        requests.length === 1
          ? [
              { type: 'response.created', response: { id: 'resp-1', model: 'offline-model', created_at: 1 } },
              { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
              {
                type: 'response.function_call_arguments.delta',
                item_id: 'fc-1',
                output_index: 0,
                delta: item.arguments,
              },
              { type: 'response.output_item.done', output_index: 0, item },
              completed,
            ]
          : [
              { type: 'response.created', response: { id: 'resp-2', model: 'offline-model', created_at: 1 } },
              { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-2' } },
              { type: 'response.output_text.delta', item_id: 'msg-2', delta: 'Saved' },
              {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                  type: 'message',
                  id: 'msg-2',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Saved' }],
                },
              },
              completed,
            ]
      )
    },
  })
  const model = createOpenAI({ apiKey: 'unused-placeholder', fetch }).responses('offline-model')
  const tool = {
    type: 'function' as const,
    name: functionTool.name,
    description: functionTool.description,
    inputSchema: functionTool.parameters,
  }
  const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Rename board' }] }]
  const options = { tools: [tool], providerOptions: { openai: { store: false } } }
  const first = await model.doStream({ ...options, prompt })
  const parts = await Array.fromAsync(first.stream)
  assert.equal(
    parts.some((part) => part.type === 'error'),
    false
  )
  const call = parts.find((part) => part.type === 'tool-call')
  assert.ok(call && call.type === 'tool-call', JSON.stringify({ parts, requests }))
  assert.equal(call.toolName, 'edit_board')
  assert.equal(call.toolCallId, 'call-1')
  assert.equal(call.input, item.arguments)
  assert.equal(requests[0].tools, undefined)
  assert.equal((requests[0].input as Record<string, unknown>[])[0].type, 'additional_tools')
  const second = await model.doStream({
    ...options,
    prompt: [
      ...prompt,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'edit_board', input: { title: 'Campaign' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'edit_board',
            output: { type: 'json', value: { ok: true } },
          },
        ],
      },
    ],
  })
  const result = await Array.fromAsync(second.stream)
  assert.equal(
    result.some((part) => part.type === 'error'),
    false
  )
  assert.ok(result.some((part) => part.type === 'text-delta' && part.delta === 'Saved'))
  assert.deepEqual((requests[1].input as Record<string, unknown>[]).slice(-2), [
    { type: 'function_call', name: 'edit_board', call_id: 'call-1', arguments: '{"title":"Campaign"}' },
    { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' },
  ])
})

test('pinned SDK cannot turn a response.failed or missing terminal event into successful inference', async () => {
  for (const events of [
    [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable' } } }],
    [],
  ]) {
    const fetch = createChatGPTPlanFetch({ getAccessToken: async () => 'oauth', fetch: async () => streamed(events) })
    const model = createOpenAI({ apiKey: 'unused', fetch }).responses('offline-model')
    const result = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      providerOptions: { openai: { store: false } },
    })
    await assert.rejects(Array.fromAsync(result.stream), ChatGPTPlanTransportError)
  }
})

test('streamText executes a client tool once and sends its result in the next stateless turn', async () => {
  const requests: Record<string, unknown>[] = []
  let boardTitle = 'Original'
  const item = {
    type: 'function_call',
    id: 'fc-edit',
    call_id: 'call-edit',
    name: 'edit_board',
    arguments: '{"title":"Campaign"}',
    namespace: 'edit_board',
    status: 'completed',
  }
  const fetch = createChatGPTPlanFetch({
    getAccessToken: async () => 'oauth',
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return streamed(
        requests.length === 1
          ? [
              { type: 'response.created', response: { id: 'resp-edit', model: 'offline-model', created_at: 1 } },
              { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
              {
                type: 'response.function_call_arguments.delta',
                item_id: item.id,
                output_index: 0,
                delta: item.arguments,
              },
              { type: 'response.output_item.done', output_index: 0, item },
              completed,
            ]
          : [
              { type: 'response.created', response: { id: 'resp-summary', model: 'offline-model', created_at: 1 } },
              { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-summary' } },
              { type: 'response.output_text.delta', item_id: 'msg-summary', delta: 'Board updated.' },
              { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-summary' } },
              completed,
            ]
      )
    },
  })
  const stream = streamText({
    model: createOpenAI({ apiKey: 'unused', fetch }).responses('offline-model'),
    prompt: 'Rename the board to Campaign.',
    providerOptions: { openai: { store: false } },
    tools: {
      edit_board: defineTool({
        description: functionTool.description,
        inputSchema: jsonSchema<{ title: string }>(functionTool.parameters),
        execute: async ({ title }) => {
          boardTitle = title
          return { ok: true }
        },
      }),
    },
    stopWhen: stepCountIs(2),
    maxRetries: 0,
  })
  const parts = await Array.fromAsync(stream.fullStream)
  assert.equal(
    parts.some((part) => part.type === 'error'),
    false
  )
  assert.equal(boardTitle, 'Campaign')
  assert.equal(requests.length, 2)
  assert.equal(await stream.text, 'Board updated.')
  assert.equal(await stream.finishReason, 'stop')
  const history = requests[1].input as Record<string, unknown>[]
  assert.deepEqual(
    history.filter((entry) => entry.type === 'function_call_output'),
    [{ type: 'function_call_output', call_id: 'call-edit', output: '{"ok":true}' }]
  )
  assert.ok(requests.every((body) => body.store === false && body.stream === true && body.tools === undefined))
})
