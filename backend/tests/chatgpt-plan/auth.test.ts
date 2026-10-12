import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { ChatGPTPlanAuth, ChatGPTPlanAuthError } from '../../libs/chatgpt-plan-auth/index.js'
import { CredentialStore } from '../../libs/chatgpt-plan-auth/store.js'
import {
  authorizationUrl,
  consumeCallback,
  createSignInTransaction,
  startLoopbackAttempt,
} from '../../libs/chatgpt-plan-auth/oauth.js'
import {
  OPENAI_ISSUER,
  OPENAI_RESOURCE,
  OPENAI_TOKEN_ENDPOINT,
  PLAN_SCOPE,
} from '../../libs/chatgpt-plan-auth/types.js'
import type { CredentialState } from '../../libs/chatgpt-plan-auth/types.js'

const now = Date.now()
const clientId = 'oaiapp_test_registration'
const userId = 'kanwas-user-1'
const { privateKey, publicKey } = await generateKeyPair('RS256')
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }

async function tempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kanwas-auth-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function state(overrides: Partial<CredentialState['connection']> = {}): CredentialState {
  return {
    version: 1,
    extAgentHostId: 'urn:uuid:8a4b755e-6c32-4b78-9373-ad003290fdee',
    connection: {
      kanwasUserId: userId,
      issuer: OPENAI_ISSUER,
      subject: 'verified-subject',
      clientId,
      email: 'test@example.invalid',
      tokens: {
        accessToken: 'fake-access-old',
        refreshToken: 'fake-refresh-old',
        idToken: 'fake-id-old',
        tokenType: 'Bearer',
        scopes: ['openid', 'offline_access', PLAN_SCOPE],
        expiresAt: now + 3600_000,
        savedAt: new Date(now).toISOString(),
      },
      ...overrides,
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

async function idToken(
  options: {
    nonce?: string
    issuer?: string
    audience?: string
    subject?: string
    expires?: number
    badSignature?: boolean
  } = {}
): Promise<string> {
  const alternateKey = options.badSignature ? await generateKeyPair('RS256') : undefined
  const key = alternateKey?.privateKey || privateKey
  return new SignJWT({ nonce: options.nonce, email: 'test@example.invalid' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer || OPENAI_ISSUER)
    .setAudience(options.audience || clientId)
    .setSubject(options.subject ?? 'verified-subject')
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(options.expires ?? Math.floor(now / 1000) + 3600)
    .sign(key)
}

function responseJson(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function authFetch(tokenHandler?: (init: RequestInit | undefined) => Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration')) {
      return responseJson({
        issuer: OPENAI_ISSUER,
        jwks_uri: `${OPENAI_ISSUER}/keys`,
        revocation_endpoint: `${OPENAI_ISSUER}/revoke`,
      })
    }
    if (url.endsWith('/keys')) return responseJson({ keys: [publicJwk] })
    if (url === OPENAI_TOKEN_ENDPOINT && tokenHandler) return tokenHandler(init)
    throw new Error('Unexpected offline test request')
  }) as typeof fetch
}

function refreshedTokens(): Record<string, unknown> {
  return {
    access_token: 'fake-access-new',
    refresh_token: 'fake-refresh-new',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: `openid offline_access ${PLAN_SCOPE}`,
  }
}

test('new authorization uses stable host, fresh state/nonce, and correct PKCE S256', () => {
  const first = createSignInTransaction('http://127.0.0.1:1455/auth/callback')
  const second = createSignInTransaction('http://127.0.0.1:1455/auth/callback')
  const url = new URL(authorizationUrl(first, state().extAgentHostId))
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('agent_name_hint'), 'Kanwas')
  assert.equal(url.searchParams.get('ext_agent_host_id'), state().extAgentHostId)
  assert.equal(url.searchParams.get('resource'), OPENAI_RESOURCE)
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(first.codeVerifier).digest('base64url')
  )
  assert.notEqual(first.state, second.state)
  assert.notEqual(first.nonce, second.nonce)
  assert.equal(url.searchParams.has('id_token_hint'), false)
  assert.equal(
    new URL(
      authorizationUrl(createSignInTransaction(first.redirectUri, clientId), state().extAgentHostId)
    ).searchParams.has('agent_name_hint'),
    false
  )
})

test('authorization cannot bind localhost, LAN, or a different callback path', () => {
  for (const url of [
    'http://localhost:1455/auth/callback',
    'http://0.0.0.0:1455/auth/callback',
    'http://127.0.0.1:1455/callback',
  ]) {
    assert.throws(() => createSignInTransaction(url), hasCode('invalid_callback'))
  }
})

test('callback requires an issued client and allows returning callback to omit client_id', () => {
  const transaction = createSignInTransaction('http://127.0.0.1:1455/auth/callback')
  assert.deepEqual(
    consumeCallback(
      transaction,
      `${transaction.redirectUri}?code=fake-code&state=${transaction.state}&client_id=${clientId}`
    ),
    { code: 'fake-code', clientId }
  )
  const returning = createSignInTransaction(transaction.redirectUri, clientId)
  assert.equal(
    consumeCallback(returning, `${returning.redirectUri}?code=fake-code&state=${returning.state}`).clientId,
    clientId
  )
})

test('callback rejects missing/mismatched/expired/reused state, errors, and swapped clients', () => {
  for (const change of ['state', 'expired', 'client', 'missing-client', 'duplicate-state', 'denied']) {
    const transaction = createSignInTransaction(
      'http://127.0.0.1:1455/auth/callback',
      change === 'client' ? clientId : undefined
    )
    const url = new URL(transaction.redirectUri)
    url.searchParams.set('code', 'fake-code')
    url.searchParams.set('state', change === 'state' ? 'incorrect' : transaction.state)
    if (change !== 'missing-client')
      url.searchParams.set('client_id', change === 'client' ? 'oaiapp_different' : clientId)
    if (change === 'expired') transaction.expiresAt = 0
    if (change === 'duplicate-state') url.searchParams.append('state', transaction.state)
    if (change === 'denied') url.searchParams.set('error', 'access_denied')
    assert.throws(
      () => consumeCallback(transaction, url.toString()),
      hasCode(change === 'denied' ? 'sign_in_declined' : 'invalid_callback')
    )
    assert.throws(() => consumeCallback(transaction, url.toString()), hasCode('invalid_callback'))
  }
})

test('ID tokens require valid signature, issuer, issued-client audience, expiry, nonce, and subject', async (t) => {
  const directory = await tempDirectory(t)
  const auth = new ChatGPTPlanAuth({ directory, fetchImpl: authFetch(), now: () => now })
  const validIdentity = await auth.verifyIdentity(await idToken({ nonce: 'test-nonce' }), clientId, 'test-nonce')
  assert.equal(validIdentity.sub, 'verified-subject')
  for (const options of [
    { nonce: 'wrong-nonce' },
    { nonce: 'test-nonce', issuer: 'https://attacker.invalid' },
    { nonce: 'test-nonce', audience: 'another-client' },
    { nonce: 'test-nonce', expires: Math.floor(now / 1000) - 60 },
    { nonce: 'test-nonce', badSignature: true },
    { nonce: 'test-nonce', subject: '' },
  ]) {
    await assert.rejects(
      auth.verifyIdentity(await idToken(options), clientId, 'test-nonce'),
      hasCode('identity_invalid')
    )
  }
})

test('credential file is atomically replaced with 0600 and directory stays 0700', async (t) => {
  const directory = await tempDirectory(t)
  const store = await save(directory, state())
  const directoryInfo = await stat(directory)
  const originalInfo = await stat(store.filename)
  assert.equal(directoryInfo.mode & 0o777, 0o700)
  assert.equal(originalInfo.mode & 0o777, 0o600)
  const replacement = state()
  replacement.connection!.tokens!.accessToken = 'fake-replacement'
  await store.withLock(() => store.write(replacement))
  const saved = await store.read()
  const replacementInfo = await stat(store.filename)
  assert.equal(saved?.connection?.tokens?.accessToken, 'fake-replacement')
  assert.equal(replacementInfo.mode & 0o777, 0o600)
})

test('unsafe modes and symlink credential files are rejected without reading token contents', async (t) => {
  const directory = await tempDirectory(t)
  const store = await save(directory, state())
  await chmod(store.filename, 0o644)
  await assert.rejects(store.read(), hasCode('unsafe_storage'))
  await chmod(store.filename, 0o600)
  const target = join(directory, 'other.json')
  await rm(store.filename)
  await symlink(target, store.filename)
  await assert.rejects(store.read(), hasCode('invalid_storage'))
  await chmod(directory, 0o755)
  await assert.rejects(store.read(), hasCode('unsafe_storage'))
})

test('active tokens are bound to the exact Kanwas owner on every call', async (t) => {
  const directory = await tempDirectory(t)
  await save(directory, state())
  let calls = 0
  const auth = new ChatGPTPlanAuth({
    directory,
    fetchImpl: (async () => {
      calls++
      throw new Error('Do not call network')
    }) as typeof fetch,
    now: () => now,
  })
  assert.equal(await auth.getAccessToken(userId), 'fake-access-old')
  await assert.rejects(auth.getAccessToken('different-user'), hasCode('wrong_user'))
  await assert.rejects(auth.getAccessToken(''), hasCode('invalid_user'))
  assert.equal(calls, 0)
  const status = await auth.getConnectionStatus(userId)
  assert.equal(status.email, 'test@example.invalid')
  assert.equal(JSON.stringify(status).includes('fake-'), false)
})

test('plan scope is required and a disabled grant never reaches inference or refresh', async (t) => {
  const directory = await tempDirectory(t)
  const value = state()
  value.connection!.tokens!.scopes = ['openid', 'email']
  await save(directory, value)
  const auth = new ChatGPTPlanAuth({ directory, fetchImpl: authFetch(), now: () => now })
  await assert.rejects(auth.getAccessToken(userId), hasCode('plan_permission_missing'))
  const status = await auth.getConnectionStatus()
  assert.equal(status.planUsageEnabled, false)
})

test('simultaneous client instances serialize rotating refresh and persist replacements together', async (t) => {
  const directory = await tempDirectory(t)
  const value = state()
  value.connection!.tokens!.expiresAt = now + 1000
  const store = await save(directory, value)
  let refreshes = 0
  const fetchImpl = authFetch(async (init) => {
    refreshes++
    const form = init!.body as URLSearchParams
    assert.equal(form.get('grant_type'), 'refresh_token')
    assert.equal(form.get('client_id'), clientId)
    assert.equal(form.get('refresh_token'), 'fake-refresh-old')
    assert.equal(form.get('resource'), OPENAI_RESOURCE)
    assert.equal(form.has('scope'), false)
    await delay(75)
    return responseJson(refreshedTokens())
  })
  const clients = [
    new ChatGPTPlanAuth({ directory, fetchImpl, now: () => now }),
    new ChatGPTPlanAuth({ directory, fetchImpl, now: () => now }),
  ]
  assert.deepEqual(await Promise.all(clients.map((auth) => auth.getAccessToken(userId))), [
    'fake-access-new',
    'fake-access-new',
  ])
  assert.equal(refreshes, 1)
  const tokens = (await store.read())!.connection!.tokens!
  assert.equal(tokens.refreshToken, 'fake-refresh-new')
  assert.equal(tokens.accessToken, 'fake-access-new')
  assert.equal(tokens.expiresAt, now + 3600_000)
})

test('separate OS processes cannot race the same rotating refresh token', async (t) => {
  const directory = await tempDirectory(t)
  const value = state()
  value.connection!.tokens!.expiresAt = now - 1000
  await save(directory, value)
  const trace = join(directory, 'refresh-count.txt')
  const authModule = new URL('../../libs/chatgpt-plan-auth/index.ts', import.meta.url).href
  const childCode = `
    import { ChatGPTPlanAuth } from ${JSON.stringify(authModule)};
    import { appendFile } from 'node:fs/promises';
    const auth = new ChatGPTPlanAuth({
      directory: ${JSON.stringify(directory)},
      fetchImpl: async () => {
        await appendFile(${JSON.stringify(trace)}, 'refresh\\n');
        await new Promise(resolve => setTimeout(resolve, 100));
        return Response.json(${JSON.stringify(refreshedTokens())});
      }
    });
    if (await auth.getAccessToken(${JSON.stringify(userId)}) !== 'fake-access-new') process.exitCode = 1;
  `
  const runChild = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode], {
        stdio: 'ignore',
      })
      child.once('error', reject)
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('Offline child failed'))))
    })
  await Promise.all([runChild(), runChild()])
  assert.equal(await readFile(trace, 'utf8'), 'refresh\n')
})

test('lock recovery rejects live and unknown owners, then recovers a stopped process without age expiry', async (t) => {
  const directory = await tempDirectory(t)
  const store = await save(directory, state())
  await store.withLock(async () => {
    await assert.rejects(store.recoverLock(), hasCode('busy'))
  })
  const lockDirectory = join(directory, 'session.lock')
  await mkdir(lockDirectory, { mode: 0o700 })
  await assert.rejects(store.recoverLock(), hasCode('busy'))
  const deadPid = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', 'process.exit(0)'], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', () => resolve(child.pid!))
  })
  await writeFile(
    join(lockDirectory, 'owner.json'),
    JSON.stringify({ pid: deadPid, nonce: '849029a0-8fb3-49c3-af2a-dfe21a94788b' }),
    { mode: 0o600 }
  )
  assert.deepEqual(await store.recoverLock(), { recovered: true })
  assert.equal(await store.withLock(async () => 'unblocked'), 'unblocked')
  assert.deepEqual(await store.recoverLock(), { recovered: false })
})

test('successful refresh with malformed credentials clears consumed tokens and requires new sign-in', async (t) => {
  for (const malformed of [
    new Response('not-json'),
    responseJson({ ...refreshedTokens(), refresh_token: undefined }),
  ]) {
    const directory = await tempDirectory(t)
    const value = state()
    value.connection!.tokens!.expiresAt = now - 1000
    const store = await save(directory, value)
    const auth = new ChatGPTPlanAuth({ directory, fetchImpl: authFetch(async () => malformed), now: () => now })
    await assert.rejects(auth.getAccessToken(userId), hasCode('refresh_unusable'))
    const saved = await store.read()
    assert.equal(saved!.connection!.tokens, undefined)
    assert.equal(saved!.connection!.clientId, clientId)
  }
})

test('terminal refresh errors clear only tokens, keeping identity/client/host mapping for reauthorization', async (t) => {
  const directory = await tempDirectory(t)
  const value = state()
  value.connection!.tokens!.expiresAt = now - 1000
  const store = await save(directory, value)
  const auth = new ChatGPTPlanAuth({
    directory,
    fetchImpl: authFetch(async () => responseJson({ error: 'invalid_grant' }, 400)),
    now: () => now,
  })
  await assert.rejects(auth.getAccessToken(userId), hasCode('refresh_unusable'))
  const saved = (await store.read())!
  assert.equal(saved.connection!.tokens, undefined)
  assert.equal(saved.connection!.clientId, clientId)
  assert.equal(saved.connection!.subject, value.connection!.subject)
  assert.equal(saved.extAgentHostId, value.extAgentHostId)
})

test('temporary refresh failure preserves credentials and never prints provider secrets', async (t) => {
  const directory = await tempDirectory(t)
  const value = state()
  value.connection!.tokens!.expiresAt = now - 1000
  const store = await save(directory, value)
  const auth = new ChatGPTPlanAuth({
    directory,
    fetchImpl: authFetch(async () =>
      responseJson({ error: 'server_error', error_description: 'fake-secret-access' }, 503)
    ),
    now: () => now,
  })
  await assert.rejects(auth.getAccessToken(userId), (error: unknown) => {
    assert.equal(String(error).includes('fake-secret'), false)
    return hasCode('token_exchange_failed')(error)
  })
  assert.deepEqual(await store.read(), value)
})

test('renewal cannot replace a connection with a different signed subject', async (t) => {
  const directory = await tempDirectory(t)
  const value = state()
  value.connection!.tokens!.expiresAt = now - 1000
  const store = await save(directory, value)
  const jwt = await idToken({ subject: 'different-subject' })
  const auth = new ChatGPTPlanAuth({
    directory,
    fetchImpl: authFetch(async () => responseJson({ ...refreshedTokens(), id_token: jwt })),
    now: () => now,
  })
  await assert.rejects(auth.getAccessToken(userId), hasCode('refresh_unusable'))
  const saved = await store.read()
  assert.equal(saved!.connection!.tokens, undefined)
  assert.equal(saved!.connection!.subject, value.connection!.subject)
  assert.equal(saved!.connection!.clientId, clientId)
})

test('disconnect revokes refresh session then retains mapping without any access/refresh/ID tokens', async (t) => {
  const directory = await tempDirectory(t)
  const store = await save(directory, state())
  let revocations = 0
  const baseFetch = authFetch()
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/revoke')) {
      revocations++
      const form = init!.body as URLSearchParams
      assert.equal(form.get('token'), 'fake-refresh-old')
      assert.equal(form.get('token_type_hint'), 'refresh_token')
      assert.equal(form.get('client_id'), clientId)
      return new Response(null, { status: 200 })
    }
    return baseFetch(input, init)
  }) as typeof fetch
  const auth = new ChatGPTPlanAuth({ directory, fetchImpl })
  const result = await auth.disconnect(userId)
  assert.equal(result.remoteRevocationConfirmed, true)
  assert.equal(revocations, 1)
  const contents = await readFile(store.filename, 'utf8')
  assert.equal(contents.includes('fake-'), false)
  assert.equal((await store.read())!.connection!.clientId, clientId)
  await assert.rejects(auth.getAccessToken(userId), hasCode('not_connected'))
})

test('failed remote revocation still clears local credentials and reports unconfirmed revocation', async (t) => {
  const directory = await tempDirectory(t)
  const store = await save(directory, state())
  const auth = new ChatGPTPlanAuth({
    directory,
    fetchImpl: (async () => {
      throw new Error('fake-provider-secret')
    }) as typeof fetch,
  })
  const result = await auth.disconnect(userId)
  assert.equal(result.remoteRevocationConfirmed, false)
  assert.equal((await store.read())!.connection!.tokens, undefined)
})

test('loopback listener binds 127.0.0.1, requires Host, and returns only a verified callback', async () => {
  const loopback = await startLoopbackAttempt()
  try {
    const callback = new URL(loopback.transaction.redirectUri)
    assert.equal(callback.hostname, '127.0.0.1')
    callback.search = new URLSearchParams({
      code: 'fake-code',
      state: loopback.transaction.state,
      client_id: clientId,
    }).toString()
    const response = await fetch(callback)
    const result = await loopback.result
    assert.equal(response.status, 200)
    assert.equal(result.clientId, clientId)
  } finally {
    await loopback.close()
  }
})

test('end-to-end offline sign-in validates fresh identity and stores explicit Kanwas owner', async (t) => {
  const directory = await tempDirectory(t)
  let expectedNonce = ''
  let expectedRedirect = ''
  const fetchImpl = authFetch(async (init) => {
    const body = init!.body as URLSearchParams
    assert.equal(body.get('client_id'), clientId)
    assert.equal(body.get('redirect_uri'), expectedRedirect)
    assert.equal(body.get('resource'), OPENAI_RESOURCE)
    assert.equal(body.get('code_verifier')!.length > 43, true)
    return responseJson({ ...refreshedTokens(), id_token: await idToken({ nonce: expectedNonce }) })
  })
  const auth = new ChatGPTPlanAuth({ directory, fetchImpl, now: () => now })
  const status = await auth.signIn(userId, async (url) => {
    const authorize = new URL(url)
    assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client')
    const persisted = await auth.store.read()
    assert.equal(authorize.searchParams.get('ext_agent_host_id'), persisted!.extAgentHostId)
    expectedNonce = authorize.searchParams.get('nonce')!
    expectedRedirect = authorize.searchParams.get('redirect_uri')!
    const callback = new URL(expectedRedirect)
    callback.search = new URLSearchParams({
      state: authorize.searchParams.get('state')!,
      code: 'fake-code',
      client_id: clientId,
    }).toString()
    await fetch(callback)
  })
  assert.equal(status.kanwasUserId, userId)
  assert.equal(status.planUsageEnabled, true)
  assert.equal((await auth.store.read())!.connection!.subject, 'verified-subject')
})

test('returning sign-in reuses registration/host and rejects switched account before saving tokens', async (t) => {
  const directory = await tempDirectory(t)
  const value = state()
  const store = await save(directory, value)
  let nonce = ''
  const auth = new ChatGPTPlanAuth({
    directory,
    now: () => now,
    fetchImpl: authFetch(async () =>
      responseJson({ ...refreshedTokens(), id_token: await idToken({ nonce, subject: 'new-subject' }) })
    ),
  })
  await assert.rejects(
    auth.signIn(userId, async (url) => {
      const authorize = new URL(url)
      assert.equal(authorize.searchParams.get('client_id'), clientId)
      assert.equal(authorize.searchParams.get('ext_agent_host_id'), value.extAgentHostId)
      assert.equal(authorize.searchParams.has('agent_name_hint'), false)
      nonce = authorize.searchParams.get('nonce')!
      const callback = new URL(authorize.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({
        state: authorize.searchParams.get('state')!,
        code: 'fake-code',
      }).toString()
      await fetch(callback)
    }),
    hasCode('identity_changed')
  )
  assert.deepEqual(await store.read(), value)
})
