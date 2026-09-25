/** Boots the plugin through a real Cordis Loader config beside the published dsh packages it needs. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import type { CompareRecord } from '../src/types.ts'
import { FakeConnection, FakeController, FakeWorkspaces, lastUserText, ScriptedAdapter, settle } from './harness.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: (dir: string) => readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-model-compare-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines(root), ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['test-web-connection', FakeConnection],
    ['test-session-controller', FakeController],
    ['test-workspaces', FakeWorkspaces],
    ['dsh-model-compare', plugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

const BASE = (dir: string): string[] => [
  "- name: '@deepseek-ai/dsh-llm'",
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-session-projection'",
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-tools'",
  "- name: '@deepseek-ai/dsh-agent'",
  "- name: '@deepseek-ai/dsh-agent-loop'",
  "- name: '@deepseek-ai/dsh-storage'",
  "- name: '@deepseek-ai/dsh-storage-json'",
  '  config:',
  `    root: ${JSON.stringify(join(dir, 'storages'))}`,
  "- name: '@deepseek-ai/dsh-storage-domain'",
  '  config:',
  '    backend: json',
]

function unloaded(loaded: Context): string[] {
  return [...loaded.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.name)
}

describe('Loader composition', () => {
  it('ships a bundle patch that inserts the plugin row', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toMatch(/- insert:\n\s+- id: model-compare\n\s+name: dsh-model-compare/)
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh: { bundle: { patch: string }; client: { platform: string } }
      exports: Record<string, unknown>
    }
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(Object.keys(manifest.exports)).toEqual(expect.arrayContaining(['.', './client']))
  })

  it('boots with the Web services, runs a comparison with the configured policy, and keeps the source untouched', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml(dir => [
      ...BASE(dir),
      "- name: 'test-web-connection'",
      "- name: 'test-session-controller'",
      "- name: 'test-workspaces'",
      '- id: model-compare',
      '  name: dsh-model-compare',
      '  config:',
      '    maxModels: 3',
      '    maxOutputTokens: 1000',
      '    tools: read-only',
      '    readOnlyTools: [read]',
    ])
    expect(unloaded(loaded)).toEqual([])
    expect(loaded.modelCompare.settings).toMatchObject({ maxModels: 3, maxOutputTokens: 1000, tools: 'read-only', readOnlyTools: ['read'] })
    const adapter = new ScriptedAdapter()
    loaded.llm.registerAdapter(['mock'], adapter)
    const source = await loaded.agents.create({ sessionId: SessionId('loader-source'), agentOptions: { provider: 'mock', model: 'alpha' }, meta: { cwd: root! } })
    source.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await source.agent.whenIdle()

    const route = FakeConnection.current!.routes.get(plugin.ROUTES.start)!
    const response = await route.fetch(new Request('http://127.0.0.1/api/model-compare/start', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'loader-source', prompt: 'which is best?', models: [{ provider: 'mock', model: 'alpha' }, { provider: 'mock', model: 'gamma' }] }),
    }))
    expect(response.status).toBe(200)
    const record = (await response.json() as { compare: CompareRecord }).compare
    await settle(record.lanes.map(lane => loaded.agents.get(SessionId(lane.sessionId))))
    const laneRequests = adapter.requests.filter(request => lastUserText(request) === 'which is best?')
    expect(laneRequests.map(request => request.model).sort()).toEqual(['alpha', 'gamma'])
    for (const request of laneRequests) {
      expect(request.maxTokens).toBe(1000)
      expect(request.tools ?? []).toEqual([])
    }
    expect(adapter.requests.filter(request => lastUserText(request) === 'hello')).toHaveLength(1)
  })

  it('boots without the Web connection and registers no routes', { timeout: 60_000 }, async () => {
    FakeConnection.current = undefined
    const loaded = await loadYaml(dir => [...BASE(dir), '- id: model-compare', '  name: dsh-model-compare'])
    expect(unloaded(loaded)).toEqual([])
    expect(loaded.modelCompare.settings.tools).toBe('none')
    expect(FakeConnection.current).toBeUndefined()
  })

  it('refuses an out-of-range model count at load', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml(dir => [...BASE(dir), '- id: model-compare', '  name: dsh-model-compare', '  config:', '    maxModels: 9'])
    expect(loaded.get('modelCompare')).toBeUndefined()
  })
})
