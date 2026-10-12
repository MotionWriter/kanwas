export type {
  FlowHint,
  ProviderConfig,
  ProviderName,
  ProviderOverrideOptions,
  ProviderRuntimeOptions,
  ProviderSelection,
} from './types.js'
export { createAnthropicProvider } from './anthropic.js'
export { createOpenAIProvider } from './openai.js'

import type { ProviderName } from './types.js'
import type { ProviderConfig, ProviderOverrideOptions, ProviderRuntimeOptions, ProviderSelection } from './types.js'
import {
  DEFAULT_LLM_PROVIDER,
  normalizeLlmModel,
  normalizeLlmProvider,
  normalizeReasoningEffortForProvider,
  normalizeServiceTierForProvider,
} from 'shared/llm-config'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai.js'
import { createChatGPTPlanProvider } from './chatgpt_plan.js'

export interface ProviderCredentialConfig {
  anthropicApiKey?: string
  openaiApiKey?: string
  openaiBaseUrl?: string
  openaiAuthMode?: 'api-key' | 'chatgpt-plan'
  chatgptPlanUserId?: string
  chatgptPlanModel?: string
}

export function createProvider(
  name: ProviderName,
  apiKey: string,
  overrides: ProviderOverrideOptions = {},
  runtimeOptions: ProviderRuntimeOptions = {},
  baseURL?: string
): ProviderConfig {
  switch (name) {
    case 'anthropic':
      return createAnthropicProvider(apiKey, overrides)
    case 'openai':
      return createOpenAIProvider(apiKey, overrides, runtimeOptions, baseURL)
    default:
      return assertNever(name)
  }
}

const API_KEY_MAP: Record<ProviderName, string> = {
  anthropic: 'anthropicApiKey',
  openai: 'openaiApiKey',
}

/**
 * Create a ProviderConfig from the agent config object.
 * Default provider is anthropic. Per-user override via llmProvider in user config.
 */
export function createProviderFromConfig(
  config: ProviderCredentialConfig,
  selection: ProviderSelection = {},
  runtimeOptions: ProviderRuntimeOptions = {}
): ProviderConfig {
  const normalizedProvider = normalizeLlmProvider(selection.provider)
  const providerName = normalizedProvider ?? DEFAULT_LLM_PROVIDER
  if (config.openaiAuthMode === 'chatgpt-plan') {
    if (providerName !== 'openai') {
      throw new Error('ChatGPT plan mode requires OpenAI. API-key providers are disabled in this mode.')
    }
    if (config.openaiBaseUrl) {
      throw new Error('ChatGPT plan mode uses the official OpenAI endpoint; remove OPENAI_BASE_URL.')
    }
    return createChatGPTPlanProvider(config, selection, runtimeOptions)
  }
  const keyField = API_KEY_MAP[providerName]
  const apiKey = config[keyField as keyof typeof config] as string | undefined

  if (!apiKey) {
    throw new Error(
      `Missing API key for provider "${providerName}". Set the ${keyField.replace(/([A-Z])/g, '_$1').toUpperCase()} environment variable.`
    )
  }

  const baseURL = providerName === 'openai' ? config.openaiBaseUrl : undefined

  return createProvider(
    providerName,
    apiKey,
    {
      model: normalizeLlmModel(selection.model),
      reasoningEffort: normalizeReasoningEffortForProvider(selection.reasoningEffort, normalizedProvider),
      serviceTier: normalizeServiceTierForProvider(selection.serviceTier, normalizedProvider),
    },
    runtimeOptions,
    baseURL
  )
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${value}`)
}
