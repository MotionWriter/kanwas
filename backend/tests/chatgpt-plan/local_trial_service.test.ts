import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/** Exercise the real service with transactional DB/Yjs fixtures, never the local trial database. */
function runService(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'kanwas-trial-session-test-'))
  const fixture = `
    import 'reflect-metadata';
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const userId = '05325118-913f-4073-a354-736b7fe66c02';
    const workspaceId = 'b935fb2d-c30c-4c81-9693-91a57c8a2210';
    const request = { remoteAddress:'127.0.0.1', host:'localhost:3333', secret:'a'.repeat(64) };
    const sessionRequest = { ...request, origin:'http://localhost:15173', secret:'b'.repeat(64) };
    const configuration = {
      NODE_ENV:'development', KANWAS_LOCAL_TRIAL:true, KANWAS_LOCAL_TRIAL_USER_ID:userId,
      CHATGPT_PLAN_USER_ID:userId, CHATGPT_PLAN_MODEL:'configured-subscription-model', KANWAS_LOCAL_TRIAL_BOOTSTRAP_SECRET:'a'.repeat(64),
      KANWAS_LOCAL_TRIAL_SESSION_SECRET:'b'.repeat(64),
    };
    mock.module('#start/env', { defaultExport:{get:key=>configuration[key]} });
    let state = {users:[], workspaces:[], memberships:[]};
    const trx = {};
    const calls = { workspace:0, user:0, token:0, configuration:0 };
    let seedFails = false;
    let userConfiguration = {dismissedTipIds:['existing-tip']};
    class Query {
      constructor(table) { this.table = table; this.filters = []; }
      select() { return this; }
      where(key,value) { this.filters.push(row=>row[key]===value); return this; }
      forUpdate() { return this; }
      orderBy() { return this; }
      whereIn(key,subquery) {
        const permitted = state[subquery.table].filter(row=>subquery.filters.every(filter=>filter(row))).map(row=>row.organization_id);
        this.filters.push(row=>permitted.includes(row[key]));
        return this;
      }
      async first() { return state[this.table].find(row=>this.filters.every(filter=>filter(row))) ?? null; }
    }
    class FixtureUser {
      static query(options) { assert.equal(options.client,trx); return new Query('users'); }
      static async create(values,options) {
        assert.equal(options.client,trx); calls.user++; state.users.push(values); return values;
      }
      static async findOrFail(id) { const user = state.users.find(row=>row.id===id); assert.ok(user); return user; }
      static accessTokens = { async create(user,abilities,options) {
        assert.equal(user.id,userId); assert.deepEqual(abilities,['*']);
        assert.deepEqual(options,{name:'local-trial',expiresIn:'7 days'});
        calls.token++; return {value:{release:()=> 'offline-fixture-session'}};
      }};
    }
    class FixtureWorkspace { static query(options) { assert.equal(options.client,trx); return new Query('workspaces'); }}
    class FixtureMembership { static query(options) { assert.equal(options.client,trx); return new Query('memberships'); }}
    class FixtureWorkspaceService {
      async createWorkspaceForUser(owner,name,client,correlation,options) {
        calls.workspace++; assert.equal(owner,userId); assert.equal(client,trx);
        assert.equal(name,'Local workspace'); assert.equal(correlation,'fixture-correlation');
        assert.deepEqual(options,{onboardingStatus:'completed'});
        state.memberships.push({user_id:userId,organization_id:'fixture-org'});
        state.workspaces.push({id:workspaceId,organization_id:'fixture-org'});
        if (seedFails) throw new Error('Yjs durability refused fixture');
        return state.workspaces.at(-1);
      }
    }
    class FixtureUserConfigService {
      async getStoredConfig(owner) { assert.equal(owner,userId); return {...userConfiguration}; }
      async updateConfig(owner,updates) { assert.equal(owner,userId); calls.configuration++; userConfiguration={...userConfiguration,...updates}; return userConfiguration; }
    }
    mock.module('#models/user',{defaultExport:FixtureUser});
    mock.module('#models/workspace',{defaultExport:FixtureWorkspace});
    mock.module('#models/organization_membership',{defaultExport:FixtureMembership});
    mock.module('#services/workspace_service',{namedExports:{WorkspaceService:FixtureWorkspaceService,WorkspaceSeedFailedError:class extends Error {}}});
    mock.module('#services/user_config_service',{defaultExport:FixtureUserConfigService});
    mock.module('@adonisjs/lucid/services/db',{defaultExport:{async transaction(callback) {
      const before = structuredClone(state);
      try { return await callback(trx); } catch(error) {state=before; throw error;}
    }}});
    const {default:LocalTrialService} = await import('./app/services/local_trial_service.ts');
    const service = new LocalTrialService(new FixtureWorkspaceService(),new FixtureUserConfigService());
  `
  try {
    return spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', fixture + source],
      {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, ENV_PATH: directory, NODE_ENV: 'test' },
      }
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('automatic setup seeds the canonical workspace and hands the browser a normal expiring session', () => {
  const result = runService(`
    const identity = await service.bootstrap(request,'fixture-correlation');
    assert.deepEqual(identity,{userId,workspaceId});
    assert.equal(identity.value,undefined);
    assert.deepEqual(state.users,[{id:userId,email:'local-'+userId+'@kanwas.invalid',name:'Local User',password:null}]);
    assert.equal(calls.workspace,1);
    assert.equal(calls.token,0);
    assert.deepEqual(userConfiguration,{dismissedTipIds:['existing-tip'],llmProvider:'openai',llmModel:'configured-subscription-model'});
    const secondControllerService = new LocalTrialService(new FixtureWorkspaceService(),new FixtureUserConfigService());
    const session = await secondControllerService.session(sessionRequest);
    assert.deepEqual(session,{type:'bearer',value:'offline-fixture-session',workspaceId});
    assert.equal(calls.token,1);
    await assert.rejects(()=>service.session(sessionRequest),error=>error.status===409);
    assert.equal(calls.token,1);
  `)
  assert.equal(result.status, 0, `${result.stderr}\n${result.error || ''}`)
})

test('restart reuses only the existing synthetic owner and a workspace authorized by organization membership', () => {
  const result = runService(`
    state.users.push({id:userId,email:'local-'+userId+'@kanwas.invalid',name:'My custom name',password:null});
    state.workspaces.push({id:'foreign-workspace',organization_id:'foreign-org'});
    state.workspaces.push({id:workspaceId,organization_id:'fixture-org'});
    state.memberships.push({user_id:userId,organization_id:'fixture-org'});
    userConfiguration={dismissedTipIds:['existing-tip'],llmProvider:'openai',llmModel:'selected-model',reasoningEffort:'high'};
    assert.deepEqual(await service.bootstrap(request,'fixture-correlation'),{userId,workspaceId});
    assert.equal(calls.workspace,0);
    assert.equal(calls.user,0);
    assert.equal(calls.configuration,0);
    assert.equal(state.users[0].name,'My custom name');
    assert.equal(userConfiguration.llmModel,'selected-model');
  `)
  assert.equal(result.status, 0, `${result.stderr}\n${result.error || ''}`)
})

test('automatic setup refuses an existing real-email owner without creating a workspace or issuing any session', () => {
  const result = runService(`
    state.users.push({id:userId,email:'real-person@example.com',name:'Real User',password:null});
    await assert.rejects(()=>service.bootstrap(request,'fixture-correlation'),error=>error.status===409);
    await assert.rejects(()=>service.session(sessionRequest),error=>error.status===409);
    assert.equal(calls.workspace,0);
    assert.equal(calls.token,0);
    assert.equal(calls.configuration,0);
    assert.equal(state.users[0].email,'real-person@example.com');
  `)
  assert.equal(result.status, 0, `${result.stderr}\n${result.error || ''}`)
})

test('existing trial owners without a model receive the configured subscription model for accurate UI and inference', () => {
  const result = runService(`
    state.users.push({id:userId,email:'local-'+userId+'@kanwas.invalid',name:'Local User',password:null});
    state.workspaces.push({id:workspaceId,organization_id:'fixture-org'});
    state.memberships.push({user_id:userId,organization_id:'fixture-org'});
    userConfiguration={dismissedTipIds:['existing-tip'],llmProvider:'openai',llmModel:null,reasoningEffort:'high'};
    assert.deepEqual(await service.bootstrap(request,'fixture-correlation'),{userId,workspaceId});
    assert.equal(calls.configuration,1);
    assert.equal(userConfiguration.llmModel,'configured-subscription-model');
    assert.equal(userConfiguration.reasoningEffort,'high');
    assert.deepEqual(userConfiguration.dismissedTipIds,['existing-tip']);
    assert.equal(calls.workspace,0);
  `)
  assert.equal(result.status, 0, `${result.stderr}\n${result.error || ''}`)
})

test('failed canonical Yjs seeding rolls back provisional identity and membership and never enables a browser session', () => {
  const result = runService(`
    seedFails=true;
    await assert.rejects(()=>service.bootstrap(request,'fixture-correlation'),/Yjs durability/);
    assert.deepEqual(state,{users:[],workspaces:[],memberships:[]});
    await assert.rejects(()=>service.session(sessionRequest),error=>error.status===409);
    await assert.rejects(()=>service.bootstrap(request,'fixture-correlation'),error=>error.status===409);
    assert.equal(calls.token,0);
    assert.equal(calls.configuration,0);
  `)
  assert.equal(result.status, 0, `${result.stderr}\n${result.error || ''}`)
})

test('the HTTP boundary uses the raw peer and never exposes launcher headers through development error responses', () => {
  const result = runService(`
    const {default:LocalTrialController} = await import('./app/controllers/local_trial_controller.ts');
    const logs = [];
    function context(remoteAddress='127.0.0.1') {
      const headers = {'host':'localhost:3333','x-kanwas-local-trial':'a'.repeat(64),'x-forwarded-for':'127.0.0.1'};
      const response = {
        statusCode:200, body:null, headers:{},
        header(key,value) {this.headers[key]=value;return this;},
        status(value) {this.statusCode=value;return this;},
        send(body) {this.body=body;return body;},
        serviceUnavailable(body) {this.statusCode=503;return this.send(body);},
      };
      return {
        correlationId:'fixture-correlation',response,
        request:{header:key=>headers[key],ip:()=> '127.0.0.1',request:{socket:{remoteAddress}}},
        logger:{error:(...details)=>logs.push(details)},
      };
    }
    const controller = new LocalTrialController(service);
    const foreignPeer = context('192.168.1.100');
    await controller.bootstrap(foreignPeer);
    assert.equal(foreignPeer.response.statusCode,403);
    assert.equal(calls.workspace,0);
    assert.equal(foreignPeer.response.headers['Cache-Control'],'no-store');
    assert.deepEqual(await controller.bootstrap(context()),{userId,workspaceId});
    const failure = new Error('Unexpected failure with '+request.secret+' and '+sessionRequest.secret);
    const failingController = new LocalTrialController({async bootstrap() {throw failure;},async session() {throw failure;}});
    const bootstrapFailure = context();
    await failingController.bootstrap(bootstrapFailure);
    assert.equal(bootstrapFailure.response.statusCode,503);
    const sessionFailure = context();
    await failingController.session(sessionFailure);
    assert.equal(sessionFailure.response.statusCode,503);
    const exposed = JSON.stringify([bootstrapFailure.response.body,sessionFailure.response.body,logs]);
    assert.ok(!exposed.includes(request.secret));
    assert.ok(!exposed.includes(sessionRequest.secret));
  `)
  assert.equal(result.status, 0, `${result.stderr}\n${result.error || ''}`)
})
