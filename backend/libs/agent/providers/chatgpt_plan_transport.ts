/**
 * Compatibility boundary for the documented public ChatGPT-plan Responses route.
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 *
 * Client-executed tools are supplied as additional_tools input items. Their names,
 * call IDs, arguments, and results stay unchanged, so the pinned OpenAI SDK can
 * continue to dispatch them. No undocumented ChatGPT backend endpoint is used.
 */
export interface ChatGPTPlanTransportOptions {
  /** Resolve/refresh the selected account's token immediately before each request. */
  getAccessToken: () => Promise<string>
  /** May wrap logging; credentials must never be logged by the supplied fetch. */
  fetch?: typeof globalThis.fetch
}

export class ChatGPTPlanTransportError extends Error {
  readonly code: string
  readonly requestId: string | null

  constructor(message: string, code = 'chatgpt_plan_unsupported_request', requestId: string | null = null) {
    super(message)
    this.name = 'ChatGPTPlanTransportError'
    this.code = code
    this.requestId = requestId
  }
}

type JsonRecord = Record<string, unknown>

function present(value: unknown): boolean {
  return value !== null && value !== undefined
}

// Tuning/telemetry settings that are not available on the preview route.
const OMITTED_FIELDS = new Set([
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
])
const SUPPORTED_FIELDS = new Set([
  'model',
  'input',
  'instructions',
  'stream',
  'store',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'text',
  'include',
  'service_tier',
  'prompt_cache_key',
])
const WEB_SEARCH_TYPES = new Set(['web_search', 'web_search_preview'])

function fail(message: string): never {
  throw new ChatGPTPlanTransportError(message)
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`)
  return value as JsonRecord
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string.`)
}

function checkKeys(value: JsonRecord, keys: string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`Unsupported ${label} field: ${key}.`)
  }
}

function validateLocalTool(value: unknown): JsonRecord {
  const tool = record(value, 'Tool')
  if (tool.type !== 'function' && tool.type !== 'custom') fail(`Unsupported tool type: ${String(tool.type)}.`)
  const allowed = ['type', 'name', 'description', 'allowed_callers', 'async', 'defer_loading']
  checkKeys(
    tool,
    [...allowed, ...(tool.type === 'function' ? ['parameters', 'strict', 'output_schema'] : ['format'])],
    'tool'
  )
  requireString(tool.name, 'Tool name')
  if (tool.defer_loading === true) fail('Deferred tool loading is unavailable with ChatGPT plan usage.')
  if (tool.async === true) fail('Asynchronous tools are not supported by this transport.')
  if (
    present(tool.allowed_callers) &&
    (!Array.isArray(tool.allowed_callers) || tool.allowed_callers.some((caller) => caller !== 'direct'))
  ) {
    fail('Only direct client-executed tool calls are supported.')
  }
  if (tool.type === 'function') record(tool.parameters, 'Function parameters')
  return tool
}

function validateContent(value: unknown, label: string): void {
  if (typeof value === 'string') return
  if (!Array.isArray(value)) fail(`${label} must be text or an array of content parts.`)
  for (const part of value) {
    const content = record(part, 'Content part')
    switch (content.type) {
      case 'input_text':
      case 'output_text':
        if (typeof content.text !== 'string') fail('Text content must contain text.')
        break
      case 'input_image':
        if (present(content.file_id)) fail('Uploaded Files API IDs are unavailable with ChatGPT plan usage.')
        requireString(content.image_url, 'Image URL or data URI')
        break
      case 'input_file':
        if (present(content.file_id)) fail('Uploaded Files API IDs are unavailable with ChatGPT plan usage.')
        if (typeof content.file_data !== 'string' && typeof content.file_url !== 'string') {
          fail('Files must be included as file_data or file_url.')
        }
        break
      default:
        fail(`Unsupported content part: ${String(content.type)}.`)
    }
  }
}

function transformInput(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) fail('ChatGPT plan requests must include their full context in an input array.')
  return value.map((raw) => {
    const item = record(raw, 'Input item')
    switch (item.type) {
      case undefined:
      case 'message': {
        if (!['user', 'assistant', 'developer', 'system'].includes(String(item.role))) {
          fail(`Unsupported message role: ${String(item.role)}.`)
        }
        validateContent(item.content, 'Message content')
        return item.role === 'system' ? { ...item, role: 'developer' } : item
      }
      case 'function_call':
      case 'custom_tool_call':
        requireString(item.call_id, 'Tool call ID')
        requireString(item.name, 'Tool call name')
        if (present(item.namespace)) fail('Namespaced history is not supported by this flat-name transport.')
        if (typeof item[item.type === 'function_call' ? 'arguments' : 'input'] !== 'string') {
          fail('Tool call input must be a string.')
        }
        return item
      case 'function_call_output':
      case 'custom_tool_call_output':
        requireString(item.call_id, 'Tool result call ID')
        validateContent(item.output, 'Tool result')
        return item
      case 'reasoning':
        requireString(item.encrypted_content, 'Stateless reasoning encrypted content')
        return item
      case 'additional_tools':
        if (item.role !== 'developer' || !Array.isArray(item.tools)) fail('Invalid additional_tools input item.')
        return { ...item, tools: item.tools.map(validateLocalTool) }
      case 'item_reference':
        return fail('Persistent item references are unavailable. Supply the complete history with store: false.')
      default:
        fail(`Unsupported input item: ${String(item.type)}.`)
    }
  })
}

/** Exported for offline request-contract tests; never mutates the SDK's body. */
export function prepareChatGPTPlanRequest(value: unknown): JsonRecord {
  const original = record(value, 'Responses body')
  if (original.stream !== true) fail('ChatGPT plan usage requires streamText; non-streaming requests are unsupported.')
  requireString(original.model, 'Model')
  const body: JsonRecord = {}
  for (const [key, field] of Object.entries(original)) {
    if (OMITTED_FIELDS.has(key)) continue
    if (key === 'background' && (field === false || !present(field))) continue
    // These fields carry execution/context semantics and must never be silently dropped.
    if (['background', 'conversation', 'previous_response_id', 'prompt', 'moderation', 'multi_agent'].includes(key)) {
      if (present(field)) fail(`Unsupported context or execution field: ${key}.`)
      continue
    }
    if (!SUPPORTED_FIELDS.has(key)) fail(`Unsupported Responses field: ${key}.`)
    body[key] = field
  }
  body.store = false
  body.input = transformInput(original.input)

  const localTools: JsonRecord[] = []
  const serverTools: JsonRecord[] = []
  if (present(body.tools)) {
    if (!Array.isArray(body.tools)) fail('Tools must be an array.')
    for (const rawTool of body.tools) {
      const tool = record(rawTool, 'Tool')
      if (WEB_SEARCH_TYPES.has(String(tool.type))) serverTools.push(tool)
      else localTools.push(validateLocalTool(tool))
    }
  }
  const input = body.input as JsonRecord[]
  const names = new Set<string>()
  for (const tool of [
    ...localTools,
    ...input.flatMap((item) => (item.type === 'additional_tools' ? (item.tools as JsonRecord[]) : [])),
  ]) {
    if (names.has(tool.name as string)) fail(`Duplicate tool name: ${String(tool.name)}.`)
    names.add(tool.name as string)
  }
  if (localTools.length) {
    // Place definitions before history. Flat names and call IDs need no response rewrite.
    input.unshift({ type: 'additional_tools', role: 'developer', tools: localTools })
  }
  if (serverTools.length) body.tools = serverTools
  else delete body.tools
  if (present(body.tool_choice) && typeof body.tool_choice !== 'string') {
    const choice = record(body.tool_choice, 'Tool choice')
    checkKeys(choice, ['type', 'name'], 'tool choice')
    if (choice.type === 'function' || choice.type === 'custom') {
      if (!names.has(String(choice.name))) fail('Forced tool choice must refer to a declared client tool.')
    } else if (!WEB_SEARCH_TYPES.has(String(choice.type))) fail('Unsupported tool choice.')
  } else if (present(body.tool_choice) && !['auto', 'none', 'required'].includes(String(body.tool_choice))) {
    fail('Unsupported tool choice.')
  }
  return body
}

/**
 * @ai-sdk/openai 3.0.41 does not recognize response.failed, and accepts incomplete
 * or abruptly-ended streams. Preserve SSE bytes but enforce documented completion
 * before the SDK can report success (including usage failures after HTTP 200).
 */
function guardCompletedStream(response: Response): Response {
  const requestId = response.headers.get('x-request-id')
  const contentType = response.headers.get('content-type')
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase()
  // The public plan endpoint can omit Content-Type on a valid SSE response.
  // Its body must still pass event parsing and response.completed checks below.
  if (!response.body || (contentType !== null && mediaType !== 'text/event-stream')) {
    throw new ChatGPTPlanTransportError(
      'Expected a streaming Responses API result.',
      'chatgpt_plan_invalid_stream',
      requestId
    )
  }
  const decoder = new TextDecoder()
  let pending = ''
  let completed = false
  function readEvents(text: string): void {
    pending += text
    let boundary: RegExpExecArray | null
    while ((boundary = /\r\n\r\n|\n\n|\r\r|\r\n\n|\n\r\n/.exec(pending))) {
      const event = pending.slice(0, boundary.index)
      pending = pending.slice(boundary.index + boundary[0].length)
      const data = event
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data || data === '[DONE]') continue
      let parsed: JsonRecord
      try {
        parsed = record(JSON.parse(data), 'SSE event')
      } catch {
        throw new ChatGPTPlanTransportError(
          'Malformed Responses stream event.',
          'chatgpt_plan_invalid_stream',
          requestId
        )
      }
      if (parsed.type === 'response.completed') completed = true
      if (['response.failed', 'response.incomplete', 'error'].includes(String(parsed.type))) {
        const result = parsed.response && typeof parsed.response === 'object' ? (parsed.response as JsonRecord) : parsed
        const error = result.error && typeof result.error === 'object' ? (result.error as JsonRecord) : result
        const details =
          result.incomplete_details && typeof result.incomplete_details === 'object'
            ? (result.incomplete_details as JsonRecord)
            : undefined
        const code =
          typeof error.code === 'string'
            ? error.code
            : typeof details?.reason === 'string'
              ? details.reason
              : String(parsed.type)
        throw new ChatGPTPlanTransportError(`ChatGPT plan response failed: ${code}.`, code, requestId)
      }
    }
    if (pending.length > 8 * 1024 * 1024) {
      throw new ChatGPTPlanTransportError(
        'Responses stream event exceeds the buffer limit.',
        'chatgpt_plan_invalid_stream',
        requestId
      )
    }
  }
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        readEvents(decoder.decode(chunk, { stream: true }))
        controller.enqueue(chunk)
      },
      flush() {
        readEvents(decoder.decode())
        if (!completed) {
          throw new ChatGPTPlanTransportError(
            'Responses stream ended without response.completed.',
            'chatgpt_plan_incomplete_stream',
            requestId
          )
        }
      },
    })
  )
  const headers = new Headers(response.headers)
  if (contentType === null) headers.set('content-type', 'text/event-stream')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

export function createChatGPTPlanFetch(options: ChatGPTPlanTransportOptions): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== 'https://api.openai.com' || url.username || url.password || url.search || url.hash) {
      fail('ChatGPT plan credentials may only be sent to the documented public OpenAI endpoints.')
    }
    const inference = request.method === 'POST' && url.pathname === '/v1/responses'
    const models = request.method === 'GET' && url.pathname === '/v1/models'
    if (!inference && !models) fail('Unsupported ChatGPT plan method or endpoint.')
    let body: string | undefined
    if (inference) {
      if (!request.headers.get('content-type')?.includes('application/json')) fail('Responses requests must use JSON.')
      let parsed: unknown
      try {
        parsed = JSON.parse(await request.text())
      } catch {
        fail('Responses requests must contain valid JSON.')
      }
      body = JSON.stringify(prepareChatGPTPlanRequest(parsed))
    }
    // Validate destination/body first, then fetch a fresh token. Never preserve SDK
    // API-key, organization, or project headers that imply another billing path.
    const token = await options.getAccessToken()
    if (!token || /\s/.test(token)) fail('No valid ChatGPT-plan access token is available. Sign in again.')
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${token}`)
    headers.delete('openai-organization')
    headers.delete('openai-project')
    headers.delete('content-length')
    if (inference) headers.set('accept', 'text/event-stream')
    const response = await (options.fetch ?? globalThis.fetch)(request.url, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: request.signal,
      redirect: 'error',
    })
    return inference && response.ok ? guardCompletedStream(response) : response
  }
}
