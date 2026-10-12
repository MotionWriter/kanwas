import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { access, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ChatGPTPlanAuthError, OPENAI_ISSUER, validateKanwasUserId } from './types.js'
import type { CredentialState } from './types.js'

const MAX_FILE_BYTES = 128 * 1024

interface LockOwner {
  pid: number
  nonce: string
}

export function defaultCredentialDirectory(): string {
  const configured = process.env.KANWAS_CHATGPT_AUTH_DIR
  if (configured && !isAbsolute(configured)) {
    throw new ChatGPTPlanAuthError('unsafe_storage', 'KANWAS_CHATGPT_AUTH_DIR must be an absolute private directory.')
  }
  return configured || join(homedir(), '.config', 'kanwas', 'chatgpt-plan')
}

function systemCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
}

function assertPrivate(info: Stats, directory: boolean): void {
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new ChatGPTPlanAuthError(
      'unsafe_storage',
      'ChatGPT credential storage must be owned by this user, private, and not a symlink.'
    )
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < MAX_FILE_BYTES
}

function validateState(value: unknown): asserts value is CredentialState {
  const invalid = () => {
    throw new ChatGPTPlanAuthError('invalid_storage', 'The Kanwas ChatGPT credential file is invalid; do not use it.')
  }
  if (!value || typeof value !== 'object') return invalid()
  const state = value as CredentialState
  if (state.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/i.test(state.extAgentHostId)) return invalid()
  if (state.connection === undefined) return
  const connection = state.connection
  if (!connection || typeof connection !== 'object') return invalid()
  validateKanwasUserId(connection.kanwasUserId)
  if (
    connection.issuer !== OPENAI_ISSUER ||
    !nonempty(connection.subject) ||
    !nonempty(connection.clientId) ||
    connection.clientId === 'dynamic_agent_client' ||
    (connection.email !== undefined && !nonempty(connection.email))
  )
    return invalid()
  if (!connection.tokens) return
  const tokens = connection.tokens
  if (
    !nonempty(tokens.accessToken) ||
    tokens.tokenType !== 'Bearer' ||
    !Array.isArray(tokens.scopes) ||
    !tokens.scopes.every(nonempty) ||
    !Number.isFinite(tokens.expiresAt) ||
    tokens.expiresAt <= 0 ||
    (tokens.earliestRefreshAt !== undefined && !Number.isFinite(tokens.earliestRefreshAt)) ||
    !nonempty(tokens.savedAt) ||
    !Number.isFinite(Date.parse(tokens.savedAt)) ||
    (tokens.refreshToken !== undefined && !nonempty(tokens.refreshToken)) ||
    (tokens.idToken !== undefined && !nonempty(tokens.idToken))
  )
    return invalid()
}

/** Single-user local spike. Cross-process lock serializes sign-in, disconnect, and rotating refreshes. */
export class CredentialStore {
  readonly directory: string
  readonly filename: string

  constructor(directory = defaultCredentialDirectory()) {
    if (!isAbsolute(directory) || process.platform === 'win32') {
      throw new ChatGPTPlanAuthError(
        'unsafe_storage',
        'This local spike requires an absolute credential directory on macOS or Linux.'
      )
    }
    this.directory = resolve(directory)
    this.filename = join(this.directory, 'credentials.json')
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    assertPrivate(await lstat(this.directory), true)
  }

  async read(): Promise<CredentialState | undefined> {
    let handle: FileHandle | undefined
    try {
      assertPrivate(await lstat(this.directory), true)
      handle = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      assertPrivate(info, false)
      if (info.size > MAX_FILE_BYTES) {
        throw new ChatGPTPlanAuthError('invalid_storage', 'The Kanwas ChatGPT credential file is too large.')
      }
      const parsed: unknown = JSON.parse(await handle.readFile('utf8'))
      validateState(parsed)
      return parsed
    } catch (error) {
      if (systemCode(error) === 'ENOENT') return undefined
      if (error instanceof ChatGPTPlanAuthError) throw error
      throw new ChatGPTPlanAuthError('invalid_storage', 'Could not safely read the Kanwas ChatGPT credential file.')
    } finally {
      await handle?.close()
    }
  }

  /** Caller must hold withLock; access, expiry, and rotating refresh token are one atomic record. */
  async write(state: CredentialState): Promise<void> {
    validateState(state)
    await this.ensureDirectory()
    const temporary = join(this.directory, `.credentials-${randomUUID()}.tmp`)
    let handle: FileHandle | undefined
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, this.filename)
      const directoryHandle = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    } catch {
      throw new ChatGPTPlanAuthError('unsafe_storage', 'Could not atomically save private Kanwas ChatGPT credentials.')
    } finally {
      await handle?.close()
      await rm(temporary, { force: true })
    }
  }

  async withLock<T>(action: () => Promise<T>, waitMs = 20_000): Promise<T> {
    await this.ensureDirectory()
    const lockDirectory = join(this.directory, 'session.lock')
    const recoveryDirectory = join(this.directory, 'session.recovery')
    const owner: LockOwner = { pid: process.pid, nonce: randomUUID() }
    const deadline = Date.now() + waitMs
    for (;;) {
      try {
        if (await this.pathExists(recoveryDirectory)) throw Object.assign(new Error(), { code: 'EEXIST' })
        await mkdir(lockDirectory, { mode: 0o700 })
        try {
          const handle = await open(
            join(lockDirectory, 'owner.json'),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600
          )
          try {
            await handle.writeFile(JSON.stringify(owner), 'utf8')
            await handle.sync()
          } finally {
            await handle.close()
          }
          // Recovery may have started after the first guard check. Yield this newly-created lock.
          if (await this.pathExists(recoveryDirectory)) {
            await rm(lockDirectory, { recursive: true, force: true })
            throw Object.assign(new Error(), { code: 'EEXIST' })
          }
          break
        } catch (error) {
          if (systemCode(error) !== 'EEXIST') await rm(lockDirectory, { recursive: true, force: true })
          throw error
        }
      } catch (error) {
        if (systemCode(error) !== 'EEXIST') {
          throw new ChatGPTPlanAuthError('unsafe_storage', 'Could not lock private Kanwas ChatGPT credentials.')
        }
        // Never expire a live lock by age: browser authorization may take several minutes.
        if (Date.now() >= deadline) {
          throw new ChatGPTPlanAuthError(
            'busy',
            'Another Kanwas process owns the ChatGPT session. Retry after it finishes, or use recover-lock after a stopped process.'
          )
        }
        await delay(50)
      }
    }
    try {
      return await action()
    } finally {
      const savedOwner = await this.readLockOwner(lockDirectory)
      if (savedOwner.nonce === owner.nonce) await rm(lockDirectory, { recursive: true, force: true })
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch (error) {
      if (systemCode(error) === 'ENOENT') return false
      throw new ChatGPTPlanAuthError('unsafe_storage', 'Could not inspect the private ChatGPT session lock.')
    }
  }

  private async readLockOwner(directory: string): Promise<LockOwner> {
    let handle: FileHandle | undefined
    try {
      assertPrivate(await lstat(directory), true)
      handle = await open(join(directory, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      assertPrivate(info, false)
      if (info.size > 1024) throw new Error()
      const owner: LockOwner = JSON.parse(await handle.readFile('utf8'))
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[0-9a-f-]{36}$/i.test(owner.nonce)) throw new Error()
      return owner
    } catch {
      throw new ChatGPTPlanAuthError(
        'busy',
        'The ChatGPT lock owner is unknown. Stop all Kanwas processes before inspecting the private lock directory.'
      )
    } finally {
      await handle?.close()
    }
  }

  /** Explicit recovery only. Live/unknown owners and PID reuse fail closed; age never expires a lock. */
  async recoverLock(): Promise<{ recovered: boolean }> {
    await this.ensureDirectory()
    const lockDirectory = join(this.directory, 'session.lock')
    const recoveryDirectory = join(this.directory, 'session.recovery')
    try {
      await mkdir(recoveryDirectory, { mode: 0o700 })
    } catch {
      throw new ChatGPTPlanAuthError(
        'busy',
        'ChatGPT lock recovery is already running. Stop other recovery commands before retrying.'
      )
    }
    try {
      if (!(await this.pathExists(lockDirectory))) return { recovered: false }
      const owner = await this.readLockOwner(lockDirectory)
      try {
        process.kill(owner.pid, 0)
      } catch (error) {
        if (systemCode(error) === 'ESRCH') {
          await rm(lockDirectory, { recursive: true, force: true })
          return { recovered: true }
        }
        throw new ChatGPTPlanAuthError(
          'busy',
          'The ChatGPT lock owner could not be confirmed stopped. The lock was preserved.'
        )
      }
      throw new ChatGPTPlanAuthError(
        'busy',
        'A live process owns this ChatGPT session. Stop it before recovering its lock.'
      )
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  }
}
