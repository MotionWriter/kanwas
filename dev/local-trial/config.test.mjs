import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, symlink, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLaunchLock, environments, loadState, saveState, launchPasses, saveBrowserHandoff } from './config.mjs'

test('trial secrets persist privately and inherited API billing keys are cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kanwas trial '))
  try {
    const state = await loadState(root)
    assert.match(state.ownerId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    assert.equal((await stat(join(root, '.local-trial'))).mode & 0o777, 0o700)
    assert.equal((await stat(join(root, '.local-trial', 'state.json'))).mode & 0o777, 0o600)
    assert.deepEqual(await loadState(root), state)
    const passes = launchPasses()
    const env = environments(
      root,
      state,
      { OPENAI_API_KEY: 'must-not-inherit', COMPOSIO_API_KEY: 'must-not-inherit' },
      passes
    )
    assert.equal(env.backend.OPENAI_API_KEY, '')
    assert.equal(env.backend.COMPOSIO_API_KEY, '')
    assert.equal(env.backend.OPENAI_AUTH_MODE, 'chatgpt-plan')
    assert.equal(env.backend.KANWAS_LOCAL_TRIAL, 'true')
    assert.equal(env.backend.KANWAS_LOCAL_TRIAL_USER_ID, state.ownerId)
    assert.equal(env.backend.KANWAS_LOCAL_TRIAL_BOOTSTRAP_SECRET, passes.bootstrap)
    assert.equal(env.frontend.VITE_LOCAL_TRIAL, 'true')
    assert.equal(Object.values(env.frontend).includes(passes.bootstrap), false)
    assert.equal(Object.values(env.frontend).includes(passes.session), false)
    assert.notEqual(passes.bootstrap, passes.session)
    assert.notDeepEqual(launchPasses(), passes)
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

test('old pending configuration gains one stable generated local owner without losing secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kanwas-trial-migrate-'))
  try {
    const state = await loadState(root)
    await saveState(root, { ...state, ownerId: null })
    const migrated = await loadState(root)
    assert.notEqual(migrated.ownerId, null)
    assert.equal(migrated.appKey, state.appKey)
    assert.equal(migrated.databasePassword, state.databasePassword)
    assert.deepEqual(await loadState(root), migrated)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser handoff is private, replaces the previous pass, and keeps it in a URL fragment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kanwas-trial-handoff-'))
  try {
    const pass = launchPasses().session
    await saveBrowserHandoff(root, pass)
    const path = join(root, '.local-trial', 'browser-handoff.json')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const url = new URL(JSON.parse(await readFile(path, 'utf8')).url)
    assert.equal(url.search, '')
    assert.equal(url.hash, `#local-trial-session=${pass}`)
    await saveBrowserHandoff(root, launchPasses().session)
    assert.notEqual(JSON.parse(await readFile(path, 'utf8')).url, url.href)
    await assert.rejects(saveBrowserHandoff(root, 'invalid'), /Invalid local/)
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
