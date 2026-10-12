import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { ChatGPTPlanAuth, ChatGPTPlanAuthError } from '../libs/chatgpt-plan-auth/index.js'
import { ChatGPTPlanRequestError, listAvailableModels, probeResponse } from '../libs/chatgpt-plan-auth/probe.js'

async function openBrowser(url: string): Promise<void> {
  const executable = process.platform === 'darwin' ? 'open' : 'xdg-open'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [url], { stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('Browser did not open'))))
  }).catch(() => {
    // This URL has only the pending state/nonce/PKCE challenge, never access/refresh/ID tokens.
    console.log(`Open this sign-in URL in your browser:\n${url}`)
  })
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { 'user-id': { type: 'string' }, 'model': { type: 'string' }, 'help': { type: 'boolean' } },
    allowPositionals: true,
  })
  const command = positionals[0]
  if (values.help || !command) {
    console.log(
      'Kanwas local ChatGPT plan connection (macOS/Linux)\n\nCommands: signin, status, disconnect, models, probe, recover-lock\nUse --user-id <Kanwas user ID> for signin/disconnect/models/probe.\nprobe also requires --model <slug from models>.\nrecover-lock removes only a session lock whose owner process is confirmed stopped.\nNo API key or existing Codex credentials are used.'
    )
    return
  }
  if (
    positionals.length !== 1 ||
    !['signin', 'status', 'disconnect', 'models', 'probe', 'recover-lock'].includes(command)
  ) {
    throw new Error('Choose signin, status, disconnect, models, probe, or recover-lock. Use --help for usage.')
  }
  const auth = new ChatGPTPlanAuth()
  if (command === 'recover-lock') {
    console.log(JSON.stringify(await auth.store.recoverLock(), null, 2))
    return
  }
  const userId = values['user-id']
  if (command === 'status') {
    console.log(JSON.stringify(await auth.getConnectionStatus(userId), null, 2))
    return
  }
  if (!userId) throw new Error('Supply --user-id with the explicit Kanwas user ID to bind this ChatGPT connection.')
  if (command === 'signin') {
    console.log('Continue with ChatGPT in your browser. Sign-in waits up to five minutes.')
    const status = await auth.signIn(userId, openBrowser)
    console.log(JSON.stringify(status, null, 2))
    if (!status.planUsageEnabled)
      console.log('Signed in, but permission to use your ChatGPT plan was not granted. AI requests remain disabled.')
    return
  }
  if (command === 'disconnect') {
    const result = await auth.disconnect(userId)
    console.log(JSON.stringify(result.status, null, 2))
    if (!result.remoteRevocationConfirmed)
      console.log(
        'Local tokens cleared. Remote revocation was not confirmed; disconnect Kanwas in ChatGPT Settings if needed.'
      )
    return
  }
  const accessToken = await auth.getAccessToken(userId)
  const models = await listAvailableModels(accessToken)
  if (command === 'models') {
    console.log(JSON.stringify(models, null, 2))
    return
  }
  if (!values.model || !models.some((model) => model.slug === values.model)) {
    throw new Error('Supply --model with a visible model slug returned by the models command.')
  }
  console.log(await probeResponse(accessToken, values.model))
}

main().catch((error: unknown) => {
  if (error instanceof ChatGPTPlanAuthError) {
    console.error(`${error.code}: ${error.message}`)
  } else if (error instanceof ChatGPTPlanRequestError) {
    console.error(error.message)
    if (error.requestId) console.error(`OpenAI request ID: ${error.requestId}`)
    if (error.bodyShape) console.error(`Error response shape: ${error.bodyShape}`)
  } else {
    // Only explicitly-created CLI validation messages are printable. Do not dump raw network/filesystem errors.
    const message =
      error instanceof Error && /^(Choose |Supply )/.test(error.message)
        ? error.message
        : 'Kanwas ChatGPT command failed. Use --help or retry.'
    console.error(message)
  }
  process.exitCode = 1
})
