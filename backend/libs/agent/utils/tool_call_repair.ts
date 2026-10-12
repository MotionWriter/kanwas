import { generateText, streamText, stepCountIs, type ModelMessage, type ToolSet } from 'ai'
import type { AgentProviderCallOptions, ProviderConfig } from '../providers/types.js'

type RepairableToolCall = {
  toolCallId: string
  toolName: string
  input: unknown
}

type RepairToolCallPayload = {
  toolCall: RepairableToolCall
  error: unknown
  messages: ModelMessage[]
  system?: unknown
}

type RepairToolCallResult = {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: string
} | null

type ReaskResult = {
  toolCalls: Array<{ toolName: string; input: unknown }>
}

type ToolGenerationResult = ReaskResult & {
  steps: Array<{ toolCalls: ReaskResult['toolCalls'] }>
}

interface GenerateTextForProviderOptions {
  authMode?: ProviderConfig['authMode']
  generateTextFn?: typeof generateText
  streamTextFn?: typeof streamText
}

type StreamChunk = {
  type: string
  error?: unknown
  reason?: string
  finishReason?: string
}

/** Read every event before accepting SDK results that may contain partial steps. */
export async function consumeSuccessfulStream(
  stream: { fullStream: AsyncIterable<StreamChunk>; finishReason: PromiseLike<string> },
  onChunk?: (chunk: StreamChunk) => void
): Promise<void> {
  let finished = false

  // SDK result promises can resolve previously completed steps after a later
  // failure. Consume the full stream first so those steps cannot mask errors.
  for await (const chunk of stream.fullStream) {
    onChunk?.(chunk)
    if (chunk.type === 'error') {
      throw chunk.error ?? new Error('Model stream failed')
    }
    if (chunk.type === 'abort') {
      const error = new Error(chunk.reason ?? 'Model stream aborted')
      error.name = 'AbortError'
      throw error
    }
    if ((chunk.type === 'finish-step' || chunk.type === 'finish') && chunk.finishReason === 'error') {
      throw new Error('Model stream finished with an error')
    }
    if (chunk.type === 'finish') {
      finished = true
    }
  }

  if (!finished) {
    throw new Error('Model stream ended without a finish event')
  }

  const finishReason = await stream.finishReason
  if (finishReason === 'error') {
    throw new Error('Model stream finished with an error')
  }
}

/** Subscription-backed Responses requires streaming, including one-shot helper calls. */
export async function generateTextForProvider(
  parameters: Parameters<typeof generateText>[0],
  options: GenerateTextForProviderOptions
): Promise<ToolGenerationResult> {
  if (options.authMode !== 'chatgpt-plan') {
    return (await (options.generateTextFn ?? generateText)(parameters)) as ToolGenerationResult
  }

  const stream = (options.streamTextFn ?? streamText)(parameters)
  await consumeSuccessfulStream(stream)
  const steps = await stream.steps

  // stream.toolCalls includes only the final step, so aggregate explicitly.
  return { steps, toolCalls: steps.flatMap((step) => step.toolCalls) }
}

export interface CreateToolCallReaskRepairOptions {
  model: unknown
  getModel?: () => unknown
  tools: ToolSet
  providerOptions?: AgentProviderCallOptions
  maxAttemptsPerToolCall?: number
  authMode?: ProviderConfig['authMode']
  generateTextFn?: typeof generateText
  streamTextFn?: typeof streamText
}

const NON_REPAIRABLE_TOOL_NAMES = new Set<string>()

/**
 * Creates an AI SDK tool-call repair function using a one-shot re-ask strategy.
 *
 * If a repaired tool call is not produced, null is returned so the original
 * tool-call error propagates.
 */
export function createToolCallReaskRepair(options: CreateToolCallReaskRepairOptions) {
  const { model, getModel, tools, providerOptions, maxAttemptsPerToolCall = 1 } = options

  const schemaOnlyTools = toSchemaOnlyTools(tools)
  const attemptsByToolCallId = new Map<string, number>()

  return async ({ toolCall, error, messages, system }: RepairToolCallPayload): Promise<RepairToolCallResult> => {
    if (NON_REPAIRABLE_TOOL_NAMES.has(toolCall.toolName)) {
      return null
    }

    const previousAttempts = attemptsByToolCallId.get(toolCall.toolCallId) ?? 0
    if (previousAttempts >= maxAttemptsPerToolCall) {
      return null
    }

    attemptsByToolCallId.set(toolCall.toolCallId, previousAttempts + 1)

    const errorMessage = error instanceof Error ? error.message : String(error)

    try {
      const reask = await generateTextForProvider(
        {
          model: (getModel?.() ?? model) as any,
          system: system as any,
          messages: [
            ...messages,
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: toolCall.input,
                },
              ],
            },
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  output: errorMessage,
                },
              ],
            },
          ] as any,
          tools: schemaOnlyTools as any,
          toolChoice: 'required',
          stopWhen: stepCountIs(1),
          providerOptions: providerOptions as any,
        } as any,
        options
      )

      const repairedToolCall = reask.toolCalls[0]
      if (!repairedToolCall) {
        return null
      }

      return {
        type: 'tool-call',
        toolCallId: toolCall.toolCallId,
        toolName: repairedToolCall.toolName,
        input: JSON.stringify(repairedToolCall.input),
      }
    } catch {
      return null
    }
  }
}

function toSchemaOnlyTools(tools: ToolSet): ToolSet {
  const entries = Object.entries(tools).map(([toolName, toolDefinition]) => {
    const candidate = toolDefinition as {
      description?: string
      inputSchema?: unknown
      strict?: boolean
      inputExamples?: unknown
    }

    return [
      toolName,
      {
        description: candidate.description,
        inputSchema: candidate.inputSchema,
        strict: candidate.strict,
        inputExamples: candidate.inputExamples,
      },
    ] as const
  })

  return Object.fromEntries(entries) as ToolSet
}
