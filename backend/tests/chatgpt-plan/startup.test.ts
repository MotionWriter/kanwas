import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function validate(overrides: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'kanwas-env-test-'))
  try {
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', "await import('./start/validate_env.ts')"],
      {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
        env: {
          ...process.env,
          ENV_PATH: directory,
          NODE_ENV: 'test',
          PORT: '3333',
          APP_KEY: 'offline-test-key',
          APP_NAME: 'Kanwas',
          HOST: '127.0.0.1',
          LOG_LEVEL: 'silent',
          REDIS_HOST: '127.0.0.1',
          REDIS_PORT: '6379',
          COMPOSIO_API_KEY: 'offline-fixture',
          PARALLEL_API_KEY: 'offline-fixture',
          API_SECRET: 'offline-fixture',
          DRIVE_DISK: 'fs',
          ANTHROPIC_API_KEY: '',
          OPENAI_API_KEY: '',
          OPENAI_AUTH_MODE: 'chatgpt-plan',
          CHATGPT_PLAN_USER_ID: 'owner',
          CHATGPT_PLAN_MODEL: 'catalog-model',
          ...overrides,
        },
      }
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('subscription backend startup does not require any LLM API key', () => {
  const result = validate({})
  assert.equal(result.status, 0, result.stderr)
})

test('subscription backend startup refuses a missing owner or model', () => {
  const owner = validate({ CHATGPT_PLAN_USER_ID: '' })
  assert.equal(owner.status, 1)
  assert.match(owner.stderr, /CHATGPT_PLAN_USER_ID/)
  const model = validate({ CHATGPT_PLAN_MODEL: '' })
  assert.equal(model.status, 1)
  assert.match(model.stderr, /CHATGPT_PLAN_MODEL/)
})

test('API-key backend startup still requires its default OpenAI key', () => {
  const missing = validate({ OPENAI_AUTH_MODE: 'api-key' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /OPENAI_API_KEY/)
  const present = validate({ OPENAI_AUTH_MODE: 'api-key', OPENAI_API_KEY: 'offline-fixture' })
  assert.equal(present.status, 0, present.stderr)
})
