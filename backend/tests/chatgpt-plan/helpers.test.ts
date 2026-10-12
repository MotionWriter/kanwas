import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stepCountIs, tool } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import { createToolCallReaskRepair, generateTextForProvider } from '../../libs/agent/utils/tool_call_repair.js'

const repairedCall = { toolName: 'search', input: { query: 'repaired query' } }
const generationParameters = { model: {} as any, prompt: 'Find docs' }

function mockStream(chunks: unknown[], steps = [{ toolCalls: [repairedCall] }], finishReason = 'tool-calls') {
  return {
    fullStream: (async function* () {
      yield* chunks
    })(),
    steps: Promise.resolve(steps),
    finishReason: Promise.resolve(finishReason),
  }
}

test('API-key helpers preserve generateText and do not stream', async () => {
  const expected = { steps: [{ toolCalls: [repairedCall] }], toolCalls: [repairedCall] }
  let calls = 0
  const result = await generateTextForProvider(generationParameters, {
    authMode: 'api-key',
    generateTextFn: (async (parameters: unknown) => {
      assert.equal(parameters, generationParameters)
      calls += 1
      return expected
    }) as any,
    streamTextFn: (() => {
      throw new Error('Unexpected streaming call')
    }) as any,
  })
  assert.equal(result, expected)
  assert.equal(calls, 1)
})

test('subscription helpers consume the stream and aggregate calls across completed steps', async () => {
  const laterCall = { toolName: 'search', input: { query: 'another query' } }
  const steps = [{ toolCalls: [repairedCall] }, { toolCalls: [laterCall] }, { toolCalls: [] }]
  let consumed = 0
  const result = await generateTextForProvider(generationParameters, {
    authMode: 'chatgpt-plan',
    generateTextFn: (() => {
      throw new Error('Unexpected non-streaming call')
    }) as any,
    streamTextFn: (() => ({
      ...mockStream([], steps),
      fullStream: (async function* () {
        yield { type: 'start' }
        consumed += 1
        yield { type: 'finish', finishReason: 'stop' }
        consumed += 1
      })(),
    })) as any,
  })
  assert.equal(consumed, 2)
  assert.deepEqual(result.steps, steps)
  assert.deepEqual(result.toolCalls, [repairedCall, laterCall])
})

test('a late stream error cannot turn earlier completed helper steps into success', async () => {
  const failure = new Error('Subscription usage limit reached')
  await assert.rejects(
    generateTextForProvider(generationParameters, {
      authMode: 'chatgpt-plan',
      streamTextFn: (() =>
        mockStream([
          { type: 'finish-step', finishReason: 'tool-calls' },
          { type: 'error', error: failure },
        ])) as any,
    }),
    (error) => error === failure
  )
})

for (const [name, chunks, finishReason, message] of [
  ['error terminal event', [{ type: 'finish', finishReason: 'error' }], 'error', /finished with an error/],
  ['error terminal result', [{ type: 'finish', finishReason: 'stop' }], 'error', /finished with an error/],
  ['missing terminal event', [{ type: 'finish-step', finishReason: 'tool-calls' }], 'other', /without a finish event/],
  ['aborted generation', [{ type: 'abort', reason: 'Cancelled by user' }], 'other', /Cancelled by user/],
] as const) {
  test(`subscription helper rejects ${name}`, async () => {
    await assert.rejects(
      generateTextForProvider(generationParameters, {
        authMode: 'chatgpt-plan',
        streamTextFn: (() => mockStream([...chunks], undefined, finishReason)) as any,
      }),
      message
    )
  })
}

test('subscription helper generates structured tool output using the real AI SDK streaming path', async () => {
  const responseSchema = z.object({ title: z.string() })
  const model = new MockLanguageModelV3({
    doStream: {
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'structured-1',
          toolName: 'structured_response',
          input: JSON.stringify({ title: 'Plan for today' }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: 10, reasoning: undefined },
          },
        },
      ]),
    },
  })
  const result = await generateTextForProvider(
    {
      model,
      prompt: 'Produce a title',
      tools: {
        structured_response: tool({ inputSchema: responseSchema, execute: async (input) => input }),
      },
      toolChoice: { type: 'tool', toolName: 'structured_response' },
      stopWhen: stepCountIs(1),
    },
    { authMode: 'chatgpt-plan' }
  )
  assert.deepEqual(responseSchema.parse(result.steps[0]?.toolCalls[0]?.input), { title: 'Plan for today' })
  assert.equal(model.doStreamCalls.length, 1)
  assert.equal(model.doGenerateCalls.length, 0)
})

const repairPayload = {
  toolCall: { toolCallId: 'repair-1', toolName: 'search', input: '{"query":' },
  error: new Error('Invalid tool input'),
  messages: [{ role: 'user', content: 'Find docs' }] as any,
  system: 'System prompt',
}

test('subscription tool repair streams schema-only tools without executing them', async () => {
  let executions = 0
  let calls = 0
  const repair = createToolCallReaskRepair({
    model: {},
    authMode: 'chatgpt-plan',
    tools: {
      search: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async () => {
          executions += 1
          return 'Unexpected execution'
        },
      }),
    },
    generateTextFn: (() => {
      throw new Error('Unexpected non-streaming repair')
    }) as any,
    streamTextFn: ((parameters: any) => {
      calls += 1
      assert.equal(parameters.tools.search.execute, undefined)
      assert.equal(parameters.toolChoice, 'required')
      assert.equal(parameters.messages[2].role, 'tool')
      return mockStream([{ type: 'finish', finishReason: 'tool-calls' }])
    }) as any,
  })
  assert.deepEqual(await repair(repairPayload), {
    type: 'tool-call',
    toolCallId: 'repair-1',
    toolName: 'search',
    input: JSON.stringify(repairedCall.input),
  })
  assert.equal(executions, 0)
  assert.equal(calls, 1)
})

test('failed streaming repairs return null and respect the per-call attempt limit', async () => {
  let calls = 0
  const repair = createToolCallReaskRepair({
    model: {},
    authMode: 'chatgpt-plan',
    tools: {},
    streamTextFn: (() => {
      calls += 1
      return mockStream([{ type: 'error', error: new Error('Access denied') }])
    }) as any,
  })
  assert.equal(await repair(repairPayload), null)
  assert.equal(await repair(repairPayload), null)
  assert.equal(calls, 1)
})
