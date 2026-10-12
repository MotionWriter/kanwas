import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { promisify } from 'node:util'
import { ChatGPTPlanAuth, ChatGPTPlanAuthError } from '../../libs/chatgpt-plan-auth/index.js'
import { CredentialStore } from '../../libs/chatgpt-plan-auth/store.js'
import { OPENAI_ISSUER, PLAN_SCOPE } from '../../libs/chatgpt-plan-auth/types.js'
import type { CredentialState } from '../../libs/chatgpt-plan-auth/types.js'

const targetId = 'bc8c1dfa-9d4f-4f0e-9d0c-8921efcb40bd'
const otherId = 'd9637c55-df9a-4ffb-a028-eaf69db37aeb'
const execFileAsync = promisify(execFile)

function trialEnvironment(t: TestContext): void {
  const previousNodeEnv = process.env.NODE_ENV
  const previousLocalTrial = process.env.KANWAS_LOCAL_TRIAL
  const previousLocalUserId = process.env.KANWAS_LOCAL_TRIAL_USER_ID
  process.env.NODE_ENV = 'development'
  process.env.KANWAS_LOCAL_TRIAL = 'true'
  process.env.KANWAS_LOCAL_TRIAL_USER_ID = targetId
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousLocalTrial === undefined) delete process.env.KANWAS_LOCAL_TRIAL
    else process.env.KANWAS_LOCAL_TRIAL = previousLocalTrial
    if (previousLocalUserId === undefined) delete process.env.KANWAS_LOCAL_TRIAL_USER_ID
    else process.env.KANWAS_LOCAL_TRIAL_USER_ID = previousLocalUserId
  })
}

async function tempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kanwas-local-owner-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function fixture(): CredentialState {
  return {
    version: 1,
    extAgentHostId: 'urn:uuid:8a4b755e-6c32-4b78-9373-ad003290fdee',
    connection: {
      kanwasUserId: 'local-signin-test',
      issuer: OPENAI_ISSUER,
      subject: 'verified-offline-subject',
      clientId: 'oaiapp_offline_registration',
      email: 'test@example.invalid',
      tokens: {
        accessToken: 'fake-local-access',
        refreshToken: 'fake-local-refresh',
        idToken: 'fake-local-id',
        tokenType: 'Bearer',
        scopes: ['openid', 'offline_access', PLAN_SCOPE],
        expiresAt: Date.now() + 3600_000,
        savedAt: new Date().toISOString(),
      },
    },
  }
}

async function save(directory: string, value: CredentialState): Promise<CredentialStore> {
  const store = new CredentialStore(directory)
  await store.withLock(() => store.write(value))
  return store
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ChatGPTPlanAuthError && error.code === code
}

test('local owner adoption requires both development mode and the explicit trial flag before store access', async (t) => {
  trialEnvironment(t)
  const directory = await tempDirectory(t)
  const auth = new ChatGPTPlanAuth({ directory })
  let storeCalls = 0
  t.mock.method(auth.store, 'withLock', () => {
    storeCalls++
    throw new Error('Guard must run before storage access')
  })
  for (const [nodeEnv, trialFlag] of [
    ['production', 'true'],
    ['test', 'true'],
    ['development', 'false'],
    ['development', 'TRUE'],
    ['development', ''],
  ]) {
    process.env.NODE_ENV = nodeEnv
    process.env.KANWAS_LOCAL_TRIAL = trialFlag
    await assert.rejects(auth.adoptLocalTrialOwner(targetId), hasCode('local_trial_disabled'))
  }
  assert.equal(storeCalls, 0)
})

test('local owner adoption accepts only a generated UUID before store access', async (t) => {
  trialEnvironment(t)
  const directory = await tempDirectory(t)
  const auth = new ChatGPTPlanAuth({ directory })
  let storeCalls = 0
  t.mock.method(auth.store, 'withLock', () => {
    storeCalls++
    throw new Error('Invalid owner must not access storage')
  })
  for (const userId of [
    '',
    'local-signin-test',
    'kanwas-user-1',
    ` ${targetId}`,
    '00000000-0000-0000-0000-000000000000',
  ]) {
    await assert.rejects(auth.adoptLocalTrialOwner(userId), hasCode('invalid_user'))
  }
  assert.equal(storeCalls, 0)
})

test('local owner adoption requires the exact launcher-generated identity before store access', async (t) => {
  trialEnvironment(t)
  const directory = await tempDirectory(t)
  const auth = new ChatGPTPlanAuth({ directory })
  let storeCalls = 0
  t.mock.method(auth.store, 'withLock', () => {
    storeCalls++
    throw new Error('Wrong target must not access storage')
  })
  delete process.env.KANWAS_LOCAL_TRIAL_USER_ID
  await assert.rejects(auth.adoptLocalTrialOwner(targetId), hasCode('wrong_user'))
  process.env.KANWAS_LOCAL_TRIAL_USER_ID = otherId
  await assert.rejects(auth.adoptLocalTrialOwner(targetId), hasCode('wrong_user'))
  assert.equal(storeCalls, 0)
})

test('adoption changes only the exact app owner and preserves the same verified account, registration, and tokens', async (t) => {
  trialEnvironment(t)
  const directory = await tempDirectory(t)
  const previous = fixture()
  const store = await save(directory, previous)
  const originalInfo = await stat(store.filename)
  let networkCalls = 0
  const auth = new ChatGPTPlanAuth({
    directory,
    fetchImpl: (async () => {
      networkCalls++
      throw new Error('Adoption requires no provider request')
    }) as typeof fetch,
  })
  const status = await auth.adoptLocalTrialOwner(targetId)
  assert.equal(status.kanwasUserId, targetId)
  assert.equal(status.connected, true)
  assert.equal(status.planUsageEnabled, true)
  assert.equal(JSON.stringify(status).includes('fake-local-'), false)
  const expected = structuredClone(previous)
  expected.connection!.kanwasUserId = targetId
  assert.deepEqual(await store.read(), expected)
  const replacementInfo = await stat(store.filename)
  const directoryInfo = await stat(directory)
  assert.notEqual(replacementInfo.ino, originalInfo.ino)
  assert.equal(replacementInfo.mode & 0o777, 0o600)
  assert.equal(directoryInfo.mode & 0o777, 0o700)
  await assert.rejects(auth.getAccessToken('local-signin-test'), hasCode('wrong_user'))
  await assert.rejects(auth.getAccessToken(otherId), hasCode('wrong_user'))
  assert.equal(await auth.getAccessToken(targetId), 'fake-local-access')
  assert.equal(networkCalls, 0)
})

test('adoption is idempotent for the same owner without rotating or rewriting credentials', async (t) => {
  trialEnvironment(t)
  const directory = await tempDirectory(t)
  const value = fixture()
  value.connection!.kanwasUserId = targetId
  const store = await save(directory, value)
  const originalInfo = await stat(store.filename)
  const auth = new ChatGPTPlanAuth({ directory })
  const status = await auth.adoptLocalTrialOwner(targetId)
  assert.equal(status.kanwasUserId, targetId)
  assert.deepEqual(await store.read(), value)
  const finalInfo = await stat(store.filename)
  assert.equal(finalInfo.ino, originalInfo.ino)
})

test('an ordinary or already adopted different owner cannot be rebound', async (t) => {
  trialEnvironment(t)
  for (const sourceId of ['kanwas-user-1', otherId]) {
    const directory = await tempDirectory(t)
    const previous = fixture()
    previous.connection!.kanwasUserId = sourceId
    const store = await save(directory, previous)
    const auth = new ChatGPTPlanAuth({ directory })
    await assert.rejects(auth.adoptLocalTrialOwner(targetId), hasCode('wrong_user'))
    assert.deepEqual(await store.read(), previous)
  }
})

test('adoption refuses missing, signed-out, and unpermitted connections without changing them', async (t) => {
  trialEnvironment(t)
  const emptyDirectory = await tempDirectory(t)
  await assert.rejects(
    new ChatGPTPlanAuth({ directory: emptyDirectory }).adoptLocalTrialOwner(targetId),
    hasCode('not_connected')
  )
  for (const condition of ['no-connection', 'signed-out', 'no-plan-scope']) {
    const directory = await tempDirectory(t)
    const previous = fixture()
    if (condition === 'no-connection') delete previous.connection
    if (condition === 'signed-out') delete previous.connection!.tokens
    if (condition === 'no-plan-scope') previous.connection!.tokens!.scopes = ['openid', 'email']
    const store = await save(directory, previous)
    const auth = new ChatGPTPlanAuth({ directory })
    await assert.rejects(
      auth.adoptLocalTrialOwner(targetId),
      hasCode(condition === 'no-plan-scope' ? 'plan_permission_missing' : 'not_connected')
    )
    assert.deepEqual(await store.read(), previous)
  }
})

test('adoption waits for the session lock and validates the latest owner after the lock is released', async (t) => {
  trialEnvironment(t)
  const directory = await tempDirectory(t)
  const initial = fixture()
  const store = await save(directory, initial)
  let releaseLock!: () => void
  let enteredLock!: () => void
  const held = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enteredLock = resolve
  })
  const pendingWrite = store.withLock(async () => {
    enteredLock()
    await held
    initial.connection!.kanwasUserId = otherId
    await store.write(initial)
  })
  await entered
  const auth = new ChatGPTPlanAuth({ directory })
  let adoptionSettled = false
  const pendingAdoption = assert.rejects(auth.adoptLocalTrialOwner(targetId), hasCode('wrong_user')).finally(() => {
    adoptionSettled = true
  })
  await delay(75)
  assert.equal(adoptionSettled, false)
  releaseLock()
  await pendingWrite
  await pendingAdoption
  assert.deepEqual(await store.read(), initial)
})

test('CLI adoption returns only safe metadata and cannot adopt outside local development', async (t) => {
  const directory = await tempDirectory(t)
  const previous = fixture()
  const store = await save(directory, previous)
  const args = ['--import', 'tsx', 'scripts/chatgpt_plan_auth.ts', 'adopt-local-owner', '--user-id', targetId]
  const commandEnv = {
    ...process.env,
    KANWAS_CHATGPT_AUTH_DIR: directory,
    KANWAS_LOCAL_TRIAL: 'true',
    KANWAS_LOCAL_TRIAL_USER_ID: targetId,
  }
  await assert.rejects(
    execFileAsync(process.execPath, args, { env: { ...commandEnv, NODE_ENV: 'production' } }),
    (error: unknown) => {
      assert.equal(typeof error, 'object')
      assert.match(String((error as { stderr: string }).stderr), /^local_trial_disabled:/)
      return true
    }
  )
  assert.deepEqual(await store.read(), previous)
  const result = await execFileAsync(process.execPath, args, { env: { ...commandEnv, NODE_ENV: 'development' } })
  const status = JSON.parse(result.stdout)
  assert.equal(status.kanwasUserId, targetId)
  assert.equal(status.planUsageEnabled, true)
  assert.equal(result.stdout.includes('fake-local-'), false)
  assert.equal(result.stderr, '')
})
