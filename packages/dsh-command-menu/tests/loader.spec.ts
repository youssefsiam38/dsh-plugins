/** Boots the Host half through a real Cordis Loader config and checks what it publishes to the page. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as plugin from '../src/index.ts'
import { DEFAULT_SETTINGS, SETTINGS_GLOBAL } from '../src/settings.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-command-menu-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== 'dsh-command-menu') throw new Error(`unexpected Loader import: ${specifier}`)
      return plugin
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

function unloaded(loaded: Context): string[] {
  return [...loaded.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.name)
}

/** Rows whose fiber is in Cordis's error state (3), e.g. after config validation failed. */
function failed(loaded: Context): string[] {
  return [...loaded.loader.entries()].filter(entry => (entry.fiber as { state?: number } | undefined)?.state === 3).map(entry => entry.options.name)
}

function published(loaded: Context): IndexInjection[] {
  const table: IndexInjection[] = []
  loaded.emit('webserver/index-inject', table)
  return table
}

describe('Loader composition', () => {
  it('ships a bundle patch that inserts the plugin row and a web client manifest', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toMatch(/- insert:\n\s+- id: command-menu\n\s+name: dsh-command-menu/)
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } }
      exports: Record<string, unknown>
      keywords: string[]
    }
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.client.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-workspace',
    ]))
    expect(Object.keys(manifest.exports)).toEqual(expect.arrayContaining(['.', './client']))
    expect(manifest.keywords).toEqual(expect.arrayContaining(['dsh-plugin', 'deepseek-harness']))
  })

  it('publishes the default settings to the page', async () => {
    const loaded = await loadYaml(['- id: command-menu', '  name: dsh-command-menu'])
    expect(unloaded(loaded)).toEqual([])
    expect(failed(loaded)).toEqual([])
    expect(published(loaded)).toEqual([{ kind: 'global', name: SETTINGS_GLOBAL, value: DEFAULT_SETTINGS }])
  })

  it('publishes configured settings', async () => {
    const loaded = await loadYaml([
      '- id: command-menu',
      '  name: dsh-command-menu',
      '  config:',
      '    hotkeys: [Mod+K, Ctrl+Shift+P]',
      '    recentLimit: 0',
      '    groupLimit: 12',
      '    messageSearch: false',
    ])
    expect(unloaded(loaded)).toEqual([])
    expect((published(loaded)[0] as { value?: unknown }).value).toEqual({
      hotkeys: ['Mod+K', 'Ctrl+Shift+P'], recentLimit: 0, groupLimit: 12, messageSearch: false,
    })
  })

  it.each([
    ['a hotkey with no key', ['    hotkeys: [Mod+]']],
    ['an unknown modifier', ['    hotkeys: [Hyper+K]']],
    ['too many recents', ['    recentLimit: 99']],
    ['an empty group', ['    groupLimit: 0']],
  ])('refuses %s', async (_label, config) => {
    const loaded = await loadYaml(['- id: command-menu', '  name: dsh-command-menu', '  config:', ...config])
    expect(failed(loaded)).toEqual(['dsh-command-menu'])
    expect(published(loaded)).toEqual([])
  })
})
