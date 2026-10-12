/** An optional local-trial capability was explicitly requested without configuration. */
export class MissingServiceConfigurationError extends Error {
  readonly status = 503
  readonly code = 'SERVICE_NOT_CONFIGURED'

  constructor(service: string, variable: string) {
    super(`${service} is unavailable because ${variable} is not configured.`)
    this.name = 'MissingServiceConfigurationError'
  }
}
