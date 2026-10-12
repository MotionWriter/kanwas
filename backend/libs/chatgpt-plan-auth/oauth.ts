import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { ChatGPTPlanAuthError, OPENAI_AUTHORIZE_ENDPOINT, OPENAI_RESOURCE, REQUESTED_SCOPES } from './types.js'

export interface SignInTransaction {
  state: string
  nonce: string
  codeVerifier: string
  redirectUri: string
  clientId: string
  expiresAt: number
  consumed: boolean
}

export interface VerifiedCallback {
  code: string
  clientId: string
}

export function createSignInTransaction(redirectUri: string, clientId = 'dynamic_agent_client'): SignInTransaction {
  const redirect = new URL(redirectUri)
  if (
    redirect.protocol !== 'http:' ||
    redirect.hostname !== '127.0.0.1' ||
    redirect.pathname !== '/auth/callback' ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  ) {
    throw new ChatGPTPlanAuthError(
      'invalid_callback',
      'ChatGPT sign-in requires the 127.0.0.1 /auth/callback loopback address.'
    )
  }
  return {
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    codeVerifier: randomBytes(64).toString('base64url'),
    redirectUri,
    clientId,
    expiresAt: Date.now() + 5 * 60_000,
    consumed: false,
  }
}

export function authorizationUrl(transaction: SignInTransaction, extAgentHostId: string): string {
  const url = new URL(OPENAI_AUTHORIZE_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: transaction.clientId,
    ext_agent_host_id: extAgentHostId,
    response_type: 'code',
    redirect_uri: transaction.redirectUri,
    scope: REQUESTED_SCOPES.join(' '),
    resource: OPENAI_RESOURCE,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(transaction.codeVerifier).digest('base64url'),
  }).toString()
  if (transaction.clientId === 'dynamic_agent_client') url.searchParams.set('agent_name_hint', 'Kanwas')
  // A retained ID token is intentionally not put into CLI/browser URLs or diagnostics.
  // Reauthorization without id_token_hint is supported and lets the user select the saved account.
  return url.toString()
}

function equalState(actual: string | null, expected: string): boolean {
  if (!actual) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

/** Consume once even when invalid, and never redeem a code from an unverified callback. */
export function consumeCallback(transaction: SignInTransaction, callbackUrl: string): VerifiedCallback {
  const wasConsumed = transaction.consumed
  transaction.consumed = true
  const url = new URL(callbackUrl)
  const expected = new URL(transaction.redirectUri)
  if (
    wasConsumed ||
    transaction.expiresAt <= Date.now() ||
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.searchParams.getAll('state').length !== 1 ||
    !equalState(url.searchParams.get('state'), transaction.state)
  )
    throw new ChatGPTPlanAuthError(
      'invalid_callback',
      'The ChatGPT sign-in callback could not be verified. Start a new sign-in.'
    )
  if (url.searchParams.has('error')) {
    throw new ChatGPTPlanAuthError('sign_in_declined', 'ChatGPT sign-in was declined or could not be completed.')
  }
  const code = url.searchParams.get('code')
  const returnedClient = url.searchParams.get('client_id')
  const clientId = returnedClient || transaction.clientId
  if (
    !code ||
    url.searchParams.getAll('code').length !== 1 ||
    url.searchParams.getAll('client_id').length > 1 ||
    clientId === 'dynamic_agent_client' ||
    (transaction.clientId !== 'dynamic_agent_client' && clientId !== transaction.clientId) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(clientId)
  )
    throw new ChatGPTPlanAuthError(
      'invalid_callback',
      'The ChatGPT sign-in callback has no valid issued client registration.'
    )
  return { code, clientId }
}

export interface LoopbackAttempt {
  transaction: SignInTransaction
  result: Promise<VerifiedCallback>
  close: () => Promise<void>
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/** Listener is started before authorization; never listens on localhost, LAN, or all interfaces. */
export async function startLoopbackAttempt(clientId?: string, timeoutMs = 5 * 60_000): Promise<LoopbackAttempt> {
  let transaction: SignInTransaction
  let resolveResult: (value: VerifiedCallback) => void
  let rejectResult: (error: ChatGPTPlanAuthError) => void
  const result = new Promise<VerifiedCallback>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // Handler is installed immediately; a caller opening the browser can fail before awaiting result.
  void result.catch(() => {})
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    if (!transaction || request.method !== 'GET' || request.headers.host !== new URL(transaction.redirectUri).host) {
      response.writeHead(400).end('Invalid sign-in request.')
      return
    }
    let callback: URL
    try {
      callback = new URL(request.url || '', transaction.redirectUri)
    } catch {
      response.writeHead(400).end('Invalid sign-in request.')
      return
    }
    if (callback.pathname !== '/auth/callback') {
      response.writeHead(404).end('Not found.')
      return
    }
    try {
      const verified = consumeCallback(transaction, callback.toString())
      response
        .writeHead(200)
        .end('Callback received. Complete sign-in in the Kanwas terminal; you may close this window.')
      resolveResult(verified)
    } catch (error) {
      response.writeHead(400).end('Sign-in could not be verified. Return to the Kanwas terminal.')
      rejectResult(
        error instanceof ChatGPTPlanAuthError
          ? error
          : new ChatGPTPlanAuthError('invalid_callback', 'Invalid ChatGPT sign-in callback.')
      )
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', () =>
      reject(new ChatGPTPlanAuthError('invalid_callback', 'Could not start the local ChatGPT sign-in listener.'))
    )
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new ChatGPTPlanAuthError('invalid_callback', 'Could not determine the local sign-in callback address.')
  }
  transaction = createSignInTransaction(`http://127.0.0.1:${address.port}/auth/callback`, clientId)
  const timeout = setTimeout(() => {
    transaction.consumed = true
    rejectResult(new ChatGPTPlanAuthError('sign_in_timeout', 'ChatGPT sign-in timed out. Start a new sign-in.'))
    void closeServer(server)
  }, timeoutMs)
  return {
    transaction,
    result,
    close: async () => {
      clearTimeout(timeout)
      transaction.consumed = true
      await closeServer(server)
    },
  }
}
