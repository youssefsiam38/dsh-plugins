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
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes'
import * as plugin from '../src/index.ts'
import { FakeConnection } from './harness.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  FakeConnection.current = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const BASE = [
  "- name: '@deepseek-ai/dsh-llm'",
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-session-projection'",
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-tools'",
  "- name: '@deepseek-ai/dsh-agent'",
  "- name: '@deepseek-ai/dsh-subprocess-local'",
  "- name: '@deepseek-ai/dsh-fs-local'",
  "- name: '@deepseek-ai/dsh-agent-loop'",
]

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-hunk-review-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))
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
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-workspace-changes', WorkspaceChanges],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['test-web-connection', FakeConnection],
    ['dsh-hunk-review', plugin],
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

function unloaded(loaded: Context): string[] {
  return [...loaded.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.name)
}

describe('Loader composition', () => {
  it('ships a bundle patch that inserts the plugin row', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toMatch(/- insert:\n\s+- id: hunk-review\n\s+name: dsh-hunk-review/)
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } }
      exports: Record<string, unknown>
      dependencies?: Record<string, string>
    }
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
    expect(Object.keys(manifest.exports)).toEqual(expect.arrayContaining(['.', './client']))
    expect(manifest.dependencies).toBeUndefined()
  })

  it('boots with the Web connection, the file service, and workspace changes, and registers the routes', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      ...BASE,
      "- name: '@deepseek-ai/dsh-workspace-changes'",
      "- name: 'test-web-connection'",
      '- id: hunk-review',
      '  name: dsh-hunk-review',
      '  config:',
      '    maxFiles: 50',
      '    revertWhileRunning: true',
    ])
    expect(unloaded(loaded)).toEqual([])
    expect(loaded.hunkReview.settings).toMatchObject({ maxFiles: 50, revertWhileRunning: true, messageMaxBytes: 24_000 })
    expect([...FakeConnection.current!.routes.keys()].sort()).toEqual(Object.values(plugin.ROUTES).sort())
  })

  it('registers no routes without the workspace-changes recorder', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([...BASE, "- name: 'test-web-connection'", '- id: hunk-review', '  name: dsh-hunk-review'])
    expect(unloaded(loaded)).toEqual([])
    expect(FakeConnection.current!.routes.size).toBe(0)
  })

  it('rejects invalid configuration', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([...BASE, '- id: hunk-review', '  name: dsh-hunk-review', '  config:', '    maxFiles: 0'])
    expect(loaded.get('hunkReview')).toBeUndefined()
  })
})
