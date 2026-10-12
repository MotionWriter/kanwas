import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stepCountIs, tool } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import { LLM } from '../../libs/llm.js'
import type { ProviderConfig } from '../../libs/agent/providers/types.js'
import { runToolLoop } from '../../libs/agent/tool_loop_runner.js'

function mockProvider(model: MockLanguageModelV3): ProviderConfig {
  return {
    name: 'openai',
    authMode: 'chatgpt-plan',
    createModel: () => model,
    generationOptions: () => ({}),
    promptOptions: () => ({}),
    formatMessages: (messages) => messages,
    supportsCaching: false,
    supportsThinking: false,
    supportsNativeTools: false,
    modelTiers: { small: 'offline-model', medium: 'offline-model', big: 'offline-model' },
    subagentModelTiers: { explore: 'small', external: 'small' },
  }
}

test('subscription text utility rejects a provider error after partial text', async ({ mock }) => {
  mock.method(console, 'error', () => {})
  const failure = new Error('Subscription usage limit reached')
  const model = new MockLanguageModelV3({
    doStream: {
      stream: convertArrayToReadableStream([
        { type: 'text-start', id: 'title' },
        { type: 'text-delta', id: 'title', delta: 'Partial title' },
        { type: 'text-end', id: 'title' },
        { type: 'error', error: failure },
      ]),
    },
  })
  const llm = new LLM({ provider: mockProvider(model), model: 'offline-model' })
  await assert.rejects(llm.completeText({ prompt: 'Title this task' }), (error) => error === failure)
  assert.equal(model.doGenerateCalls.length, 0)
})

test('subscription structured utility rejects a provider error after a valid tool call', async ({ mock }) => {
  mock.method(console, 'error', () => {})
  const failure = new Error('Subscription stream failed')
  const model = new MockLanguageModelV3({
    doStream: {
      stream: convertArrayToReadableStream([
        {
          type: 'tool-call',
          toolCallId: 'summary',
          toolName: 'structured_response',
          input: JSON.stringify({ title: 'Would otherwise succeed' }),
        },
        { type: 'error', error: failure },
      ]),
    },
  })
  const llm = new LLM({ provider: mockProvider(model), model: 'offline-model' })
  await assert.rejects(
    llm.completeStructured({ prompt: 'Summarize', responseSchema: z.object({ title: z.string() }) }),
    (error) => error === failure
  )
})

test('subscription main/subagent runner rejects a later failed step instead of returning earlier results', async ({
  mock,
}) => {
  mock.method(console, 'error', () => {})
  const failure = new Error('Subscription quota exhausted during next step')
  const streams: Awaited<ReturnType<MockLanguageModelV3['doStream']>>[] = [
    {
      stream: convertArrayToReadableStream([
        {
          type: 'tool-call',
          toolCallId: 'read-1',
          toolName: 'read_document',
          input: JSON.stringify({ path: 'brief.md' }),
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
    {
      stream: convertArrayToReadableStream([
        { type: 'text-start', id: 'response' },
        { type: 'text-delta', id: 'response', delta: 'Partial answer' },
        { type: 'text-end', id: 'response' },
        { type: 'error', error: failure },
      ]),
    },
  ]
  const model = new MockLanguageModelV3({
    doStream: async () => streams.shift()!,
  })
  let completedSteps = 0
  let capturedError: unknown
  await assert.rejects(
    runToolLoop({
      model,
      authMode: 'chatgpt-plan',
      tools: {
        read_document: tool({ inputSchema: z.object({ path: z.string() }), execute: async () => 'Brief content' }),
      },
      messages: [{ role: 'user', content: 'Read and explain the brief' }],
      stopWhen: stepCountIs(2),
      context: {} as any,
      onStepFinish: () => {
        completedSteps += 1
      },
      onError: (error) => {
        capturedError = error
      },
    }),
    (error) => error === failure
  )
  assert.ok(completedSteps >= 1)
  assert.equal(capturedError, failure)
  assert.equal(model.doStreamCalls.length, 2)
})
