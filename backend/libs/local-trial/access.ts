import { timingSafeEqual } from 'node:crypto'

export interface LocalTrialConfiguration {
  nodeEnv?: string
  enabled?: boolean
  userId?: string
  actorId?: string
  bootstrapSecret?: string
  sessionSecret?: string
}

export interface LocalTrialRequest {
  remoteAddress?: string
  host?: string
  origin?: string
  secret?: string
}

export interface LocalTrialIdentity {
  userId: string
  workspaceId: string
}

export class LocalTrialAccessError extends Error {
  constructor(
    public readonly status: 403 | 404 | 409,
    message: string
  ) {
    super(message)
    this.name = 'LocalTrialAccessError'
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const secretPattern = /^[0-9a-f]{64}$/
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const localHosts = new Set(['localhost:3333', '127.0.0.1:3333'])
const localOrigins = new Set(['http://localhost:15173', 'http://127.0.0.1:15173'])

/** Secrets and one-use state belong to one backend run, never a browser build. */
export class LocalTrialAccess {
  private bootstrapConsumed = false
  private sessionConsumed = false
  private identity: LocalTrialIdentity | null = null

  constructor(private readonly configuration: LocalTrialConfiguration) {}

  private authorize(request: LocalTrialRequest, expectedSecret: string | undefined): string {
    const configuration = this.configuration
    if (
      configuration.nodeEnv !== 'development' ||
      configuration.enabled !== true ||
      !configuration.userId ||
      !uuidPattern.test(configuration.userId) ||
      configuration.actorId !== configuration.userId ||
      !configuration.bootstrapSecret ||
      !secretPattern.test(configuration.bootstrapSecret) ||
      !configuration.sessionSecret ||
      !secretPattern.test(configuration.sessionSecret) ||
      configuration.bootstrapSecret === configuration.sessionSecret
    ) {
      throw new LocalTrialAccessError(404, 'Local trial access is unavailable.')
    }

    if (
      !request.remoteAddress ||
      !loopbackAddresses.has(request.remoteAddress) ||
      !request.host ||
      !localHosts.has(request.host) ||
      (request.origin !== undefined && !localOrigins.has(request.origin)) ||
      !request.secret ||
      !secretPattern.test(request.secret) ||
      !expectedSecret ||
      !timingSafeEqual(Buffer.from(request.secret, 'hex'), Buffer.from(expectedSecret, 'hex'))
    ) {
      throw new LocalTrialAccessError(403, 'Local trial access was refused.')
    }

    return configuration.userId
  }

  beginBootstrap(request: LocalTrialRequest): string {
    const userId = this.authorize(request, this.configuration.bootstrapSecret)
    if (this.bootstrapConsumed) {
      throw new LocalTrialAccessError(409, 'Local trial setup has already been used. Restart the launcher.')
    }
    // Consume synchronously before any database or Yjs work can yield.
    this.bootstrapConsumed = true
    return userId
  }

  completeBootstrap(identity: LocalTrialIdentity): void {
    if (!this.bootstrapConsumed || this.identity || identity.userId !== this.configuration.userId) {
      throw new LocalTrialAccessError(409, 'Local trial setup could not be completed.')
    }
    if (!uuidPattern.test(identity.workspaceId)) {
      throw new LocalTrialAccessError(409, 'Local trial setup could not be completed.')
    }
    this.identity = { ...identity }
  }

  beginSession(request: LocalTrialRequest): LocalTrialIdentity {
    this.authorize(request, this.configuration.sessionSecret)
    if (!this.identity) {
      throw new LocalTrialAccessError(409, 'Local trial setup is not ready. Restart the launcher.')
    }
    if (this.sessionConsumed) {
      throw new LocalTrialAccessError(409, 'Local trial link has already been used. Restart the launcher.')
    }
    this.sessionConsumed = true
    return { ...this.identity }
  }
}

export function localTrialEmail(userId: string): string {
  if (!uuidPattern.test(userId)) {
    throw new LocalTrialAccessError(409, 'Local trial identity is invalid.')
  }
  return `local-${userId}@kanwas.invalid`
}

export function assertLocalTrialUser(
  user: { id: string; email: string; password: string | null },
  userId: string
): void {
  if (user.id !== userId || user.email !== localTrialEmail(userId) || user.password !== null) {
    throw new LocalTrialAccessError(409, 'Local trial identity does not match this installation.')
  }
}
