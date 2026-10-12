export const LOCAL_TRIAL_FRAGMENT_KEY = 'local-trial-session'

export interface LocalTrialSession {
  type: 'bearer'
  value: string
  workspaceId: string
}

export interface LocalTrialHandoff {
  exchange: (apiBaseUrl: string) => Promise<LocalTrialSession>
}

const PASS_PATTERN = /^[a-f0-9]{64}$/
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SESSION_ERROR = 'The local session could not be opened. Restart the local launcher to get a fresh session.'

function isLoopbackUrl(url: URL): boolean {
  return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

/** Remove the one-use pass before loading the app, including analytics and routing. */
export function captureLocalTrialHandoff(
  location: Pick<Location, 'href'>,
  history: Pick<History, 'replaceState' | 'state'>,
  enabled: boolean,
  request: typeof fetch = fetch
): LocalTrialHandoff | null {
  const url = new URL(location.href)
  const fragment = new URLSearchParams(url.hash.slice(1))
  const values = fragment.getAll(LOCAL_TRIAL_FRAGMENT_KEY)
  if (values.length === 0) {
    return null
  }

  fragment.delete(LOCAL_TRIAL_FRAGMENT_KEY)
  url.hash = fragment.toString()
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)

  if (!enabled) {
    return null
  }

  let pass = values.length === 1 && PASS_PATTERN.test(values[0]) && isLoopbackUrl(url) ? values[0] : null
  let exchangePromise: Promise<LocalTrialSession> | null = null

  return {
    exchange(apiBaseUrl) {
      if (exchangePromise) {
        return exchangePromise
      }

      const sessionPass = pass
      pass = null
      exchangePromise = (async () => {
        if (!sessionPass) {
          throw new Error(SESSION_ERROR)
        }

        try {
          const endpoint = new URL('/local-trial/session', apiBaseUrl)
          if (!isLoopbackUrl(endpoint)) {
            throw new Error(SESSION_ERROR)
          }

          const response = await request(endpoint.toString(), {
            method: 'POST',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            headers: { 'X-Kanwas-Local-Trial': sessionPass },
          })
          if (!response.ok) {
            throw new Error(SESSION_ERROR)
          }

          const session: unknown = await response.json()
          if (!session || typeof session !== 'object') {
            throw new Error(SESSION_ERROR)
          }
          const candidate = session as Partial<LocalTrialSession>
          if (
            candidate.type !== 'bearer' ||
            typeof candidate.value !== 'string' ||
            !candidate.value ||
            typeof candidate.workspaceId !== 'string' ||
            !UUID_PATTERN.test(candidate.workspaceId)
          ) {
            throw new Error(SESSION_ERROR)
          }

          return candidate as LocalTrialSession
        } catch {
          // Do not surface response payloads, URLs, or headers that may contain credentials.
          throw new Error(SESSION_ERROR)
        }
      })()

      // Both success and failure are retained so remounts cannot replay a consumed pass.
      return exchangePromise
    },
  }
}

let initialHandoff: LocalTrialHandoff | null = null

export function initializeLocalTrialHandoff(enabled: boolean): void {
  initialHandoff = captureLocalTrialHandoff(window.location, window.history, enabled)
}

export function getLocalTrialHandoff(): LocalTrialHandoff | null {
  return initialHandoff
}

export const isLocalTrial = import.meta.env.DEV && import.meta.env.VITE_LOCAL_TRIAL === 'true'
