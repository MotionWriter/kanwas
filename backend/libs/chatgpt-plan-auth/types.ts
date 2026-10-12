export const OPENAI_ISSUER = 'https://auth.openai.com'
export const OPENAI_RESOURCE = 'https://api.openai.com/v1'
export const OPENAI_AUTHORIZE_ENDPOINT = `${OPENAI_ISSUER}/api/accounts/authorize`
export const OPENAI_TOKEN_ENDPOINT = `${OPENAI_ISSUER}/api/accounts/oauth/token`
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const REQUESTED_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE]

export type AuthErrorCode =
  | 'invalid_user'
  | 'local_trial_disabled'
  | 'unsafe_storage'
  | 'invalid_storage'
  | 'busy'
  | 'not_connected'
  | 'wrong_user'
  | 'plan_permission_missing'
  | 'invalid_callback'
  | 'sign_in_declined'
  | 'sign_in_timeout'
  | 'identity_invalid'
  | 'identity_changed'
  | 'network_error'
  | 'invalid_response'
  | 'invalid_grant'
  | 'refresh_unusable'
  | 'refresh_too_early'
  | 'token_exchange_failed'

/** Messages are safe for logs: never attach provider bodies, tokens, codes, or callback URLs. */
export class ChatGPTPlanAuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChatGPTPlanAuthError'
  }
}

export interface SavedTokens {
  accessToken: string
  refreshToken?: string
  idToken?: string
  tokenType: 'Bearer'
  scopes: string[]
  expiresAt: number
  earliestRefreshAt?: number
  savedAt: string
}

export interface AccountConnection {
  /** Explicit local-owner binding, independent of the ChatGPT email. */
  kanwasUserId: string
  issuer: typeof OPENAI_ISSUER
  subject: string
  clientId: string
  email?: string
  tokens?: SavedTokens
}

export interface CredentialState {
  version: 1
  extAgentHostId: string
  connection?: AccountConnection
}

/** Safe metadata only. No token is returned to settings, CLI output, or browser storage. */
export interface ConnectionStatus {
  registered: boolean
  connected: boolean
  planUsageEnabled: boolean
  kanwasUserId?: string
  email?: string
  expiresAt?: string
}

export function validateKanwasUserId(userId: string): void {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    throw new ChatGPTPlanAuthError(
      'invalid_user',
      'Supply the explicit Kanwas user ID (letters, numbers, hyphens, or underscores).'
    )
  }
}

export function connectionStatus(connection?: AccountConnection): ConnectionStatus {
  return {
    registered: Boolean(connection),
    connected: Boolean(connection?.tokens),
    planUsageEnabled: Boolean(connection?.tokens?.scopes.includes(PLAN_SCOPE)),
    kanwasUserId: connection?.kanwasUserId,
    email: connection?.email,
    expiresAt: connection?.tokens ? new Date(connection.tokens.expiresAt).toISOString() : undefined,
  }
}
