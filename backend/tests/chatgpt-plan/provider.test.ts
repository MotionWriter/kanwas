import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createProviderFromConfig } from '../../libs/agent/providers/index.js'
import { createChatGPTPlanFetch } from '../../libs/agent/providers/chatgpt_plan_transport.js'
import { CredentialStore } from '../../libs/chatgpt-plan-auth/store.js'
import { OPENAI_ISSUER, PLAN_SCOPE } from '../../libs/chatgpt-plan-auth/types.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const config = {
  openaiAuthMode: 'chatgpt-plan' as const,
  chatgptPlanUserId: 'kanwas-owner',
  chatgptPlanModel: 'account-selected-model',
  openaiApiKey: 'must-not-be-used',
}

test('subscription mode needs an explicit owner and selected model', () => {
  assert.throws(() => createProviderFromConfig({ openaiAuthMode: 'chatgpt-plan' }), /CHATGPT_PLAN_USER_ID/)
  assert.throws(() => createProviderFromConfig({ ...config, chatgptPlanModel: '' }), /CHATGPT_PLAN_MODEL/)
})

test('subscription mode refuses another actor, alternate providers, and a custom endpoint', () => {
  assert.throws(() => createProviderFromConfig(config, {}, { userId: 'collaborator' }), /different Kanwas user/)
  assert.throws(() => createProviderFromConfig(config, { provider: 'anthropic' }), /API-key providers are disabled/)
  assert.throws(
    () => createProviderFromConfig({ ...config, openaiBaseUrl: 'https://example.com' }),
    /official OpenAI endpoint/
  )
})

test('subscription provider selects one model across tiers and disables incompatible features', () => {
  const provider = createProviderFromConfig(config, {}, { userId: 'kanwas-owner' })
  assert.equal(provider.authMode, 'chatgpt-plan')
  assert.equal(provider.supportsNativeTools, false)
  assert.equal(provider.supportsCaching, false)
  assert.deepEqual(provider.promptOptions(), {})
  assert.deepEqual(Object.values(provider.modelTiers), Array(3).fill(config.chatgptPlanModel))
})

test('bootstrap without an authenticated actor fails before credentials or API fallback', async () => {
  const provider = createProviderFromConfig(config)
  const result = streamText({
    model: provider.createModel(config.chatgptPlanModel),
    prompt: 'offline guard',
    onError: () => {},
  })
  const errors: string[] = []
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') errors.push(String(chunk.error))
  }
  assert.ok(errors.some((message) => message.includes('verified Kanwas user')))
})

test('API-key mode still requires an API key', () => {
  assert.throws(() => createProviderFromConfig({ openaiAuthMode: 'api-key' }), /Missing API key/)
  assert.equal(createProviderFromConfig({ openaiApiKey: 'offline-key' }).name, 'openai')
})

test('only the verified subscription model forces reasoning, across every generation hint', () => {
  const provider = createProviderFromConfig({ ...config, chatgptPlanModel: 'gpt-6.1-sol' })
  for (const flowHint of ['execute', 'plan', 'explore', 'external', 'generate', 'utility'] as const) {
    const options = provider.generationOptions({ modelId: 'gpt-6.1-sol', flowHint })
    assert.equal(options.openai?.forceReasoning, true)
    assert.equal(options.openai?.store, false)
  }
  assert.equal(provider.generationOptions({ modelId: '', flowHint: 'execute' }).openai?.forceReasoning, true)
  for (const modelId of ['gpt-5.4', 'gpt-6.1-other', 'gpt-6-chat', 'gpt-6.1-sol-unknown']) {
    assert.equal(provider.generationOptions({ modelId, flowHint: 'execute' }).openai?.forceReasoning, undefined)
  }
  const apiProvider = createProviderFromConfig({ openaiApiKey: 'offline-key' }, { model: 'gpt-6.1-sol' })
  assert.equal(
    apiProvider.generationOptions({ modelId: 'gpt-6.1-sol', flowHint: 'execute' }).openai?.forceReasoning,
    undefined
  )
})

test('verified subscription reasoning options reach the SDK and survive stateless history replay', async () => {
  const requests: Record<string, unknown>[] = []
  const events = [
    { type: 'response.created', response: { id: 'resp-reasoning', model: 'gpt-6.1-sol', created_at: 1 } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs-offline', summary: [], encrypted_content: null },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs-offline', summary: [], encrypted_content: 'offline-encrypted' },
    },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg-offline' } },
    { type: 'response.output_text.delta', item_id: 'msg-offline', delta: 'Offline response' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg-offline' } },
    {
      type: 'response.completed',
      response: { incomplete_details: null, usage: { input_tokens: 3, output_tokens: 2 } },
    },
  ]
  const fetch = createChatGPTPlanFetch({
    getAccessToken: async () => 'offline-token',
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const provider = createProviderFromConfig({ ...config, chatgptPlanModel: 'gpt-6.1-sol' })
  const options = provider.generationOptions({ modelId: 'gpt-6.1-sol', flowHint: 'execute' })
  // Inject only the HTTP boundary; use production generationOptions and real SDK parsing.
  const model = createOpenAI({ apiKey: 'offline-placeholder', fetch }).responses('gpt-6.1-sol')
  const first = streamText({ model, prompt: 'Initial offline turn', providerOptions: options as any, maxRetries: 0 })
  for await (const chunk of first.fullStream) {
    if (chunk.type === 'error') throw chunk.error
  }
  assert.equal(await first.finishReason, 'stop')
  assert.deepEqual(requests[0].reasoning, { effort: 'high', summary: 'auto' })
  assert.deepEqual(requests[0].include, ['reasoning.encrypted_content'])
  assert.equal(requests[0].forceReasoning, undefined)

  // Mirror invocation persistence and per-step formatting before the follow-up.
  const savedResponse = JSON.parse(JSON.stringify(await first.response))
  const second = streamText({
    model,
    messages: [
      { role: 'user', content: 'Initial offline turn' },
      ...provider.formatMessages(savedResponse.messages),
      { role: 'user', content: 'Follow-up offline turn' },
    ],
    providerOptions: options as any,
    maxRetries: 0,
  })
  for await (const chunk of second.fullStream) {
    if (chunk.type === 'error') throw chunk.error
  }
  assert.equal(await second.finishReason, 'stop')
  const history = requests[1].input as Record<string, unknown>[]
  assert.deepEqual(
    history.find((item) => item.type === 'reasoning'),
    {
      type: 'reasoning',
      id: 'rs-offline',
      encrypted_content: 'offline-encrypted',
      summary: [],
    }
  )
  assert.equal(
    history.some((item) => item.type === 'item_reference'),
    false
  )
  assert.ok(requests.every((request) => request.store === false && request.stream === true))
})

test('the production subscription provider pins the official absolute Responses URL with an empty inherited base URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kanwas-provider-base-url-'))
  const store = new CredentialStore(directory)
  await store.withLock(() =>
    store.write({
      version: 1,
      extAgentHostId: 'urn:uuid:8a4b755e-6c32-4b78-9373-ad003290fdee',
      connection: {
        kanwasUserId: config.chatgptPlanUserId,
        issuer: OPENAI_ISSUER,
        subject: 'verified-offline-subject',
        clientId: 'oaiapp_offline_registration',
        tokens: {
          accessToken: 'fake-provider-access',
          tokenType: 'Bearer',
          scopes: [PLAN_SCOPE],
          expiresAt: Date.now() + 3600_000,
          savedAt: new Date().toISOString(),
        },
      },
    })
  )
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousDirectory = process.env.KANWAS_CHATGPT_AUTH_DIR
  const previousFetch = globalThis.fetch
  const requestedUrls: string[] = []
  try {
    process.env.OPENAI_BASE_URL = ''
    process.env.KANWAS_CHATGPT_AUTH_DIR = directory
    globalThis.fetch = async (input, init) => {
      requestedUrls.push(String(input))
      assert.equal(String(input), 'https://api.openai.com/v1/responses')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-provider-access')
      const events = [
        { type: 'response.created', response: { id: 'resp-absolute', model: config.chatgptPlanModel, created_at: 1 } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-absolute' } },
        { type: 'response.output_text.delta', item_id: 'msg-absolute', delta: 'Official route ready.' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-absolute' } },
        {
          type: 'response.completed',
          response: { incomplete_details: null, usage: { input_tokens: 3, output_tokens: 2 } },
        },
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const provider = createProviderFromConfig(
      { ...config, openaiBaseUrl: '' },
      {},
      { userId: config.chatgptPlanUserId }
    )
    const result = streamText({
      model: provider.createModel(config.chatgptPlanModel),
      prompt: 'Exercise the official offline route.',
      providerOptions: provider.generationOptions({ modelId: config.chatgptPlanModel, flowHint: 'utility' }) as any,
      maxRetries: 0,
    })
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'error') throw chunk.error
    }
    assert.equal(await result.text, 'Official route ready.')
    assert.equal(await result.finishReason, 'stop')
    assert.deepEqual(requestedUrls, ['https://api.openai.com/v1/responses'])
    assert.throws(
      () => createProviderFromConfig({ ...config, openaiBaseUrl: 'https://example.invalid/v1' }),
      /official OpenAI endpoint/
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousBaseUrl
    if (previousDirectory === undefined) delete process.env.KANWAS_CHATGPT_AUTH_DIR
    else process.env.KANWAS_CHATGPT_AUTH_DIR = previousDirectory
    await rm(directory, { recursive: true, force: true })
  }
})
