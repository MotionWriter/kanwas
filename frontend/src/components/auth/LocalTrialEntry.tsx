import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { baseURL } from '@/api/client'
import { getLocalTrialHandoff, isLocalTrial } from '@/lib/localTrialSession'
import { useAuth, useAuthState } from '@/providers/auth'
import { toUrlUuid } from '@/utils/uuid'

/** The launcher provides a fresh local session; ordinary backend authorization still applies. */
export function LocalTrialEntry({ children }: { children: ReactNode }) {
  const { setToken } = useAuth()
  const { isAuthenticated, isLoading } = useAuthState()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)
  const handoff = getLocalTrialHandoff()

  useEffect(() => {
    if (!isLocalTrial || !handoff || isLoading || opened) {
      return
    }

    let active = true
    void handoff.exchange(baseURL).then(
      (session) => {
        if (!active) return
        queryClient.clear()
        setToken(session.value)
        setOpened(true)
        navigate(`/w/${toUrlUuid(session.workspaceId)}`, { replace: true })
      },
      () => {
        if (!active) return
        setError('The local session expired or could not be opened. Restart the launcher to open your canvas.')
      }
    )

    return () => {
      active = false
    }
  }, [handoff, isLoading, navigate, opened, queryClient, setToken])

  if (!isLocalTrial) {
    return <>{children}</>
  }

  if (error || (!isLoading && !isAuthenticated && (!handoff || opened))) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background text-foreground px-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-xl font-semibold">Open your local canvas</h1>
          <p className="text-muted-foreground">
            {error ?? 'Start the local launcher to open your workspace. No account or signup is needed.'}
          </p>
          <p className="text-sm">Double-click start_kanwas.command.</p>
        </div>
      </main>
    )
  }

  if (isLoading || (handoff && !opened)) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <p role="status">Opening your local canvas...</p>
      </main>
    )
  }

  return <>{children}</>
}
