import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatGPTPlanRequestError, listAvailableModels, probeResponse } from '../../libs/chatgpt-plan-auth/probe.js'

function stream(events: unknown[], chunks = false): Response {
  const data = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')
  const pieces = chunks ? [data.slice(0, 7), data.slice(7, 23), data.slice(23)] : [data]
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}

test('models prints only visible display names/slugs in server order', async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.openai.com/v1/models')
    assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer fake-access')
    return Response.json({
      models: [
        { slug: 'model-b', display_name: 'Model B', visibility: 'list', private_metadata: 'omit' },
        { slug: 'model-hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'model-a', display_name: 'Model A', visibility: 'list' },
      ],
    })
  }) as typeof fetch
  assert.deepEqual(await listAvailableModels('fake-access', fetchImpl), [
    { slug: 'model-b', display_name: 'Model B' },
    { slug: 'model-a', display_name: 'Model A' },
  ])
})

test('probe uses public Responses stream with store=false and waits for completed inference', async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.openai.com/v1/responses')
    const body = JSON.parse(init!.body as string)
    assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'store', 'stream'])
    assert.equal(body.store, false)
    assert.equal(body.stream, true)
    return stream(
      [
        { type: 'response.output_text.delta', delta: 'Hello ' },
        { type: 'response.output_text.delta', delta: 'Kanwas' },
        { type: 'response.completed' },
      ],
      true
    )
  }) as typeof fetch
  assert.equal(await probeResponse('fake-access', 'catalog-slug', fetchImpl), 'Hello Kanwas')
})

test('interrupted, incomplete, and failed streams never count as success', async () => {
  for (const terminal of [
    undefined,
    { type: 'response.incomplete' },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
  ]) {
    const events = [{ type: 'response.output_text.delta', delta: 'partial' }, ...(terminal ? [terminal] : [])]
    await assert.rejects(
      probeResponse('fake-access', 'catalog-slug', (async () => stream(events)) as typeof fetch),
      ChatGPTPlanRequestError
    )
  }
})

test('admission failures preserve HTTP status, safe error code, body shape, and request ID without fallback', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return Response.json({ detail: 'Restricted region' }, { status: 403, headers: { 'x-request-id': 'req_fake_123' } })
  }) as typeof fetch
  await assert.rejects(probeResponse('fake-access', 'catalog-slug', fetchImpl), (error: unknown) => {
    assert.ok(error instanceof ChatGPTPlanRequestError)
    assert.equal(error.httpStatus, 403)
    assert.equal(error.bodyShape, 'detail')
    assert.equal(error.requestId, 'req_fake_123')
    assert.equal(String(error).includes('fake-access'), false)
    return true
  })
  assert.equal(calls, 1)
})
