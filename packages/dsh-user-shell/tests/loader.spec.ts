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
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { FakeConnection, RecordingAdapter, requestText } from './harness.ts'
import type { UserShellEvent } from '../src/types.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
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
  "- name: '@deepseek-ai/dsh-commands'",
  "- name: '@deepseek-ai/dsh-subprocess-local'",
  "- name: '@deepseek-ai/dsh-agent-loop'",
]

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-user-shell-loader-'))
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
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['test-web-connection', FakeConnection],
    ['dsh-user-shell', plugin],
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
    expect(patch).toMatch(/- insert:\n\s+- id: user-shell\n\s+name: dsh-user-shell/)
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh: { bundle: { patch: string }; client: { platform: string } }
      exports: Record<string, unknown>
    }
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(Object.keys(manifest.exports)).toEqual(expect.arrayContaining(['.', './client']))
  })

  it('boots with a Web connection, runs `!` through the route, and the next request carries the result', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      ...BASE,
      "- name: 'test-web-connection'",
      '- id: user-shell',
      '  name: dsh-user-shell',
      '  config:',
      '    timeoutSeconds: 30',
      '    enableQuiet: false',
    ])
    expect(unloaded(loaded)).toEqual([])
    expect(loaded.userShell.settings).toMatchObject({ timeoutMs: 30_000, enableQuiet: false })
    const adapter = new RecordingAdapter()
    loaded.llm.registerAdapter(['mock'], adapter)
    const cwd = root!
    const agent = await loaded.agentLoop.create(SessionId('loader-shell'), { provider: 'mock', model: 'mock' }, { cwd })
    expect(loaded.commands.find(agent, 'sh')?.name).toBe('sh')
    expect(loaded.commands.find(agent, 'shq')).toBeUndefined()

    const events: UserShellEvent[] = []
    loaded.userShell.hub.subscribe((event) => { events.push(event) })
    const connection = FakeConnection.current!
    const response = await connection.routes.get(plugin.ROUTES.run)!.fetch(new Request('http://127.0.0.1/api/user-shell/run', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'loader-shell', command: 'echo loader-ok', mode: 'context', owner: 't' }),
    }))
    expect(response.status).toBe(200)
    await expect.poll(() => events.some(event => event.type === 'end')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(adapter.requests).toHaveLength(0)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const sent = requestText(adapter.requests[0]!)
    expect(sent).toContain('loader-ok')
    expect(sent).toContain('<user_shell_command>')
    expect(sent).toContain('ask the user to run `! sudo <command>`')
  })

  it('boots without a Web connection and registers no way to run commands', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([...BASE, '- id: user-shell', '  name: dsh-user-shell'])
    expect(unloaded(loaded)).toEqual([])
    const agent = await loaded.agentLoop.create(SessionId('loader-headless'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    expect(loaded.commands.find(agent, 'sh')).toBeUndefined()
  })
})
