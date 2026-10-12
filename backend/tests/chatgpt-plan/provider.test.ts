import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamText } from 'ai'
import { createProviderFromConfig } from '../../libs/agent/providers/index.js'

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
