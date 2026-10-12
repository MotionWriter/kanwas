import React, { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalTrialEntry } from '@/components/auth/LocalTrialEntry'
import { captureLocalTrialHandoff, type LocalTrialHandoff } from '@/lib/localTrialSession'

const fixture = vi.hoisted(() => ({
  handoff: null as LocalTrialHandoff | null,
  auth: { isLoading: false, isAuthenticated: false },
  setToken: vi.fn(),
}))

vi.mock('@/api/client', () => ({ baseURL: 'http://localhost:3333' }))
vi.mock('@/providers/auth', () => ({
  useAuth: () => ({ setToken: fixture.setToken }),
  useAuthState: () => fixture.auth,
}))
vi.mock('@/lib/localTrialSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/localTrialSession')>()),
  isLocalTrial: true,
  getLocalTrialHandoff: () => fixture.handoff,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Canvas() {
  const location = useLocation()
  return <p data-testid="canvas">Canvas {location.pathname}</p>
}

describe('local trial entry', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('React', React)
    fixture.handoff = null
    fixture.auth.isLoading = false
    fixture.auth.isAuthenticated = false
    fixture.setToken.mockReset().mockImplementation(() => {
      fixture.auth.isAuthenticated = true
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function renderEntry() {
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={new QueryClient()}>
            <MemoryRouter initialEntries={['/register']}>
              <LocalTrialEntry>
                <Canvas />
              </LocalTrialEntry>
            </MemoryRouter>
          </QueryClientProvider>
        </StrictMode>
      )
    })
  }

  it('opens the canvas with the existing auth token setter and consumes a pass once under StrictMode', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        type: 'bearer',
        value: 'fixture-token',
        workspaceId: '510c8741-ef2f-402c-8b8a-581c723798f9',
      })
    )
    fixture.handoff = captureLocalTrialHandoff(
      { href: `http://localhost:15173/#local-trial-session=${'a'.repeat(64)}` },
      { state: null, replaceState: vi.fn() },
      true,
      request
    )

    await renderEntry()

    expect(request).toHaveBeenCalledTimes(1)
    expect(fixture.setToken).toHaveBeenCalledExactlyOnceWith('fixture-token')
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe(
      'Canvas /w/510c8741ef2f402c8b8a581c723798f9'
    )
  })

  it('asks only for the local launcher when there is no session', async () => {
    await renderEntry()

    expect(container.textContent).toContain('No account or signup is needed.')
    expect(container.querySelector('[data-testid="canvas"]')).toBeNull()
    expect(fixture.setToken).not.toHaveBeenCalled()
  })

  it('keeps an expired handoff out of the signup flow', async () => {
    fixture.handoff = { exchange: vi.fn().mockRejectedValue(new Error('expired')) }

    await renderEntry()

    expect(container.textContent).toContain('Restart the launcher to open your canvas.')
    expect(container.querySelector('[data-testid="canvas"]')).toBeNull()
    expect(fixture.setToken).not.toHaveBeenCalled()
  })
})
