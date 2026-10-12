import { describe, expect, it, vi } from 'vitest'
import { captureLocalTrialHandoff } from '@/lib/localTrialSession'

const pass = 'a'.repeat(64)
const session = {
  type: 'bearer',
  value: 'fixture-token',
  workspaceId: '510c8741-ef2f-402c-8b8a-581c723798f9',
}

function capture(
  hash = `#local-trial-session=${pass}`,
  enabled = true,
  request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(session)),
  origin = 'http://localhost:15173'
) {
  const history = { state: { previous: true }, replaceState: vi.fn() }
  const handoff = captureLocalTrialHandoff({ href: `${origin}/?view=canvas${hash}` }, history, enabled, request)
  return { handoff, history, request }
}

describe('local trial session handoff', () => {
  it('removes the pass synchronously, before any request, and retains unrelated navigation state', async () => {
    const { handoff, history, request } = capture(`#local-trial-session=${pass}&section=notes`)

    expect(history.replaceState).toHaveBeenCalledWith({ previous: true }, '', '/?view=canvas#section=notes')
    expect(request).not.toHaveBeenCalled()
    await expect(handoff!.exchange('http://localhost:3333')).resolves.toEqual(session)
    expect(request).toHaveBeenCalledWith('http://localhost:3333/local-trial/session', {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'X-Kanwas-Local-Trial': pass },
    })
  })

  it('shares one exchange across concurrent calls and remounts', async () => {
    const { handoff, request } = capture()
    const first = handoff!.exchange('http://localhost:3333')
    const second = handoff!.exchange('http://localhost:3333')

    expect(second).toBe(first)
    await expect(first).resolves.toEqual(session)
    await expect(handoff!.exchange('http://localhost:3333')).resolves.toEqual(session)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not retry a consumed pass after a failed response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('expired', { status: 401 }))
    const { handoff } = capture(undefined, true, request)

    await expect(handoff!.exchange('http://localhost:3333')).rejects.toThrow('Restart the local launcher')
    await expect(handoff!.exchange('http://localhost:3333')).rejects.toThrow('Restart the local launcher')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('cleans and rejects duplicated or malformed passes without calling the backend', async () => {
    for (const hash of ['#local-trial-session=invalid', `#local-trial-session=${pass}&local-trial-session=${pass}`]) {
      const { handoff, history, request } = capture(hash)
      expect(history.replaceState).toHaveBeenCalledWith({ previous: true }, '', '/?view=canvas')
      await expect(handoff!.exchange('http://localhost:3333')).rejects.toThrow('Restart the local launcher')
      expect(request).not.toHaveBeenCalled()
    }
  })

  it('never sends a pass from a remote page or to a remote API', async () => {
    const remotePage = capture(undefined, true, undefined, 'https://example.com')
    await expect(remotePage.handoff!.exchange('http://localhost:3333')).rejects.toThrow('Restart the local launcher')
    expect(remotePage.request).not.toHaveBeenCalled()

    const remoteApi = capture()
    await expect(remoteApi.handoff!.exchange('https://example.com')).rejects.toThrow('Restart the local launcher')
    expect(remoteApi.request).not.toHaveBeenCalled()
  })

  it('does not expose backend payloads when rejecting an invalid session', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...session, workspaceId: 'invalid' }))
    const { handoff } = capture(undefined, true, request)

    await expect(handoff!.exchange('http://localhost:3333')).rejects.toThrow('Restart the local launcher')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('strips the pass without enabling a session outside the local trial', () => {
    const { handoff, history, request } = capture(undefined, false)
    expect(handoff).toBeNull()
    expect(history.replaceState).toHaveBeenCalledWith({ previous: true }, '', '/?view=canvas')
    expect(request).not.toHaveBeenCalled()
  })

  it('leaves ordinary navigation untouched', () => {
    const { handoff, history, request } = capture('#document-heading')
    expect(handoff).toBeNull()
    expect(history.replaceState).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
})
