import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import LocalTrialService from '#services/local_trial_service'
import { LocalTrialAccessError, type LocalTrialRequest } from '#libs/local-trial/access'
import { handleWorkspaceSeedFailure } from '#controllers/helpers/workspace_seed_failure'

function trialRequest(request: HttpContext['request']): LocalTrialRequest {
  return {
    // Never trust X-Forwarded-For for this launcher-only boundary.
    remoteAddress: request.request.socket.remoteAddress,
    host: request.header('host'),
    origin: request.header('origin'),
    secret: request.header('x-kanwas-local-trial'),
  }
}

@inject()
export default class LocalTrialController {
  constructor(private localTrialService: LocalTrialService) {}

  async bootstrap({ request, response, correlationId, logger }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    try {
      return await this.localTrialService.bootstrap(trialRequest(request), correlationId)
    } catch (error) {
      if (error instanceof LocalTrialAccessError) {
        return response.status(error.status).send({ error: error.message })
      }
      if (handleWorkspaceSeedFailure(error, response)) return
      // Do not let development debug responses echo the request's launcher secret.
      logger.error({ operation: 'local_trial_bootstrap_failed' }, 'Local trial setup failed')
      return response.serviceUnavailable({ error: 'Local trial setup failed. Restart the launcher.' })
    }
  }

  async session({ request, response, logger }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    try {
      return await this.localTrialService.session(trialRequest(request))
    } catch (error) {
      if (error instanceof LocalTrialAccessError) {
        return response.status(error.status).send({ error: error.message })
      }
      logger.error({ operation: 'local_trial_session_failed' }, 'Local trial session failed')
      return response.serviceUnavailable({ error: 'Local trial session failed. Restart the launcher.' })
    }
  }
}
