import { spawn, spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLaunchLock, loadState, saveState, environments, launchPasses, saveBrowserHandoff } from './config.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const node = process.execPath
const services = new Set()
const expectedStops = new WeakSet()
const shutdownSignal = new AbortController()
let closing = false
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

async function bootstrapOwner(state, passes) {
  const response = await fetch('http://127.0.0.1:3333/local-trial/bootstrap', {
    method: 'POST',
    headers: { 'X-Kanwas-Local-Trial': passes.bootstrap },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error('Automatic local workspace setup failed. Review the backend output.')
  const result = await response.json()
  if (result.userId !== state.ownerId || typeof result.workspaceId !== 'string')
    throw new Error('The local workspace did not match the reserved trial identity.')
  return result.workspaceId
}

async function connectOwner(state, env, { reconnect = false, canvasOnly = false } = {}) {
  const args = ['--import', 'tsx', 'scripts/chatgpt_plan_auth.ts']
  const options = { cwd: join(root, 'backend'), env, capture: true }
  let status = JSON.parse(await run(node, [...args, 'status'], options))
  if (status.connected && status.planUsageEnabled && status.kanwasUserId === 'local-signin-test') {
    status = JSON.parse(await run(node, [...args, 'adopt-local-owner', '--user-id', state.ownerId], options))
    console.log('Your existing ChatGPT connection is bound to this automatic local workspace.')
  }
  if (status.registered && status.kanwasUserId !== state.ownerId)
    throw new Error('The saved ChatGPT connection belongs to a different workspace. It was preserved.')
  if (!canvasOnly && (reconnect || !status.connected || !status.planUsageEnabled)) {
    if (!process.stdin.isTTY)
      throw new Error('Run start_kanwas.command in Terminal to authorize ChatGPT in your regular browser.')
    console.log('Authorize ChatGPT for the local workspace in your regular browser. No local signup is needed.')
    await run(node, [...args, 'signin', '--user-id', state.ownerId], { cwd: options.cwd, env })
    status = JSON.parse(await run(node, [...args, 'status', '--user-id', state.ownerId], options))
  }
  if (!status.connected || !status.planUsageEnabled) {
    if (canvasOnly) return false
    throw new Error('ChatGPT plan access was not granted. Restart the launcher to try again.')
  }
  const models = JSON.parse(await run(node, [...args, 'models', '--user-id', state.ownerId], options))
  const model = models.find((item) => item.slug === state.model)
  if (!model) throw new Error('The configured model is unavailable. The connection was preserved.')
  console.log(`ChatGPT connected. Model: ${model.display_name}.`)
  return true
}

async function openLocalApp(url) {
  const executable = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const result = spawnSync(executable, [url], { stdio: 'ignore', shell: false })
  if (result.status !== 0)
    console.log('The browser could not open. Restart this launcher after choosing a default browser.')
}

async function main() {
  const args = process.argv.slice(2)
  if (
    args.length &&
    !(args.length === 1 && ['--check', '--stop-infra', '--reconnect', '--serve-only', '--no-browser'].includes(args[0]))
  ) {
    throw new Error('Usage: start_kanwas.command [--check|--stop-infra|--reconnect|--serve-only|--no-browser]')
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
  const passes = launchPasses()
  const env = environments(root, state, inherited, passes)
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
  startService('Backend', ['ace.js', 'serve'], env.backend, join(root, 'backend'))
  startService('Yjs', ['--import', 'tsx', 'src/index.ts'], env.yjs, join(root, 'yjs-server'))
  startService(
    'Frontend',
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '15173', '--strictPort'],
    env.frontend,
    join(root, 'frontend')
  )
  await waitFor('http://127.0.0.1:3333/health')
  await waitFor('http://127.0.0.1:1999/health')
  await waitFor('http://127.0.0.1:15173')
  await bootstrapOwner(state, passes)
  const connected = await connectOwner(state, env.backend, {
    reconnect: args[0] === '--reconnect',
    canvasOnly: args[0] === '--serve-only',
  })
  await saveState(root, state)
  await saveBrowserHandoff(root, passes.session)
  if (args[0] !== '--no-browser') await openLocalApp(`http://localhost:15173/#local-trial-session=${passes.session}`)
  console.log('\nYour local canvas is ready at http://localhost:15173. No local signup or password is needed.')
  if (!connected) console.log('Canvas mode is available. Restart normally to authorize ChatGPT for AI actions.')
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
