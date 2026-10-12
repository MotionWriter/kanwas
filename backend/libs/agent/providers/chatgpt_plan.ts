import { getAccessToken } from '../../chatgpt-plan-auth/index.js'
import { createChatGPTPlanFetch } from './chatgpt_plan_transport.js'
import { createOpenAIProvider } from './openai.js'
import type { ProviderCredentialConfig } from './index.js'
import type { ProviderConfig, ProviderRuntimeOptions, ProviderSelection } from './types.js'

/** Initial local-only mode: one authorized Kanwas owner, never a shared subscription. */
export function createChatGPTPlanProvider(
  config: ProviderCredentialConfig,
  selection: ProviderSelection,
  runtime: ProviderRuntimeOptions
): ProviderConfig {
  const owner = config.chatgptPlanUserId?.trim()
  const model = selection.model?.trim() || config.chatgptPlanModel?.trim()
  if (!owner || !model) {
    throw new Error(
      'ChatGPT plan mode requires CHATGPT_PLAN_USER_ID and CHATGPT_PLAN_MODEL. Run chatgpt:signin and select a model from chatgpt:models.'
    )
  }
  if (runtime.userId && runtime.userId !== owner) {
    throw new Error('This local ChatGPT plan connection belongs to a different Kanwas user.')
  }

  const provider = createOpenAIProvider(
    'oauth-token-resolved-per-request',
    {
      model,
      reasoningEffort: selection.reasoningEffort as any,
    },
    {
      // Bootstrap providers are lazy. Real calls must be rebound to the authenticated actor.
      fetch: createChatGPTPlanFetch({
        getAccessToken: () => {
          if (!runtime.userId || runtime.userId !== owner) {
            throw new Error('A verified Kanwas user is required for ChatGPT plan inference.')
          }
          return getAccessToken(runtime.userId)
        },
      }),
    }
  )

  return {
    ...provider,
    authMode: 'chatgpt-plan',
    supportsCaching: false,
    supportsNativeTools: false,
    promptOptions: () => ({}),
    generationOptions(input) {
      const options = provider.generationOptions(input)
      // The pinned SDK's reasoning allowlist predates this live-tested slug.
      // This also requests encrypted reasoning for stateless history replay.
      if ((input.modelId?.trim() || model) !== 'gpt-6.1-sol') return options
      return { ...options, openai: { ...options.openai, forceReasoning: true } }
    },
  }
}
