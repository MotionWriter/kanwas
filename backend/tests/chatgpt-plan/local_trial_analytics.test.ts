import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const fixture = {
  constructions: 0,
  captures: [] as { event: string }[],
  identifies: 0,
  groupIdentifies: 0,
  wrappings: 0,
  shutdowns: 0,
}
const fixtureSymbol = Symbol.for('kanwas.local-trial.analytics-test')
Reflect.set(globalThis, fixtureSymbol, fixture)
const fixtureBinding = "const fixture = globalThis[Symbol.for('kanwas.local-trial.analytics-test')]"
const modules: Record<string, string> = {
  '#services/contextual_logger': `export class ContextualLogger { static createFallback() { return { warn() {} } } }`,
  'posthog-node': `${fixtureBinding}
    export class PostHog {
      constructor() { fixture.constructions++ }
      on() {}
      identify() { fixture.identifies++ }
      groupIdentify() { fixture.groupIdentifies++ }
      capture(payload) { fixture.captures.push(payload) }
      async shutdown() { fixture.shutdowns++ }
    }`,
  '@posthog/ai': `${fixtureBinding}
    export function withTracing(model) { fixture.wrappings++; return { wrapped: model } }`,
}
// Exercise the real service while replacing only its logger and analytics network boundaries.
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = modules[specifier]
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
let PostHogService: typeof import('../../app/services/posthog_service.js').default
try {
  const serviceModule = await import('../../app/services/posthog_service.js')
  PostHogService = serviceModule.default
} finally {
  hook.deregister()
}

const identity = {
  distinctId: 'fixture-user',
  workspaceId: 'fixture-workspace',
  organizationId: 'fixture-organization',
  invocationId: 'fixture-invocation',
  correlationId: 'fixture-correlation',
}
const tracing = { ...identity, traceId: 'fixture-trace', sessionId: 'fixture-session' }

function resetFixture() {
  fixture.constructions = 0
  fixture.captures.length = 0
  fixture.identifies = 0
  fixture.groupIdentifies = 0
  fixture.wrappings = 0
  fixture.shutdowns = 0
}

function exerciseCaptureMethods(service: InstanceType<typeof PostHogService>) {
  service.identifyUser({ id: identity.distinctId, name: 'Fixture User', email: 'fixture@example.invalid' })
  service.trackWorkspaceViewed({
    correlationId: identity.correlationId,
    user: {
      id: identity.distinctId,
      name: 'Fixture User',
      email: 'fixture@example.invalid',
      createdAt: null,
      updatedAt: null,
    },
    workspace: { id: identity.workspaceId, name: 'Fixture workspace', createdAt: null, updatedAt: null },
    organization: { id: identity.organizationId, name: 'Fixture organization', createdAt: null, updatedAt: null },
    organizationRole: 'admin',
  })
  service.captureAiTrace({
    ...tracing,
    traceName: 'Fixture trace',
    status: 'completed',
    input: 'Fixture prompt',
    output: 'Fixture result',
  })
  service.captureAiSpan({
    ...tracing,
    spanId: 'fixture-span',
    spanName: 'Fixture span',
    status: 'completed',
    input: 'Fixture prompt',
    output: 'Fixture result',
  })
  service.captureAiGeneration({
    ...tracing,
    model: 'fixture-model',
    provider: 'openai',
    input: 'Fixture prompt',
    output: 'Fixture result',
  })
}

test('local trial analytics constructs no client, queues no payloads, and returns the original model', async () => {
  const previous = process.env.KANWAS_LOCAL_TRIAL
  try {
    resetFixture()
    process.env.KANWAS_LOCAL_TRIAL = 'true'
    const service = new PostHogService()
    const model = { modelId: 'fixture-model' }
    assert.equal(service.wrapModelWithTracing(model, tracing), model)
    exerciseCaptureMethods(service)
    await service.shutdown()
    assert.deepEqual(fixture, {
      constructions: 0,
      captures: [],
      identifies: 0,
      groupIdentifies: 0,
      wrappings: 0,
      shutdowns: 0,
    })
  } finally {
    if (previous === undefined) delete process.env.KANWAS_LOCAL_TRIAL
    else process.env.KANWAS_LOCAL_TRIAL = previous
  }
})

test('ordinary analytics retains client creation, identity events, AI captures, wrapping, and shutdown', async () => {
  const previous = process.env.KANWAS_LOCAL_TRIAL
  try {
    resetFixture()
    delete process.env.KANWAS_LOCAL_TRIAL
    const service = new PostHogService()
    const model = { modelId: 'fixture-model' }
    assert.notEqual(service.wrapModelWithTracing(model, tracing), model)
    exerciseCaptureMethods(service)
    await service.shutdown()
    assert.equal(fixture.constructions, 1)
    assert.equal(fixture.wrappings, 1)
    assert.equal(fixture.identifies, 2)
    assert.equal(fixture.groupIdentifies, 2)
    assert.deepEqual(
      fixture.captures.map((capture) => capture.event),
      ['workspace viewed', '$ai_trace', '$ai_span', '$ai_generation']
    )
    assert.equal(fixture.shutdowns, 1)
  } finally {
    if (previous === undefined) delete process.env.KANWAS_LOCAL_TRIAL
    else process.env.KANWAS_LOCAL_TRIAL = previous
  }
})
