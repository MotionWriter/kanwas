import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/** Real service imports use a disposable environment; no app .env or vendor network access. */
function runServices(source: string, overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kanwas-local-trial-test-'))
  try {
    const appFixture = `
      import 'reflect-metadata';
      import { mock } from 'node:test';
      const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} };
      mock.module('@adonisjs/core/services/app', { namedExports: { setApp() {} }, defaultExport: {
        booted: async callback => callback(),
        container: { make: async binding => binding === 'logger' ? logger : {} },
        config: { get() {} },
      }});
    `
    return spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', appFixture + source],
      {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          ENV_PATH: directory,
          NODE_ENV: 'test',
          PORT: '3333',
          APP_KEY: 'offline-test-key',
          APP_NAME: 'Kanwas',
          HOST: '127.0.0.1',
          LOG_LEVEL: 'silent',
          REDIS_HOST: '127.0.0.1',
          REDIS_PORT: '6379',
          API_SECRET: 'offline-test-secret',
          DRIVE_DISK: 'fs',
          OPENAI_AUTH_MODE: 'chatgpt-plan',
          CHATGPT_PLAN_USER_ID: 'owner',
          CHATGPT_PLAN_MODEL: 'offline-model',
          KANWAS_LOCAL_TRIAL: 'true',
          COMPOSIO_API_KEY: '',
          PARALLEL_API_KEY: '',
          ...overrides,
        },
      }
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('trial search service is lazy and rejects explicit search and extraction without any network request', () => {
  const result = runServices(`
    import assert from 'node:assert/strict';
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error('Unexpected external request'); };
    const { default: WebSearchService } = await import('./app/services/web_search_service.ts');
    const service = WebSearchService.create();
    assert.equal(service.enabled, false);
    for (const operation of [() => service.search('query'), () => service.extract(['https://example.com'])]) {
      await assert.rejects(operation, error => error.code === 'SERVICE_NOT_CONFIGURED' && error.status === 503 && /PARALLEL_API_KEY/.test(error.message));
    }
    assert.equal(requests, 0);
  `)
  assert.equal(result.status, 0, `${result.stderr}\n${result.error || ''}`)
})

test('ordinary search service still refuses missing configuration', () => {
  const result = runServices(
    `
    import assert from 'node:assert/strict';
    const { default: WebSearchService } = await import('./app/services/web_search_service.ts');
    assert.throws(() => WebSearchService.create(), /PARALLEL_API_KEY/);
  `,
    { KANWAS_LOCAL_TRIAL: 'false' }
  )
  assert.equal(result.status, 0, result.stderr)
})

test('trial skips Composio discovery and retains an actionable missing-config error for explicit integration use', () => {
  const result = runServices(`
    import assert from 'node:assert/strict';
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error('Unexpected external request'); };
    const { default: config } = await import('./config/agent.ts');
    assert.equal(config.connectedExternalTools.enabled, false);
    const { getComposioTools } = await import('./libs/agent/providers/composio.ts');
    assert.deepEqual(await getComposioTools('owner', 'workspace'), {});
    const { default: ComposioService } = await import('./app/services/composio_service.ts');
    const service = new ComposioService();
    assert.throws(() => service.assertConfigured(), error => error.code === 'SERVICE_NOT_CONFIGURED' && error.status === 503 && /COMPOSIO_API_KEY/.test(error.message));
    await assert.rejects(() => service.listConnections('owner', 'workspace'), /COMPOSIO_API_KEY/);
    assert.equal(requests, 0);
  `)
  assert.equal(result.status, 0, `${result.stderr}\n${result.error || ''}`)
})

test('trial flow omits disabled web tools and retains them when Parallel is configured', () => {
  const result = runServices(`
    import assert from 'node:assert/strict';
    const { default: WebSearchService } = await import('./app/services/web_search_service.ts');
    const { createOpenAIProvider } = await import('./libs/agent/providers/openai.ts');
    const { createProductAgentFlowDefinition } = await import('./libs/agent/flows/product_agent.ts');
    const definition = createProductAgentFlowDefinition('offline-model', createOpenAIProvider('offline-fixture'));
    const context = { providerName: 'openai', supportsNativeTools: false, webSearchService: WebSearchService.create() };
    const disabled = definition.buildTools(context);
    assert.equal(disabled.web_search, undefined);
    assert.equal(disabled.web_fetch, undefined);
    assert.ok(disabled.str_replace_based_edit_tool);
    assert.ok(disabled.bash);
    assert.ok(disabled.start_task);
    context.webSearchService = new WebSearchService('offline-fixture');
    const configured = definition.buildTools(context);
    assert.ok(configured.web_search);
    assert.ok(configured.web_fetch);
  `)
  assert.equal(result.status, 0, `${result.stderr}\n${result.error || ''}`)
})
