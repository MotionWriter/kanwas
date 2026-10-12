import { randomUUID } from 'node:crypto'
import { createLocalJWKSet, jwtVerify } from 'jose'
import type { JSONWebKeySet, JWTPayload } from 'jose'
import { setTimeout as delay } from 'node:timers/promises'
import { CredentialStore, defaultCredentialDirectory } from './store.js'
import { authorizationUrl, startLoopbackAttempt } from './oauth.js'
import {
  ChatGPTPlanAuthError,
  OPENAI_ISSUER,
  OPENAI_RESOURCE,
  OPENAI_TOKEN_ENDPOINT,
  PLAN_SCOPE,
  connectionStatus,
  validateKanwasUserId,
} from './types.js'
import type { AccountConnection, ConnectionStatus, CredentialState, SavedTokens } from './types.js'

export { ChatGPTPlanAuthError, defaultCredentialDirectory }
export type { ConnectionStatus }

type Fetch = typeof fetch
interface Discovery {
  issuer: string
  jwks_uri: string
  revocation_endpoint?: string
}

interface ClientOptions {
  directory?: string
  fetchImpl?: Fetch
  now?: () => number
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function safeOpenAIEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.origin === OPENAI_ISSUER && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function boundConnection(state: CredentialState | undefined, userId: string): AccountConnection {
  validateKanwasUserId(userId)
  if (!state?.connection)
    throw new ChatGPTPlanAuthError('not_connected', 'Sign in with ChatGPT for this Kanwas user first.')
  if (state.connection.kanwasUserId !== userId) {
    throw new ChatGPTPlanAuthError('wrong_user', 'This local ChatGPT session belongs to a different Kanwas user.')
  }
  return state.connection
}

const UNUSABLE_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

/** Fresh Kanwas OAuth credentials only: no API-key fallback and no access to Codex auth files. */
export class ChatGPTPlanAuth {
  readonly store: CredentialStore
  private readonly fetchImpl: Fetch
  private readonly now: () => number
  private discovery?: Discovery
  private jwks?: ReturnType<typeof createLocalJWKSet>
  private jwksSavedAt = 0

  constructor(options: ClientOptions = {}) {
    this.store = new CredentialStore(options.directory)
    this.fetchImpl = options.fetchImpl || fetch
    this.now = options.now || Date.now
  }

  private async request(url: string, options: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    } catch {
      throw new ChatGPTPlanAuthError(
        'network_error',
        'Could not reach OpenAI. Credentials were preserved; retry later.'
      )
    }
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    try {
      const value: unknown = await response.json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value as Record<string, unknown>
    } catch {
      throw new ChatGPTPlanAuthError('invalid_response', 'OpenAI returned an invalid authorization response.')
    }
  }

  private async getDiscovery(): Promise<Discovery> {
    if (this.discovery) return this.discovery
    const response = await this.request(`${OPENAI_ISSUER}/.well-known/openid-configuration`)
    if (!response.ok)
      throw new ChatGPTPlanAuthError('invalid_response', 'Could not retrieve OpenAI sign-in configuration.')
    const metadata = await this.json(response)
    if (metadata.issuer !== OPENAI_ISSUER || !safeOpenAIEndpoint(metadata.jwks_uri)) {
      throw new ChatGPTPlanAuthError(
        'identity_invalid',
        'OpenAI sign-in configuration did not match the expected issuer.'
      )
    }
    if (metadata.revocation_endpoint !== undefined && !safeOpenAIEndpoint(metadata.revocation_endpoint)) {
      throw new ChatGPTPlanAuthError('identity_invalid', 'OpenAI session revocation configuration was invalid.')
    }
    this.discovery = metadata as unknown as Discovery
    return this.discovery
  }

  private async getJwks(force = false): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (this.jwks && !force && this.now() - this.jwksSavedAt < 5 * 60_000) return this.jwks
    const metadata = await this.getDiscovery()
    const response = await this.request(metadata.jwks_uri)
    if (!response.ok)
      throw new ChatGPTPlanAuthError('identity_invalid', 'Could not retrieve OpenAI identity verification keys.')
    const keys = await this.json(response)
    if (!Array.isArray(keys.keys))
      throw new ChatGPTPlanAuthError('identity_invalid', 'OpenAI identity verification keys were invalid.')
    this.jwks = createLocalJWKSet(keys as unknown as JSONWebKeySet)
    this.jwksSavedAt = this.now()
    return this.jwks
  }

  /** Signed identity is verified before it can replace the selected account's credentials. */
  async verifyIdentity(idToken: string, clientId: string, expectedNonce?: string): Promise<JWTPayload> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const keys = await this.getJwks(attempt > 0)
      try {
        const { payload } = await jwtVerify(idToken, keys, {
          issuer: OPENAI_ISSUER,
          audience: clientId,
          requiredClaims: ['sub', 'exp', 'iat'],
          algorithms: ['RS256', 'ES256'],
          clockTolerance: 5,
          currentDate: new Date(this.now()),
        })
        if (!nonempty(payload.sub) || (expectedNonce !== undefined && payload.nonce !== expectedNonce))
          throw new Error()
        return payload
      } catch (error) {
        // Rotate the trusted JWKS once when an unfamiliar kid appears; never trust token-provided keys.
        if (
          attempt === 0 &&
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ERR_JWKS_NO_MATCHING_KEY'
        )
          continue
        throw new ChatGPTPlanAuthError(
          'identity_invalid',
          'The ChatGPT account identity could not be verified. Start a new sign-in.'
        )
      }
    }
    throw new ChatGPTPlanAuthError('identity_invalid', 'The ChatGPT identity verification keys did not match.')
  }

  private parseTokens(value: Record<string, unknown>, previous?: SavedTokens): SavedTokens {
    const expiresIn = value.expires_in
    const scope = value.scope
    if (
      !nonempty(value.access_token) ||
      value.token_type !== 'Bearer' ||
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0 ||
      typeof scope !== 'string' ||
      (value.refresh_token !== undefined && !nonempty(value.refresh_token)) ||
      (value.id_token !== undefined && !nonempty(value.id_token)) ||
      // OpenAI rotates refresh tokens; do not keep using a token after a malformed refresh response.
      (previous !== undefined && !nonempty(value.refresh_token))
    )
      throw new ChatGPTPlanAuthError(
        'invalid_response',
        'OpenAI returned an incomplete credential set. Sign in again if renewal fails.'
      )
    const earliest = value.earliest_refresh_at
    let earliestRefreshAt: number | undefined
    if (typeof earliest === 'number' && Number.isFinite(earliest)) {
      earliestRefreshAt = earliest < 1e12 ? earliest * 1000 : earliest
    } else if (typeof earliest === 'string' && Number.isFinite(Date.parse(earliest))) {
      earliestRefreshAt = Date.parse(earliest)
    }
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token as string | undefined,
      idToken: (value.id_token as string | undefined) || previous?.idToken,
      tokenType: 'Bearer',
      scopes: [...new Set(scope.split(/\s+/).filter(Boolean))],
      expiresAt: this.now() + expiresIn * 1000,
      earliestRefreshAt,
      savedAt: new Date(this.now()).toISOString(),
    }
  }

  private async exchange(
    body: URLSearchParams,
    isRefresh: boolean,
    onIssued?: () => void
  ): Promise<Record<string, unknown>> {
    const response = await this.request(OPENAI_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    // A successful refresh may already consume the old token, even when its body is malformed.
    if (response.ok) onIssued?.()
    const value = await this.json(response)
    if (!response.ok) {
      if (isRefresh && typeof value.error === 'string' && UNUSABLE_REFRESH_ERRORS.has(value.error)) {
        throw new ChatGPTPlanAuthError(
          'refresh_unusable',
          'This ChatGPT session can no longer be renewed. Sign in again.'
        )
      }
      if (!isRefresh && value.error === 'invalid_grant') {
        throw new ChatGPTPlanAuthError(
          'invalid_grant',
          'The sign-in code expired or was already used. Start a fresh authorization.'
        )
      }
      // Never include error_description, body, or arbitrary provider strings in errors/logs.
      throw new ChatGPTPlanAuthError(
        'token_exchange_failed',
        `OpenAI authorization failed (HTTP ${response.status}). Credentials were preserved.`
      )
    }
    return value
  }

  async signIn(kanwasUserId: string, openAuthorizationUrl: (url: string) => Promise<void>): Promise<ConnectionStatus> {
    validateKanwasUserId(kanwasUserId)
    return this.store.withLock(async () => {
      let state = await this.store.read()
      if (!state) {
        state = { version: 1, extAgentHostId: `urn:uuid:${randomUUID()}` }
        // Persist host identity before initiating the first browser authorization.
        await this.store.write(state)
      }
      if (state.connection) boundConnection(state, kanwasUserId)
      let pendingClientId = state.connection?.clientId
      for (let attempt = 0; attempt < 2; attempt++) {
        const loopback = await startLoopbackAttempt(pendingClientId)
        try {
          await openAuthorizationUrl(authorizationUrl(loopback.transaction, state.extAgentHostId))
          const callback = await loopback.result
          pendingClientId = callback.clientId
          const value = await this.exchange(
            new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: callback.clientId,
              code: callback.code,
              code_verifier: loopback.transaction.codeVerifier,
              redirect_uri: loopback.transaction.redirectUri,
              resource: OPENAI_RESOURCE,
            }),
            false
          )
          if (!nonempty(value.id_token))
            throw new ChatGPTPlanAuthError(
              'identity_invalid',
              'OpenAI did not return a ChatGPT account identity token.'
            )
          const identity = await this.verifyIdentity(value.id_token, callback.clientId, loopback.transaction.nonce)
          if (state.connection && identity.sub !== state.connection.subject) {
            throw new ChatGPTPlanAuthError(
              'identity_changed',
              'The selected ChatGPT account does not match this saved Kanwas connection.'
            )
          }
          const connection: AccountConnection = {
            kanwasUserId,
            issuer: OPENAI_ISSUER,
            subject: identity.sub!,
            clientId: callback.clientId,
            email: typeof identity.email === 'string' ? identity.email : undefined,
            tokens: this.parseTokens(value),
          }
          await this.store.write({ ...state, connection })
          return connectionStatus(connection)
        } catch (error) {
          // A fresh code may be needed; keep the just-issued client for this attempt to avoid duplicate registration.
          if (attempt === 0 && error instanceof ChatGPTPlanAuthError && error.code === 'invalid_grant') continue
          throw error
        } finally {
          await loopback.close()
        }
      }
      throw new ChatGPTPlanAuthError(
        'invalid_grant',
        'ChatGPT authorization could not be completed. Start sign-in again.'
      )
    })
  }

  async getConnectionStatus(kanwasUserId?: string): Promise<ConnectionStatus> {
    const state = await this.store.read()
    if (kanwasUserId !== undefined) {
      validateKanwasUserId(kanwasUserId)
      if (state?.connection) boundConnection(state, kanwasUserId)
    }
    return connectionStatus(state?.connection)
  }

  /** Explicit local-test transition; the same registration, account, and rotating token record are retained. */
  async adoptLocalTrialOwner(kanwasUserId: string): Promise<ConnectionStatus> {
    if (process.env.NODE_ENV !== 'development' || process.env.KANWAS_LOCAL_TRIAL !== 'true') {
      throw new ChatGPTPlanAuthError(
        'local_trial_disabled',
        'Local trial owner adoption requires development mode and KANWAS_LOCAL_TRIAL=true.'
      )
    }
    if (
      typeof kanwasUserId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(kanwasUserId)
    ) {
      throw new ChatGPTPlanAuthError('invalid_user', 'Supply the generated local trial user UUID.')
    }
    if (process.env.KANWAS_LOCAL_TRIAL_USER_ID !== kanwasUserId) {
      throw new ChatGPTPlanAuthError('wrong_user', 'The adoption target must match the generated local trial identity.')
    }
    return this.store.withLock(async () => {
      const state = await this.store.read()
      const connection = state?.connection
      if (!connection?.tokens) {
        throw new ChatGPTPlanAuthError('not_connected', 'Complete the isolated local ChatGPT sign-in test first.')
      }
      if (connection.kanwasUserId !== 'local-signin-test' && connection.kanwasUserId !== kanwasUserId) {
        throw new ChatGPTPlanAuthError(
          'wrong_user',
          'Only the isolated sign-in test or this same local trial owner can be adopted.'
        )
      }
      if (!connection.tokens.scopes.includes(PLAN_SCOPE)) {
        throw new ChatGPTPlanAuthError(
          'plan_permission_missing',
          'The isolated ChatGPT connection has no permission to use your plan.'
        )
      }
      if (connection.kanwasUserId !== kanwasUserId) {
        connection.kanwasUserId = kanwasUserId
        await this.store.write(state!)
      }
      return connectionStatus(connection)
    })
  }

  async getAccessToken(kanwasUserId: string): Promise<string> {
    validateKanwasUserId(kanwasUserId)
    return this.store.withLock(async () => {
      const state = await this.store.read()
      const connection = boundConnection(state, kanwasUserId)
      const tokens = connection.tokens
      if (!tokens) throw new ChatGPTPlanAuthError('not_connected', 'This ChatGPT account is signed out. Sign in again.')
      if (!tokens.scopes.includes(PLAN_SCOPE)) {
        throw new ChatGPTPlanAuthError(
          'plan_permission_missing',
          'This ChatGPT connection has no permission to use your plan. Enable it through sign-in.'
        )
      }
      if (tokens.expiresAt - this.now() > 60_000) return tokens.accessToken
      if (tokens.earliestRefreshAt && this.now() < tokens.earliestRefreshAt) {
        if (tokens.expiresAt > this.now()) return tokens.accessToken
        throw new ChatGPTPlanAuthError(
          'refresh_too_early',
          'OpenAI has not yet allowed this session to renew. Retry later.'
        )
      }
      if (!tokens.refreshToken)
        throw new ChatGPTPlanAuthError('not_connected', 'This ChatGPT session cannot renew. Sign in again.')
      let tokenSetReplaced = false
      try {
        const value = await this.exchange(
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: connection.clientId,
            refresh_token: tokens.refreshToken,
            resource: OPENAI_RESOURCE,
          }),
          true,
          () => {
            tokenSetReplaced = true
          }
        )
        if (nonempty(value.id_token)) {
          const identity = await this.verifyIdentity(value.id_token, connection.clientId)
          if (identity.sub !== connection.subject)
            throw new ChatGPTPlanAuthError('identity_changed', 'ChatGPT renewal returned a different account identity.')
        }
        connection.tokens = this.parseTokens(value, tokens)
        await this.store.write(state!)
      } catch (error) {
        if (tokenSetReplaced || (error instanceof ChatGPTPlanAuthError && error.code === 'refresh_unusable')) {
          delete connection.tokens
          await this.store.write(state!)
          if (tokenSetReplaced) {
            throw new ChatGPTPlanAuthError(
              'refresh_unusable',
              'ChatGPT renewed the session but the new credentials could not be validated or saved. Sign in again.'
            )
          }
        }
        throw error
      }
      if (!connection.tokens!.scopes.includes(PLAN_SCOPE)) {
        throw new ChatGPTPlanAuthError(
          'plan_permission_missing',
          'OpenAI no longer grants permission to use this ChatGPT plan. Sign in again.'
        )
      }
      return connection.tokens!.accessToken
    })
  }

  async disconnect(kanwasUserId: string): Promise<{ remoteRevocationConfirmed: boolean; status: ConnectionStatus }> {
    validateKanwasUserId(kanwasUserId)
    return this.store.withLock(async () => {
      const state = await this.store.read()
      const connection = boundConnection(state, kanwasUserId)
      let remoteRevocationConfirmed = false
      if (connection.tokens?.refreshToken) {
        // Retry transient network/5xx failures once, then always remove local tokens.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const discovery = await this.getDiscovery()
            if (!discovery.revocation_endpoint) break
            const response = await this.request(discovery.revocation_endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token: connection.tokens.refreshToken,
                token_type_hint: 'refresh_token',
                client_id: connection.clientId,
              }),
            })
            if (response.status === 200) {
              remoteRevocationConfirmed = true
              break
            }
            if (response.status < 500) break
          } catch {
            // Token-bearing request failures must not appear in diagnostics.
          }
          if (attempt === 0) await delay(250)
        }
      }
      delete connection.tokens
      await this.store.write(state!)
      return { remoteRevocationConfirmed, status: connectionStatus(connection) }
    })
  }
}

let defaultClient: ChatGPTPlanAuth | undefined
function client(): ChatGPTPlanAuth {
  defaultClient ??= new ChatGPTPlanAuth()
  return defaultClient
}

export function getAccessToken(kanwasUserId: string): Promise<string> {
  return client().getAccessToken(kanwasUserId)
}

export function getConnectionStatus(kanwasUserId?: string): Promise<ConnectionStatus> {
  return client().getConnectionStatus(kanwasUserId)
}
