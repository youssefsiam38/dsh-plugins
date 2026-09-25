/**
 * Browser test against a real dsh Web server. It installs the packed plugin
 * and test-only model routes into a throwaway `DSH_HOME` with
 * `dsh plugin add`, boots the `web` profile, and drives Chromium through the
 * picker: search, keyboard selection, the provider stage, effort, favorites,
 * the narrow-screen sheet, and removal (the stock control comes back).
 *
 * Choose the dsh to test with:
 * - nothing: `npx -y @deepseek-ai/dsh@<version>` from npm, where the version is
 *   `DSH_E2E_VERSION` or the pinned `@deepseek-ai/dsh-*` dev dependency;
 * - `DSH_E2E_CHECKOUT=/path/to/deepseek-harness` runs `pnpm -s dsh` in a built checkout;
 * - `DSH_E2E_BIN="npx -y @deepseek-ai/dsh@next"` runs any other launcher.
 * `DSH_E2E_MEDIA=<dir>` saves screenshots and a recording of the run there.
 */

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACTS = join(PACKAGE_DIR, '..', '..', '.artifacts')
const FIXTURE = join(PACKAGE_DIR, 'e2e', 'model-fixture')
const MEDIA = process.env['DSH_E2E_MEDIA']

/**
 * dsh version the default launcher runs: `DSH_E2E_VERSION`, else the pinned
 * `@deepseek-ai/dsh-*` dev dependency of this package.
 */
function dshVersion(): string {
  const fromEnv = process.env['DSH_E2E_VERSION']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> }
  const pinned = Object.entries(manifest.devDependencies ?? {}).find(([name]) => name.startsWith('@deepseek-ai/dsh-'))?.[1]
  if (pinned === undefined) throw new Error('no pinned @deepseek-ai/dsh-* dev dependency; set DSH_E2E_VERSION')
  return pinned
}

function launcher(): { command: string; args: string[]; cwd?: string } {
  const checkout = process.env['DSH_E2E_CHECKOUT']
  if (checkout !== undefined && checkout !== '') return { command: 'pnpm', args: ['-s', 'dsh'], cwd: checkout }
  const bin = process.env['DSH_E2E_BIN']
  if (bin !== undefined && bin !== '') {
    const [command, ...args] = bin.split(/\s+/)
    return { command: command!, args }
  }
  return { command: 'npx', args: ['-y', `@deepseek-ai/dsh@${dshVersion()}`] }
}

const dsh = launcher()

/**
 * Acknowledge stock dsh's first-run welcome notice in the profile's user patch
 * layer, so its modal does not cover the page.
 */
async function acknowledgeWelcome(home: string): Promise<void> {
  await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '  config:',
    '    welcomeNoticeVersion: 2026-08-13.1',
    '',
  ].join('\n'))
}

async function packedTarball(): Promise<string> {
  const name = (await readdir(ARTIFACTS)).filter(file => /^dsh-model-switcher-.*\.tgz$/.test(file)).sort().at(-1)
  if (name === undefined) throw new Error('run `pnpm run pack:tarball` first')
  return join(ARTIFACTS, name)
}

function runDsh(home: string, args: string[]): void {
  const result = spawnSync(dsh!.command, [...dsh!.args, ...args], {
    cwd: dsh!.cwd, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000,
  })
  if (result.status !== 0) throw new Error(`dsh ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
}

interface Served {
  readonly child: ChildProcess
  readonly url: string
  output(): string
}

function serve(home: string, overlay: string): Promise<Served> {
  const child = spawn(dsh!.command, [...dsh!.args, '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], {
    cwd: dsh!.cwd, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => { reject(new Error(`dsh web did not start:\n${output}`)) }, 120_000)
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      const url = /dsh web: (http:\/\/\S+)/.exec(output)?.[1]
      if (url !== undefined) {
        clearTimeout(timer)
        resolve({ child, url, output: () => output })
      }
    }
    child.stdout!.on('data', read)
    child.stderr!.on('data', read)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited with ${String(code)}:\n${output}`))
    })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error: unknown) {
    // The server group already exited.
    void error
    return
  }
  await exited
}

const COMPOSER = '[data-composer-input][contenteditable="true"]'
const TRIGGER = '[data-model-switcher-trigger]'
const PANEL = '[data-model-switcher-panel]'

async function send(page: Page, text: string): Promise<void> {
  const input = page.locator(COMPOSER)
  await input.waitFor({ timeout: 30_000 })
  await input.fill(text)
  await input.press('Enter')
  await page.waitForFunction(() => document.querySelector('[data-composer-input]')?.textContent === '', undefined, { timeout: 30_000 })
}

/** Close the stock first-run dialogs (welcome notice, credential step) that npm builds show. */
async function dismissNotices(page: Page): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const button = page.getByRole('dialog').getByRole('button', { name: /^(Continue|Configure later|Later|Skip)$/ })
    try {
      await button.first().click({ timeout: 4000 })
    } catch (error: unknown) {
      // No (further) dialog: the page is ready.
      void error
      return
    }
  }
}

async function focusedAttr(page: Page, attribute: string): Promise<boolean> {
  return page.evaluate(name => document.activeElement?.hasAttribute(name) ?? false, attribute)
}

async function shot(page: Page, name: string): Promise<void> {
  if (MEDIA !== undefined) await page.screenshot({ path: join(MEDIA, `${name}.png`) })
}

describe('model switcher in the dsh Web UI', () => {
  let home: string
  let overlay: string
  let server: Served | undefined
  let browser: Browser
  let context: BrowserContext
  let page: Page

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-model-switcher-e2e-'))
    overlay = join(home, 'e2e-overlay.yml')
    await writeFile(overlay, ['- id: agent-default-model', '  config:', '    provider: demo-local', '    model: echo', ''].join('\n'))
    runDsh(home, ['plugin', '--profile', 'web', 'add', await packedTarball()])
    runDsh(home, ['plugin', '--profile', 'web', 'add', FIXTURE])
    await acknowledgeWelcome(home)
    server = await serve(home, overlay)
    browser = await chromium.launch()
    if (MEDIA !== undefined) await mkdir(MEDIA, { recursive: true })
    context = await browser.newContext({
      locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 860 }, colorScheme: 'dark',
      ...MEDIA === undefined ? {} : { recordVideo: { dir: MEDIA, size: { width: 1280, height: 860 } } },
    })
    page = await context.newPage()
    await page.goto(server.url, { waitUntil: 'load' })
    await page.locator(COMPOSER).waitFor({ timeout: 60_000 })
    await dismissNotices(page)
  }, 600_000)

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    if (server !== undefined) await stop(server.child)
    if (process.env['DSH_E2E_KEEP_HOME'] === undefined) await rm(home, { recursive: true, force: true })
    else console.log(`DSH_HOME kept at ${home}`)
  })

  it('replaces the stock control and selects a model by fuzzy search and keyboard', async () => {
    onTestFailed(async () => {
      await page.screenshot({ path: join(tmpdir(), 'dsh-model-switcher-e2e-select.png') })
      await writeFile(join(tmpdir(), 'dsh-model-switcher-e2e-server.log'), server?.output() ?? '')
    })
    // A session exists after the first message; the seat is session-scoped.
    await send(page, 'hello')
    await page.getByText('Answered: hello | route=demo-local/echo effort=none').waitFor({ timeout: 60_000 })
    const trigger = page.locator(TRIGGER)
    await trigger.waitFor({ timeout: 30_000 })
    expect(await page.locator('button[aria-haspopup="menu"][aria-label^="Select model"]').count()).toBe(0)
    await expect.poll(() => trigger.innerText()).toContain('Echo')

    await trigger.click()
    const panel = page.locator(PANEL)
    await panel.waitFor()
    expect(await focusedAttr(page, 'data-model-switcher-search')).toBe(true)
    // Metadata and status come from the Host: context windows, vision, reasoning, key status.
    const gpt = panel.locator('[role="option"][data-model="openai/gpt-demo"]').first()
    await gpt.getByText('400K').waitFor({ timeout: 30_000 })
    await gpt.getByText('Vision').waitFor()
    await gpt.getByText('Reasoning').waitFor()
    await shot(page, 'picker-open')
    if (MEDIA !== undefined) {
      await page.emulateMedia({ colorScheme: 'light' })
      await shot(page, 'picker-open-light')
      await page.emulateMedia({ colorScheme: 'dark' })
    }

    await page.keyboard.type('sonic', { delay: 60 })
    await expect.poll(() => panel.getByRole('listbox', { name: 'Models' }).getByRole('option').count()).toBe(1)
    await shot(page, 'picker-search')
    await page.keyboard.press('Enter')
    await panel.waitFor({ state: 'detached' })
    await expect.poll(() => trigger.innerText()).toContain('Sonic Mistral (demo)')
    expect(await focusedAttr(page, 'data-model-switcher-trigger')).toBe(true)

    await send(page, 'which route?')
    await page.getByText('Answered: which route? | route=demo-openrouter/mistralai/sonic-demo effort=none').waitFor({ timeout: 60_000 })
  }, 300_000)

  it('narrows to a provider in the first stage and hands focus to the model search', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-model-switcher-e2e-provider.png') }) })
    await page.locator(TRIGGER).click()
    const panel = page.locator(PANEL)
    await panel.waitFor()
    // Recent now lists the model just picked.
    await panel.locator('[data-section="recents"] [data-model="mistralai/sonic-demo"]').waitFor()
    await page.keyboard.press('Shift+Tab')
    expect(await focusedAttr(page, 'data-model-switcher-provider-search')).toBe(true)
    const providers = panel.getByRole('listbox', { name: 'Provider' })
    await providers.waitFor()
    await providers.locator('[data-provider="demo-anthropic"]').getByText('2 models').waitFor()
    await providers.locator('[data-provider="demo-anthropic"] [data-status="ready"]').waitFor()
    await page.keyboard.type('anth', { delay: 60 })
    await shot(page, 'picker-providers')
    await page.keyboard.press('Enter')
    expect(await focusedAttr(page, 'data-model-switcher-search')).toBe(true)
    expect(await panel.locator('[data-model-switcher-search]').getAttribute('placeholder')).toBe('Search Anthropic (demo) models')
    await expect.poll(() => panel.locator('[data-section="provider"] [role="option"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-provider')))).toEqual(['demo-anthropic', 'demo-anthropic'])
    await page.keyboard.type('sonnet', { delay: 40 })
    await page.keyboard.press('Enter')
    await panel.waitFor({ state: 'detached' })
    await expect.poll(() => page.locator(TRIGGER).innerText()).toContain('Claude Sonnet (demo)')
  }, 300_000)

  it('sets the reasoning effort from the footer', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-model-switcher-e2e-effort.png') }) })
    await expect.poll(() => page.locator(TRIGGER).innerText()).toContain('Medium')
    await page.locator(TRIGGER).click()
    const panel = page.locator(PANEL)
    await panel.waitFor()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-effort'))).toBe('medium')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await panel.waitFor({ state: 'detached' })
    await expect.poll(() => page.locator(TRIGGER).innerText()).toContain('High')
    await send(page, 'effort?')
    await page.getByText('Answered: effort? | route=demo-anthropic/claude-sonnet-demo effort=high').waitFor({ timeout: 60_000 })
  }, 300_000)

  it('keeps favorites across reloads', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-model-switcher-e2e-favorites.png') }) })
    await page.locator(TRIGGER).click()
    await page.keyboard.type('kimi')
    await page.keyboard.press('Control+s')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.locator(PANEL).waitFor({ state: 'detached' })
    await page.reload({ waitUntil: 'load' })
    await dismissNotices(page)
    await page.locator(TRIGGER).click()
    const favorites = page.locator(`${PANEL} [data-section="favorites"]`)
    await favorites.locator('[data-model="moonshotai/kimi-demo"]').waitFor({ timeout: 30_000 })
    await shot(page, 'picker-favorites')
    await page.keyboard.press('Escape')
  }, 300_000)

  it('opens as a bottom sheet on a narrow screen', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-model-switcher-e2e-sheet.png') }) })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator(TRIGGER).click()
    const panel = page.locator(PANEL)
    await panel.waitFor()
    expect(await panel.getAttribute('aria-modal')).toBe('true')
    const box = await panel.boundingBox()
    expect(box?.width).toBe(390)
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844)
    await shot(page, 'picker-sheet')
    await panel.getByRole('button', { name: 'Close' }).click()
    await panel.waitFor({ state: 'detached' })
    await page.setViewportSize({ width: 1280, height: 860 })
  }, 300_000)

  it('hands the seat back to the stock control when removed', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-model-switcher-e2e-remove.png') }) })
    await stop(server!.child)
    runDsh(home, ['plugin', '--profile', 'web', 'remove', 'dsh-model-switcher'])
    server = await serve(home, overlay)
    await page.goto(server.url, { waitUntil: 'load' })
    await page.locator(COMPOSER).waitFor({ timeout: 60_000 })
    await dismissNotices(page)
    await send(page, 'after removal')
    await page.getByText(/Answered: after removal \| route=/).waitFor({ timeout: 60_000 })
    await page.locator('button[aria-haspopup="menu"][aria-label^="Select model"]').waitFor({ timeout: 30_000 })
    expect(await page.locator(TRIGGER).count()).toBe(0)
  }, 300_000)
})
