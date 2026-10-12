import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertLocalTrialUser,
  localTrialEmail,
  LocalTrialAccess,
  LocalTrialAccessError,
  type LocalTrialConfiguration,
  type LocalTrialRequest,
} from '../../libs/local-trial/access.js'

const userId = '05325118-913f-4073-a354-736b7fe66c02'
const workspaceId = 'b935fb2d-c30c-4c81-9693-91a57c8a2210'
const configuration: LocalTrialConfiguration = {
  nodeEnv: 'development',
  enabled: true,
  userId,
  actorId: userId,
  bootstrapSecret: 'a'.repeat(64),
  sessionSecret: 'b'.repeat(64),
}
const request: LocalTrialRequest = {
  remoteAddress: '127.0.0.1',
  host: 'localhost:3333',
  secret: configuration.bootstrapSecret,
}
const sessionRequest = { ...request, origin: 'http://localhost:15173', secret: configuration.sessionSecret }

function denied(status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof LocalTrialAccessError)
    assert.equal(error.status, status)
    assert.ok(!error.message.includes(configuration.bootstrapSecret!))
    assert.ok(!error.message.includes(configuration.sessionSecret!))
    return true
  }
}

test('trial account bootstrap is unavailable in production, normal mode, or with a different subscription actor', () => {
  for (const overrides of [
    { nodeEnv: 'production' },
    { nodeEnv: 'test' },
    { enabled: false },
    { userId: undefined },
    { userId: 'not-a-uuid' },
    { actorId: '4dcdffca-719b-44e3-8404-642ab254ecf0' },
    { bootstrapSecret: undefined },
    { sessionSecret: 'short' },
    { sessionSecret: configuration.bootstrapSecret },
  ]) {
    const access = new LocalTrialAccess({ ...configuration, ...overrides })
    assert.throws(() => access.beginBootstrap(request), denied(404))
    assert.throws(() => access.beginSession(sessionRequest), denied(404))
  }
})

test('launcher secrets are required on the correct endpoint without disclosing them in failures', () => {
  for (const secret of [undefined, '', 'c'.repeat(64), 'A'.repeat(64), configuration.sessionSecret]) {
    const access = new LocalTrialAccess(configuration)
    assert.throws(() => access.beginBootstrap({ ...request, secret }), denied(403))
    assert.equal(access.beginBootstrap(request), userId)
    access.completeBootstrap({ userId, workspaceId })
    assert.throws(() => access.beginSession({ ...sessionRequest, secret: configuration.bootstrapSecret }), denied(403))
    assert.deepEqual(access.beginSession(sessionRequest), { userId, workspaceId })
  }
})

test('foreign network peers, DNS-rebinding hosts, and cross-site origins cannot consume valid launcher secrets', () => {
  for (const overrides of [
    { remoteAddress: undefined },
    { remoteAddress: '192.168.1.100' },
    { remoteAddress: '::ffff:192.168.1.100' },
    { host: undefined },
    { host: 'evil.example:3333' },
    { host: 'localhost.evil.example:3333' },
    { host: 'localhost:3333,evil.example' },
    { host: 'localhost:80' },
    { origin: 'null' },
    { origin: 'https://evil.example' },
    { origin: 'http://localhost:15174' },
    { origin: 'http://localhost:15173/evil' },
  ]) {
    const access = new LocalTrialAccess(configuration)
    assert.throws(() => access.beginBootstrap({ ...request, ...overrides }), denied(403))
    assert.equal(access.beginBootstrap(request), userId)
    access.completeBootstrap({ userId, workspaceId })
    assert.throws(() => access.beginSession({ ...sessionRequest, ...overrides }), denied(403))
    assert.deepEqual(access.beginSession(sessionRequest), { userId, workspaceId })
  }
})

test('localhost aliases work while the two exchanges remain independently single-use', () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const access = new LocalTrialAccess(configuration)
    assert.equal(access.beginBootstrap({ ...request, remoteAddress, host: '127.0.0.1:3333' }), userId)
    assert.throws(() => access.beginBootstrap(request), denied(409))
    access.completeBootstrap({ userId, workspaceId })
    assert.deepEqual(access.beginSession({ ...sessionRequest, remoteAddress, origin: 'http://127.0.0.1:15173' }), {
      userId,
      workspaceId,
    })
    assert.throws(() => access.beginSession(sessionRequest), denied(409))
  }
})

test('session minting waits for successful setup and cannot take a different owner or workspace', () => {
  const access = new LocalTrialAccess(configuration)
  assert.throws(() => access.beginSession(sessionRequest), denied(409))
  access.beginBootstrap(request)
  assert.throws(() => access.beginSession(sessionRequest), denied(409))
  assert.throws(() => access.completeBootstrap({ userId: workspaceId, workspaceId }), denied(409))
  assert.throws(() => access.completeBootstrap({ userId, workspaceId: 'invalid' }), denied(409))
  const identity = { userId, workspaceId }
  access.completeBootstrap(identity)
  identity.userId = workspaceId
  assert.deepEqual(access.beginSession(sessionRequest), { userId, workspaceId })
  assert.throws(() => access.completeBootstrap({ userId, workspaceId }), denied(409))
})

test('concurrent requests consume authorization synchronously before asynchronous setup or token minting', async () => {
  const access = new LocalTrialAccess(configuration)
  let bootstraps = 0
  const attempts = await Promise.allSettled(
    [1, 2].map(async () => {
      const owner = access.beginBootstrap(request)
      bootstraps++
      await Promise.resolve()
      access.completeBootstrap({ userId: owner, workspaceId })
    })
  )
  assert.equal(bootstraps, 1)
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1)
  let sessions = 0
  const sessionAttempts = await Promise.allSettled(
    [1, 2].map(async () => {
      access.beginSession(sessionRequest)
      sessions++
      await Promise.resolve()
    })
  )
  assert.equal(sessions, 1)
  assert.equal(sessionAttempts.filter((result) => result.status === 'fulfilled').length, 1)
})

test('the reserved synthetic identity cannot become an existing password or real-email account', () => {
  const user = { id: userId, email: localTrialEmail(userId), password: null }
  assert.doesNotThrow(() => assertLocalTrialUser(user, userId))
  for (const overrides of [
    { id: workspaceId },
    { email: 'real-person@example.com' },
    { email: `local-${workspaceId}@kanwas.invalid` },
    { password: 'hashed-password' },
    { password: '' },
  ]) {
    assert.throws(() => assertLocalTrialUser({ ...user, ...overrides }, userId), denied(409))
  }
})
