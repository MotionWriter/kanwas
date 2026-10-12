import { ChatGPTPlanAuthError, OPENAI_RESOURCE } from './types.js'

export interface AvailableModel {
  slug: string
  display_name: string
}

/** Inference diagnostics retain safe codes and request IDs; authorization credentials are never attached. */
export class ChatGPTPlanRequestError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly providerCode?: string,
    public readonly requestId?: string,
    public readonly bodyShape?: 'error' | 'detail' | 'other'
  ) {
    super(message)
    this.name = 'ChatGPTPlanRequestError'
  }
}

function safeDiagnostic(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

async function apiRequest(
  accessToken: string,
  endpoint: 'models' | 'responses',
  options: RequestInit,
  fetchImpl: typeof fetch
): Promise<Response> {
  let response: Response
  try {
    response = await fetchImpl(`${OPENAI_RESOURCE}/${endpoint}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      headers: { ...options.headers, authorization: `Bearer ${accessToken}` },
    })
  } catch {
    throw new ChatGPTPlanRequestError('Could not reach OpenAI for this ChatGPT plan request. Retry later.')
  }
  if (!response.ok) {
    const body = object(await response.json().catch(() => undefined))
    const code = safeDiagnostic(object(body?.error)?.code)
    const shape = body?.error ? 'error' : typeof body?.detail === 'string' ? 'detail' : 'other'
    const requestId = safeDiagnostic(response.headers.get('x-request-id') || response.headers.get('openai-request-id'))
    throw new ChatGPTPlanRequestError(
      `ChatGPT plan request failed (HTTP ${response.status}${code ? `, ${code}` : ''}).`,
      response.status,
      code,
      requestId,
      shape
    )
  }
  return response
}

export async function listAvailableModels(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<AvailableModel[]> {
  const response = await apiRequest(accessToken, 'models', { method: 'GET' }, fetchImpl)
  const body = object(await response.json().catch(() => undefined))
  if (!body || !Array.isArray(body.models)) {
    throw new ChatGPTPlanRequestError('OpenAI did not return the ChatGPT account model catalog.')
  }
  return body.models
    .filter((model: unknown): model is AvailableModel & { visibility: string } => {
      if (!model || typeof model !== 'object') return false
      const record = model as Record<string, unknown>
      return record.visibility === 'list' && typeof record.slug === 'string' && typeof record.display_name === 'string'
    })
    .map((model: AvailableModel) => ({ slug: model.slug, display_name: model.display_name }))
}

/** Tiny text-only live probe, invoked only by an explicit CLI command. Success requires response.completed. */
export async function probeResponse(
  accessToken: string,
  model: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(model)) {
    throw new ChatGPTPlanAuthError(
      'invalid_response',
      'Choose a valid model slug from the signed-in ChatGPT account catalog.'
    )
  }
  const response = await apiRequest(
    accessToken,
    'responses',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: 'Say exactly: Hello from Kanwas.' }],
        store: false,
        stream: true,
      }),
    },
    fetchImpl
  )
  if (!response.body) throw new ChatGPTPlanRequestError('OpenAI returned no response stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let completed = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      if (buffer.length > 2 * 1024 * 1024)
        throw new ChatGPTPlanRequestError('The response stream exceeded the local probe limit.')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data || data === '[DONE]') continue
        let event: Record<string, unknown>
        try {
          event = JSON.parse(data)
        } catch {
          throw new ChatGPTPlanRequestError('OpenAI returned an invalid response-stream event.')
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          text += event.delta
          if (text.length > 2 * 1024 * 1024)
            throw new ChatGPTPlanRequestError('The response exceeded the local probe limit.')
        } else if (event.type === 'response.completed') {
          completed = true
        } else if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
          const error =
            event.response && typeof event.response === 'object'
              ? (event.response as Record<string, unknown>).error
              : event.error
          const code =
            error && typeof error === 'object'
              ? safeDiagnostic((error as Record<string, unknown>).code)
              : safeDiagnostic(event.code)
          throw new ChatGPTPlanRequestError(
            `ChatGPT response did not complete${code ? ` (${code})` : ''}.`,
            undefined,
            code
          )
        }
      }
      if (done) break
    }
  } catch (error) {
    if (error instanceof ChatGPTPlanRequestError) throw error
    throw new ChatGPTPlanRequestError('The ChatGPT response stream was interrupted before completed inference.')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (!completed) throw new ChatGPTPlanRequestError('The ChatGPT response stream ended without response.completed.')
  return text
}
