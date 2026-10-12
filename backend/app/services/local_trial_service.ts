import { inject } from '@adonisjs/core'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import User from '#models/user'
import Workspace from '#models/workspace'
import OrganizationMembership from '#models/organization_membership'
import { WorkspaceService } from '#services/workspace_service'
import UserConfigService from '#services/user_config_service'
import {
  assertLocalTrialUser,
  localTrialEmail,
  LocalTrialAccess,
  LocalTrialAccessError,
  type LocalTrialRequest,
} from '#libs/local-trial/access'

// Controllers are resolved separately for each request. Replay state must be shared.
const access = new LocalTrialAccess({
  nodeEnv: env.get('NODE_ENV'),
  enabled: env.get('KANWAS_LOCAL_TRIAL'),
  userId: env.get('KANWAS_LOCAL_TRIAL_USER_ID'),
  actorId: env.get('CHATGPT_PLAN_USER_ID'),
  bootstrapSecret: env.get('KANWAS_LOCAL_TRIAL_BOOTSTRAP_SECRET'),
  sessionSecret: env.get('KANWAS_LOCAL_TRIAL_SESSION_SECRET'),
})

@inject()
export default class LocalTrialService {
  constructor(
    private workspaceService: WorkspaceService,
    private userConfigService: UserConfigService
  ) {}

  async bootstrap(request: LocalTrialRequest, correlationId?: string) {
    const userId = access.beginBootstrap(request)
    const identity = await db.transaction(async (trx) => {
      let user = await User.query({ client: trx }).where('id', userId).forUpdate().first()
      if (user) {
        assertLocalTrialUser(user, userId)
      } else {
        user = await User.create(
          { id: userId, email: localTrialEmail(userId), name: 'Local User', password: null },
          { client: trx }
        )
      }

      const organizationIds = OrganizationMembership.query({ client: trx })
        .select('organization_id')
        .where('user_id', userId)
      let workspace = await Workspace.query({ client: trx })
        .whereIn('organization_id', organizationIds)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .forUpdate()
        .first()

      if (!workspace) {
        workspace = await this.workspaceService.createWorkspaceForUser(userId, 'Local workspace', trx, correlationId, {
          onboardingStatus: 'completed',
        })
      }
      return { userId, workspaceId: workspace.id }
    })

    const configuration = await this.userConfigService.getStoredConfig(userId)
    if (configuration.llmProvider !== 'openai' || !configuration.llmModel?.trim()) {
      const model = env.get('CHATGPT_PLAN_MODEL')?.trim()
      if (!model) {
        throw new LocalTrialAccessError(409, 'A configured ChatGPT model is required for local trial access.')
      }
      // Store the actual trial selection so the UI and inference use the same model.
      await this.userConfigService.updateConfig(userId, { llmProvider: 'openai', llmModel: model })
    }

    access.completeBootstrap(identity)
    return identity
  }

  async session(request: LocalTrialRequest) {
    const identity = access.beginSession(request)
    const user = await User.findOrFail(identity.userId)
    assertLocalTrialUser(user, identity.userId)
    const token = await User.accessTokens.create(user, ['*'], { name: 'local-trial', expiresIn: '7 days' })
    return { type: 'bearer' as const, value: token.value!.release(), workspaceId: identity.workspaceId }
  }
}
