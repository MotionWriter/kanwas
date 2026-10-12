import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('Local trial storage must be a private directory owned by you.')
  }
}

export async function acquireLaunchLock(root) {
  const directory = join(root, '.local-trial')
  await privateDirectory(directory)
  const path = join(directory, 'launcher.lock')
  let file
  try {
    file = await open(path, 'wx', 0o600)
  } catch {
    throw new Error('Another trial launcher owns the run. See docs/LOCAL_TRIAL.md if a stopped process left its lock.')
  }
  await file.writeFile(String(process.pid))
  await file.close()
  return () => unlink(path).catch(() => {})
}

export async function saveState(root, state) {
  const directory = join(root, '.local-trial')
  await privateDirectory(directory)
  const destination = join(directory, 'state.json')
  const existing = await lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0)) {
    throw new Error('Local trial configuration must be a private regular file.')
  }
  const temporary = join(directory, `.state-${randomUUID()}`)
  try {
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function loadState(root) {
  const directory = join(root, '.local-trial')
  await privateDirectory(directory)
  await privateDirectory(join(directory, 'backend-env'))
  await privateDirectory(join(directory, 'yjs-data'))
  const path = join(directory, 'state.json')
  const info = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) {
    const state = {
      version: 1,
      appKey: randomBytes(24).toString('base64url'),
      apiSecret: randomBytes(32).toString('hex'),
      databasePassword: randomBytes(32).toString('hex'),
      ownerId: null,
      model: 'gpt-6.1-sol',
    }
    await saveState(root, state)
    return state
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('Local trial configuration must be a private regular file.')
  }
  let state
  try {
    state = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error('Local trial configuration could not be read. Preserve it if you need existing data.')
  }
  if (
    !state ||
    typeof state !== 'object' ||
    state.version !== 1 ||
    !/^[A-Za-z0-9_-]{32}$/.test(state.appKey) ||
    !/^[a-f0-9]{64}$/.test(state.apiSecret) ||
    !/^[a-f0-9]{64}$/.test(state.databasePassword) ||
    (state.ownerId !== null && !/^[a-f0-9-]{36}$/i.test(state.ownerId)) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(state.model)
  ) {
    throw new Error('Local trial configuration is invalid; do not delete it if you need existing data.')
  }
  return state
}

export function environments(root, state, inherited = {}) {
  const common = {
    ...inherited,
    NODE_ENV: 'development',
    SENTRY_DSN: '',
    ENV_PATH: join(root, '.local-trial', 'backend-env'),
  }
  return {
    backend: {
      ...common,
      TZ: 'UTC',
      PORT: '3333',
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      APP_NAME: 'Kanwas local',
      APP_KEY: state.appKey,
      API_SECRET: state.apiSecret,
      DATABASE_URL: '',
      DB_HOST: '127.0.0.1',
      DB_PORT: '55432',
      DB_USER: 'kanwas',
      DB_PASSWORD: state.databasePassword,
      DB_DATABASE: 'kanwas_local_trial',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '56379',
      REDIS_USER: 'default',
      REDIS_PASSWORD: '',
      KANWAS_LOCAL_TRIAL: 'true',
      OPENAI_AUTH_MODE: 'chatgpt-plan',
      CHATGPT_PLAN_USER_ID: state.ownerId ?? 'local-trial-pending-owner',
      CHATGPT_PLAN_MODEL: state.model,
      KANWAS_CHATGPT_AUTH_DIR: join(root, '.local-trial', 'chatgpt'),
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      ANTHROPIC_API_KEY: '',
      COMPOSIO_API_KEY: '',
      PARALLEL_API_KEY: '',
      ASSEMBLYAI_API_KEY: '',
      GROQ_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_REDIRECT_URI: '',
      SLACK_WEBHOOK_URL: '',
      POSTHOG_QUERY_API_KEY: '',
      SANDBOX_PROVIDER: 'docker',
      SANDBOX_SENTRY_DSN: '',
      DRIVE_DISK: 'fs',
      BACKEND_URL: 'http://localhost:3333',
      YJS_SERVER_HOST: 'localhost:1999',
      YJS_SERVER_PROTOCOL: 'ws',
    },
    yjs: {
      ...common,
      PORT: '1999',
      HOST: '0.0.0.0',
      BACKEND_URL: 'http://localhost:3333',
      BACKEND_API_SECRET: state.apiSecret,
      YJS_SERVER_STORAGE_DRIVER: 'fs',
      YJS_SERVER_STORE_DIR: join(root, '.local-trial', 'yjs-data'),
      YJS_SERVER_LOG_LEVEL: 'info',
      SENTRY_ENVIRONMENT: 'development',
    },
    frontend: {
      ...common,
      VITE_API_URL: 'http://localhost:3333',
      VITE_YJS_SERVER_URL: 'localhost:1999',
      VITE_AUTH_TOKEN_KEY: 'kanwas_local_trial_token',
    },
    docker: { ...common, KANWAS_TRIAL_DB_PASSWORD: state.databasePassword },
  }
}
