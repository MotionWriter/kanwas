import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, symlink, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLaunchLock, environments, loadState, saveState } from './config.mjs'

test('trial secrets persist privately and inherited API billing keys are cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kanwas trial '))
  try {
    const state = await loadState(root)
    assert.equal(state.ownerId, null)
    assert.equal((await stat(join(root, '.local-trial'))).mode & 0o777, 0o700)
    assert.equal((await stat(join(root, '.local-trial', 'state.json'))).mode & 0o777, 0o600)
    assert.deepEqual(await loadState(root), state)
    const env = environments(root, state, { OPENAI_API_KEY: 'must-not-inherit', COMPOSIO_API_KEY: 'must-not-inherit' })
    assert.equal(env.backend.OPENAI_API_KEY, '')
    assert.equal(env.backend.COMPOSIO_API_KEY, '')
    assert.equal(env.backend.OPENAI_AUTH_MODE, 'chatgpt-plan')
    assert.equal(env.backend.KANWAS_LOCAL_TRIAL, 'true')
    assert.equal(env.backend.API_SECRET, env.yjs.BACKEND_API_SECRET)
    assert.equal(env.backend.DB_PASSWORD, env.docker.KANWAS_TRIAL_DB_PASSWORD)
    assert.equal(env.yjs.YJS_SERVER_STORAGE_DRIVER, 'fs')
    state.ownerId = '550e8400-e29b-41d4-a716-446655440000'
    await saveState(root, state)
    assert.equal((await loadState(root)).ownerId, state.ownerId)
    assert.equal(environments(root, state).backend.CHATGPT_PLAN_USER_ID, state.ownerId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('one launcher owns trial startup until its lock is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kanwas-trial-lock-'))
  try {
    const release = await acquireLaunchLock(root)
    await assert.rejects(acquireLaunchLock(root), /Another trial launcher/)
    await release()
    await (
      await acquireLaunchLock(root)
    )()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('trial configuration refuses symlinks and unsafe file permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kanwas-trial-'))
  try {
    await loadState(root)
    const file = join(root, '.local-trial', 'state.json')
    const original = await readFile(file, 'utf8')
    await chmod(file, 0o644)
    await assert.rejects(loadState(root), /private regular file/)
    await assert.rejects(saveState(root, {}), /private regular file/)
    assert.equal(await readFile(file, 'utf8'), original)
    await rm(file)
    await symlink(join(root, 'unrelated-file'), file)
    await assert.rejects(loadState(root), /private regular file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
