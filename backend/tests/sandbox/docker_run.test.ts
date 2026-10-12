import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { DockerSandbox } from '../../libs/agent/sandbox/docker.js'

interface CapturedCommand {
  argv: string[]
  environment?: Record<string, string>
}

const authToken = 'fake-token with spaces $HOME `literal`'
const assemblyKey = 'fake-assembly-key with spaces'
const sentryDsn = 'https://fixture-secret@sentry.example.invalid/1'
const containerId = 'a'.repeat(64)
const environmentNames = [
  'WORKSPACE_ID',
  'YJS_SERVER_HOST',
  'YJS_SERVER_PROTOCOL',
  'BACKEND_URL',
  'AUTH_TOKEN',
  'ASSEMBLYAI_API_KEY',
  'USER_ID',
  'CORRELATION_ID',
  'SENTRY_DSN',
]

async function fixtureDocker(t: TestContext, mode: 'success' | 'failure' | 'invalid-id') {
  const directory = await mkdtemp(join(tmpdir(), 'kanwas-docker-run-'))
  const capturePath = join(directory, 'arguments.jsonl')
  const dockerPath = join(directory, 'docker')
  const originalPath = process.env.PATH
  const originalCapture = process.env.KANWAS_DOCKER_TEST_CAPTURE
  const originalMode = process.env.KANWAS_DOCKER_TEST_MODE
  const script = `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const argv = process.argv.slice(2)
const environment = argv[0] === 'run'
  ? Object.fromEntries(${JSON.stringify(environmentNames)}.map((name) => [name, process.env[name]]))
  : undefined
appendFileSync(process.env.KANWAS_DOCKER_TEST_CAPTURE, JSON.stringify({ argv, environment }) + '\\n')
if (argv[0] === 'run') {
  if (process.env.KANWAS_DOCKER_TEST_MODE === 'failure') {
    process.stderr.write('Docker failure included ' + process.env.AUTH_TOKEN + ' ' + process.env.ASSEMBLYAI_API_KEY + ' ' + process.env.SENTRY_DSN)
    process.exit(42)
  }
  console.log(process.env.KANWAS_DOCKER_TEST_MODE === 'invalid-id' ? process.env.AUTH_TOKEN : '${containerId}')
}
`
  await writeFile(dockerPath, script, { mode: 0o700 })
  await chmod(dockerPath, 0o700)
  process.env.PATH = `${directory}:${originalPath ?? ''}`
  process.env.KANWAS_DOCKER_TEST_CAPTURE = capturePath
  process.env.KANWAS_DOCKER_TEST_MODE = mode
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalCapture === undefined) delete process.env.KANWAS_DOCKER_TEST_CAPTURE
    else process.env.KANWAS_DOCKER_TEST_CAPTURE = originalCapture
    if (originalMode === undefined) delete process.env.KANWAS_DOCKER_TEST_MODE
    else process.env.KANWAS_DOCKER_TEST_MODE = originalMode
    await rm(directory, { recursive: true, force: true })
  })
  const sandbox = new DockerSandbox({
    provider: 'docker',
    backendUrl: 'http://localhost:3333',
    yjsServerHost: 'localhost:1999',
    assemblyaiApiKey: assemblyKey,
    sentryDsn,
    docker: { buildContext: join(directory, 'checkout with spaces'), imageName: 'kanwas-test-execenv' },
  })
  const options = {
    workspaceId: 'test-workspace',
    authToken,
    userId: 'test-user with spaces',
    correlationId: 'test-correlation with $literal',
  }
  return {
    sandbox,
    options,
    async commands(): Promise<CapturedCommand[]> {
      const content = await readFile(capturePath, 'utf8')
      return content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    },
  }
}

test('Docker run passes credentials through named environment variables and keeps runtime operations in argv', async (t) => {
  const fixture = await fixtureDocker(t, 'success')
  await fixture.sandbox.initialize(fixture.options)
  assert.equal(fixture.sandbox.getSandboxId(), containerId)
  assert.equal(fixture.sandbox.isReady(), true)
  await fixture.sandbox.shutdown()
  const commands = await fixture.commands()
  const run = commands.find((command) => command.argv[0] === 'run')!
  assert.ok(run)
  assert.match(run.argv[3], /^kanwas-sandbox-test-workspace-\d+$/)
  assert.deepEqual(run.argv.slice(4), [
    ...environmentNames.flatMap((name) => ['-e', name]),
    'kanwas-test-execenv',
    'tail',
    '-f',
    '/dev/null',
  ])
  assert.deepEqual(run.environment, {
    WORKSPACE_ID: fixture.options.workspaceId,
    YJS_SERVER_HOST: 'host.docker.internal:1999',
    YJS_SERVER_PROTOCOL: 'ws',
    BACKEND_URL: 'http://host.docker.internal:3333',
    AUTH_TOKEN: authToken,
    ASSEMBLYAI_API_KEY: assemblyKey,
    USER_ID: fixture.options.userId,
    CORRELATION_ID: fixture.options.correlationId,
    SENTRY_DSN: sentryDsn,
  })
  for (const secret of [authToken, assemblyKey, sentryDsn]) {
    assert.equal(
      run.argv.some((argument) => argument.includes(secret)),
      false
    )
  }
  assert.equal(run.argv.includes('BACKEND_API_SECRET'), false)
  assert.ok(commands.some((command) => JSON.stringify(command.argv) === JSON.stringify(['stop', containerId])))
  assert.ok(commands.some((command) => JSON.stringify(command.argv) === JSON.stringify(['rm', containerId])))
})

test('Docker startup errors preserve only safe exit metadata even when Docker stderr contains credentials', async (t) => {
  const fixture = await fixtureDocker(t, 'failure')
  await assert.rejects(fixture.sandbox.initialize(fixture.options), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Docker sandbox startup failed (exit 42). Check Docker Desktop and retry.')
    for (const secret of [authToken, assemblyKey, sentryDsn]) {
      assert.equal(String(error).includes(secret), false)
      assert.equal(JSON.stringify(error).includes(secret), false)
    }
    assert.equal('cause' in error, false)
    assert.equal('stderr' in error, false)
    assert.equal('cmd' in error, false)
    return true
  })
  assert.equal(fixture.sandbox.getSandboxId(), null)
})

test('Docker startup refuses unexpected stdout without retaining or logging its contents', async (t) => {
  const fixture = await fixtureDocker(t, 'invalid-id')
  await assert.rejects(
    fixture.sandbox.initialize(fixture.options),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Docker sandbox startup returned an invalid container ID. Check Docker Desktop and retry.'
  )
  assert.equal(fixture.sandbox.getSandboxId(), null)
})
