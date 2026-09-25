/** Boots the Host half through a real Cordis Loader config and checks what it publishes to the page. */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-model-switcher-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== 'dsh-model-switcher') throw new Error(`unexpected Loader import: ${specifier}`)
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
    expect(patch).toMatch(/- insert:\n\s+- id: model-switcher\n\s+name: dsh-model-switcher/)
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } }
      exports: Record<string, unknown>
      keywords: string[]
    }
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-model-selection')
    expect(Object.keys(manifest.exports)).toEqual(expect.arrayContaining(['.', './client']))
    expect(manifest.keywords).toEqual(expect.arrayContaining(['dsh-plugin', 'deepseek-harness']))
  })

  it('publishes the default settings to the page', async () => {
    const loaded = await loadYaml(['- id: model-switcher', '  name: dsh-model-switcher'])
    expect(unloaded(loaded)).toEqual([])
    expect(failed(loaded)).toEqual([])
    expect(published(loaded)).toEqual([{ kind: 'global', name: SETTINGS_GLOBAL, value: DEFAULT_SETTINGS }])
  })

  it('publishes configured settings', async () => {
    const loaded = await loadYaml([
      '- id: model-switcher',
      '  name: dsh-model-switcher',
      '  config:',
      '    priority: -2',
      '    initialFocus: providers',
      '    recentLimit: 0',
      '    metadata: false',
      '    providerIcons:',
      '      acme: https://example.com/acme.svg',
    ])
    expect(unloaded(loaded)).toEqual([])
    expect(published(loaded)).toMatchObject([{ kind: 'global', name: SETTINGS_GLOBAL }])
    expect((published(loaded)[0] as { value?: unknown }).value).toEqual({
      priority: -2, initialFocus: 'providers', recentLimit: 0, metadata: false, providerStatus: true,
      providerIcons: { acme: 'https://example.com/acme.svg' },
    })
  })

  it.each([
    ['a priority that would not shadow the stock control', ['    priority: 0']],
    ['an unknown focus target', ['    initialFocus: effort']],
    ['a script URL as a logo', ['    providerIcons:', '      acme: "javascript:alert(1)"']],
  ])('refuses %s', async (_label, config) => {
    const loaded = await loadYaml(['- id: model-switcher', '  name: dsh-model-switcher', '  config:', ...config])
    expect(failed(loaded)).toEqual(['dsh-model-switcher'])
    expect(published(loaded)).toEqual([])
  })
})

describe('generated provider marks', () => {
  it('match the pinned simple-icons release', () => {
    const script = fileURLToPath(new URL('../scripts/marks.mjs', import.meta.url))
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow()
  })
})
