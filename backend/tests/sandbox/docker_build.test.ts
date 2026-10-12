import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DockerSandbox } from '../../libs/agent/sandbox/docker.js'

test('Docker build preserves a checkout path with spaces and shell characters as one argument', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'kanwas-docker-build-'))
  const capturePath = join(testDir, 'arguments')
  const dockerPath = join(testDir, 'docker')
  const buildContext = join(testDir, 'checkout with spaces $HOME')
  const previousPath = process.env.PATH
  const previousCapture = process.env.KANWAS_DOCKER_TEST_CAPTURE

  try {
    // A failing stub records argv and stops initialization before any container launch.
    await writeFile(dockerPath, '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$KANWAS_DOCKER_TEST_CAPTURE"\nexit 23\n')
    await chmod(dockerPath, 0o700)
    process.env.PATH = `${testDir}:${previousPath ?? ''}`
    process.env.KANWAS_DOCKER_TEST_CAPTURE = capturePath

    const sandbox = new DockerSandbox({
      provider: 'docker',
      backendUrl: 'http://localhost:3333',
      yjsServerHost: 'localhost:1999',
      docker: { buildContext, imageName: 'kanwas-test-execenv' },
    })

    await assert.rejects(
      sandbox.initialize({
        workspaceId: 'test-workspace',
        authToken: 'unused-test-token',
        userId: 'test-user',
        correlationId: 'test-correlation',
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 23
    )

    const capturedArguments = await readFile(capturePath, 'utf8')
    const argv = capturedArguments.split('\0').slice(0, -1)
    assert.deepEqual(argv, [
      'build',
      '-t',
      'kanwas-test-execenv',
      '-f',
      join(buildContext, 'execenv', 'Dockerfile'),
      buildContext,
    ])
    assert.equal(sandbox.getSandboxId(), null)
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = previousPath
    }
    if (previousCapture === undefined) {
      delete process.env.KANWAS_DOCKER_TEST_CAPTURE
    } else {
      process.env.KANWAS_DOCKER_TEST_CAPTURE = previousCapture
    }
    await rm(testDir, { recursive: true, force: true })
  }
})
