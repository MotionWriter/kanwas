import { spawn, spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { acquireLaunchLock, loadState, saveState, environments } from './config.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const node = process.execPath
const services = new Set()
const expectedStops = new WeakSet()
const shutdownSignal = new AbortController()
let closing = false
let terminal
let releaseLock

async function exists(path) {
  return access(path).then(
    () => true,
    () => false
  )
}
async function findDocker() {
  const candidates = [
    'docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
    join(process.env.HOME ?? '', '.docker', 'bin', 'docker'),
  ]
  for (const candidate of candidates) {
    const check = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    if (check.status === 0) return candidate
  }
  throw new Error('Install and start Docker Desktop, then run this launcher again. See docs/LOCAL_TRIAL.md.')
}

function run(executable, args, { cwd = root, env = process.env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      signal: shutdownSignal.signal,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let output = ''
    if (capture) {
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      // Captured commands may contain account metadata; do not dump raw error output.
      child.stderr.on('data', () => {})
    }
    child.on('error', () => reject(new Error(`Could not start ${executable}.`)))
    child.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${args[0]} failed; review its terminal output.`))
    )
  })
}

function startService(name, args, env, cwd) {
  if (closing) throw new Error('Launch cancelled.')
  const child = spawn(node, args, { cwd, env, detached: true, stdio: 'inherit' })
  services.add(child)
  child.on('error', () => {
    if (!closing) void fail(new Error(`Could not start ${name}.`))
  })
  child.on('exit', () => {
    if (!closing && !expectedStops.has(child)) void fail(new Error(`${name} stopped; review its terminal output.`))
  })
  return child
}

async function stopService(child) {
  expectedStops.add(child)
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
  await Promise.race([
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('exit', resolve)
    }),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
  services.delete(child)
}

async function shutdown() {
  if (closing) return
  closing = true
  shutdownSignal.abort()
  terminal?.close()
  await Promise.all([...services].map(stopService))
  await releaseLock?.()
}
async function fail(error) {
  if (closing) return
  console.error(`\n${error.message}`)
  process.exitCode = 1
  await shutdown()
}
process.once('SIGINT', () => {
  void shutdown()
})
process.once('SIGTERM', () => {
  void shutdown()
})

async function waitFor(url) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !closing) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Service did not become ready at ${url}. Review the terminal output.`)
}

async function connectOwner(state, env) {
  terminal = createInterface({ input: process.stdin, output: process.stdout })
  console.log(
    state.ownerId
      ? '\nOpen http://localhost:15173 and sign in to your existing local Kanwas account.'
      : '\nOpen http://localhost:15173/register in your regular browser and create your local Kanwas account.'
  )
  await terminal.question('After signing in to the local app, press Return here. ')
  const email = (await terminal.question('Email used for your local Kanwas account: ')).trim()
  terminal.close()
  terminal = undefined
  if (!email) throw new Error('A local Kanwas account email is required.')
  const require = createRequire(join(root, 'backend', 'package.json'))
  const { Client } = require('pg')
  const client = new Client({
    host: '127.0.0.1',
    port: 55432,
    user: 'kanwas',
    password: state.databasePassword,
    database: 'kanwas_local_trial',
  })
  let ownerId
  try {
    await client.connect()
    const result = await client.query('SELECT id FROM users WHERE email = $1', [email])
    ownerId = result.rows[0]?.id
  } finally {
    await client.end()
  }
  if (!ownerId) throw new Error('That account was not found. Create it in the local app before connecting ChatGPT.')
  const args = ['--import', 'tsx', 'scripts/chatgpt_plan_auth.ts']
  console.log('Now authorize ChatGPT for this local Kanwas account in your regular browser.')
  await run(node, [...args, 'signin', '--user-id', ownerId], { cwd: join(root, 'backend'), env })
  const status = JSON.parse(
    await run(node, [...args, 'status', '--user-id', ownerId], { cwd: join(root, 'backend'), env, capture: true })
  )
  if (!status.connected || !status.planUsageEnabled)
    throw new Error('ChatGPT plan access was not granted. Restart the launcher to try again.')
  const models = JSON.parse(
    await run(node, [...args, 'models', '--user-id', ownerId], { cwd: join(root, 'backend'), env, capture: true })
  )
  const model = models.find((item) => item.slug === 'gpt-6.1-sol') ?? models[0]
  if (!model) throw new Error('No visible ChatGPT models were returned.')
  state.ownerId = ownerId
  state.model = model.slug
  await saveState(root, state)
  console.log(`ChatGPT connected. Model: ${model.display_name}.`)
}

async function main() {
  const args = process.argv.slice(2)
  if (
    args.length &&
    !(args.length === 1 && ['--check', '--stop-infra', '--reconnect', '--serve-only'].includes(args[0]))
  ) {
    throw new Error('Usage: start_kanwas.command [--check|--stop-infra|--reconnect|--serve-only]')
  }
  for (const file of [
    'backend/node_modules/tsx/package.json',
    'frontend/node_modules/vite/bin/vite.js',
    'yjs-server/node_modules/tsx/package.json',
    'shared/node_modules/typescript/bin/tsc',
  ]) {
    if (!(await exists(join(root, file))))
      throw new Error('Dependencies are missing. Run pnpm 10.11.0 install --frozen-lockfile first.')
  }
  const docker = await findDocker()
  if (spawnSync(docker, ['compose', 'version'], { stdio: 'ignore' }).status !== 0)
    throw new Error('Docker Compose is required.')
  if (spawnSync(docker, ['--context', 'desktop-linux', 'info'], { stdio: 'ignore' }).status !== 0)
    throw new Error('Start Docker Desktop and wait for its engine, then run this launcher again.')
  if (args[0] === '--check') {
    console.log('Node, dependencies, Docker and Compose are ready.')
    return
  }
  if (args[0] !== '--stop-infra') releaseLock = await acquireLaunchLock(root)
  const state = await loadState(root)
  const inherited = {
    ...process.env,
    PATH: [dirname(node), ...(docker.includes('/') ? [dirname(docker)] : []), process.env.PATH]
      .filter(Boolean)
      .join(':'),
  }
  let env = environments(root, state, inherited)
  const compose = ['compose', '-p', 'kanwas-local-trial', '-f', join(root, 'dev', 'local-trial', 'compose.yml')]
  if (args[0] === '--stop-infra') {
    await run(docker, [...compose, 'stop'], { env: env.docker })
    return
  }
  console.log('Starting local PostgreSQL and Redis. Your trial data persists between launches.')
  await run(docker, [...compose, 'up', '-d', '--wait'], { env: env.docker })
  await run(node, [
    join(root, 'shared', 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    join(root, 'shared', 'tsconfig.json'),
  ])
  await run(node, ['ace.js', 'migration:run', '--force'], { cwd: join(root, 'backend'), env: env.backend })
  let backend = startService('Backend', ['ace.js', 'serve'], env.backend, join(root, 'backend'))
  startService('Yjs', ['--import', 'tsx', 'src/index.ts'], env.yjs, join(root, 'yjs-server'))
  startService(
    'Frontend',
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '15173', '--strictPort'],
    env.frontend,
    join(root, 'frontend')
  )
  await waitFor('http://localhost:3333/health')
  await waitFor('http://localhost:1999/health')
  await waitFor('http://localhost:15173')
  if (args[0] !== '--serve-only' && (!state.ownerId || args[0] === '--reconnect')) {
    if (!process.stdin.isTTY) throw new Error('First launch needs an interactive Terminal for account setup.')
    await connectOwner(state, env.backend)
    await stopService(backend)
    env = environments(root, state, inherited)
    backend = startService('Backend', ['ace.js', 'serve'], env.backend, join(root, 'backend'))
    await waitFor('http://localhost:3333/health')
  }
  console.log('\nKanwas is ready at http://localhost:15173 — refresh the browser after connecting ChatGPT.')
  if (args[0] === '--serve-only' && !state.ownerId)
    console.log('Create your local account first; subscription agent access awaits owner authorization.')
  console.log('Keep this terminal open. Press Ctrl+C to stop the app; your data stays saved.')
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (closing) {
        clearInterval(timer)
        resolve()
      }
    }, 250)
  })
}

main().catch(fail)
