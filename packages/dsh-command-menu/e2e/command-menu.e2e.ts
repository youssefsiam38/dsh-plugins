/**
 * Browser test against a real dsh Web server. It installs the packed plugin
 * and a test-only model route into a throwaway `DSH_HOME` with
 * `dsh plugin add`, boots the `web` profile with content search turned on,
 * and drives Chromium through the menu: the hotkey, message search, nested
 * model page, slash commands, settings pages, themes, recents, and the
 * phone-width sheet.
 *
 * Choose the dsh to test with:
 * - nothing: `npx -y @deepseek-ai/dsh@<version>` from npm, where the version is
 *   `DSH_E2E_VERSION` or the pinned `@deepseek-ai/dsh-*` dev dependency;
 * - `DSH_E2E_CHECKOUT=/path/to/deepseek-harness` runs `pnpm -s dsh` in a built checkout;
 * - `DSH_E2E_BIN="npx -y @deepseek-ai/dsh@next"` runs any other launcher.
 */

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACTS = join(PACKAGE_DIR, '..', '..', '.artifacts')
const FIXTURE = join(PACKAGE_DIR, 'e2e', 'model-fixture')
const SCREENSHOT = process.env['DSH_E2E_SCREENSHOT']

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
  const name = (await readdir(ARTIFACTS)).filter(file => /^dsh-command-menu-.*\.tgz$/.test(file)).sort().at(-1)
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

async function send(page: Page, text: string): Promise<void> {
  const input = page.locator(COMPOSER)
  await input.waitFor({ timeout: 30_000 })
  await input.fill(text)
  await input.press('Enter')
  await page.getByText(new RegExp(`^Answered: ${text} \\| model=`)).waitFor({ timeout: 60_000 })
}

function menu(page: Page) {
  return page.getByRole('dialog', { name: 'Command menu' })
}

async function openMenu(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+K')
  await menu(page).waitFor({ timeout: 10_000 })
}

/** Open the menu, type a query, and run the row that becomes active. */
async function runQuery(page: Page, query: string, expectActive?: RegExp): Promise<void> {
  await openMenu(page)
  await page.keyboard.type(query)
  if (expectActive !== undefined) {
    await expect.poll(async () => activeText(page), { timeout: 10_000 }).toMatch(expectActive)
  }
  await page.keyboard.press('Enter')
}

async function activeText(page: Page): Promise<string> {
  const option = menu(page).locator('[role="option"][aria-selected="true"]')
  return await option.count() === 0 ? '' : option.innerText()
}

describe('command menu in the dsh Web UI', () => {
  let home: string
  let server: Served | undefined
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-command-menu-e2e-'))
    const overlay = join(home, 'e2e-overlay.yml')
    await writeFile(overlay, [
      '- id: agent-default-model',
      '  config:',
      '    provider: e2e',
      '    model: echo',
      '- id: session-query-sqlite',
      '  config:',
      "    path: ':memory:'",
      '    openAt: first-search',
      '',
    ].join('\n'))
    runDsh(home, ['plugin', '--profile', 'web', 'add', await packedTarball()])
    runDsh(home, ['plugin', '--profile', 'web', 'add', FIXTURE])
    await acknowledgeWelcome(home)
    server = await serve(home, overlay)
    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 900 } })
    await page.goto(server.url, { waitUntil: 'load' })
    await send(page, 'hello palette alpha')
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    if (server !== undefined) await stop(server.child)
    if (process.env['DSH_E2E_KEEP_HOME'] === undefined) await rm(home, { recursive: true, force: true })
    else console.log(`DSH_HOME kept at ${home}`)
  })

  function onFailure(name: string): void {
    onTestFailed(async () => {
      await page.screenshot({ path: join(tmpdir(), `dsh-command-menu-e2e-${name}.png`) })
      await writeFile(join(tmpdir(), 'dsh-command-menu-e2e-server.log'), server?.output() ?? '')
    })
  }

  it('the hotkey opens the menu from the composer and closes it again; the sidebar has a button', async () => {
    onFailure('hotkey')
    await page.locator(COMPOSER).click()
    await openMenu(page)
    const input = menu(page).getByRole('combobox')
    await expect.poll(() => input.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await menu(page).getByRole('group', { name: 'Actions' }).count()).toBe(1)
    await page.keyboard.press('ControlOrMeta+K')
    await menu(page).waitFor({ state: 'detached' })
    // Focus returns to the composer.
    expect(await page.locator(COMPOSER).evaluate(node => node === document.activeElement)).toBe(true)
    await page.locator('[data-command-menu-trigger]').click()
    await menu(page).waitFor()
    await page.keyboard.press('Escape')
    await menu(page).waitFor({ state: 'detached' })
  }, 120_000)

  it('starts a new session, then finds the first one by message text and marks the match', async () => {
    onFailure('messages')
    await runQuery(page, 'new session', /New session/)
    await expect.poll(() => page.getByText('Answered: hello palette alpha').count(), { timeout: 30_000 }).toBe(0)
    await send(page, 'second beta topic')

    await openMenu(page)
    await page.keyboard.type('palette alpha')
    const messages = menu(page).getByRole('group', { name: 'Messages' })
    await messages.getByRole('option').first().waitFor({ timeout: 30_000 })
    expect(await messages.getByRole('option').first().innerText()).toContain('hello palette alpha')
    await messages.getByRole('option').first().click()
    await page.getByText('Answered: hello palette alpha').waitFor({ timeout: 30_000 })
    await expect.poll(() => page.locator('[data-command-menu-hit]').count(), { timeout: 10_000 }).toBe(1)
    expect(await page.locator('[data-command-menu-hit]').innerText()).toContain('palette alpha')
  }, 180_000)

  it('switches the session model from the nested models page', async () => {
    onFailure('models')
    await runQuery(page, 'switch model', /Switch model/)
    await menu(page).getByRole('button', { name: 'Back' }).waitFor()
    await page.keyboard.type('second')
    await expect.poll(() => activeText(page), { timeout: 30_000 }).toMatch(/Echo Second/)
    await page.keyboard.press('Enter')
    await menu(page).waitFor({ state: 'detached' })
    await send(page, 'after the switch')
    await page.getByText('Answered: after the switch | model=second').waitFor()
    await openMenu(page)
    await page.keyboard.type('switch model')
    await page.keyboard.press('Enter')
    await expect.poll(async () => menu(page).locator('[role="option"][aria-current="true"]').innerText(), { timeout: 30_000 }).toContain('Echo Second')
    // Backspace in the empty field goes back to the top level, Escape closes.
    await page.keyboard.press('Backspace')
    await expect.poll(() => menu(page).getByRole('button', { name: 'Back' }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await menu(page).waitFor({ state: 'detached' })
  }, 180_000)

  it('lists the session slash commands under `>` and runs one through the composer', async () => {
    onFailure('commands')
    await openMenu(page)
    await page.keyboard.type('>')
    const commands = menu(page).getByRole('group', { name: 'Commands' })
    await commands.getByRole('option').first().waitFor({ timeout: 30_000 })
    expect(await commands.getByRole('option').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining('/compact')]))
    await page.keyboard.type('goal')
    await expect.poll(() => activeText(page)).toMatch(/\/goal/)
    await page.keyboard.press('Enter')
    await menu(page).waitFor({ state: 'detached' })
    // A command that takes input is left in the composer for the user to finish.
    await expect.poll(() => page.locator(COMPOSER).innerText(), { timeout: 10_000 }).toMatch(/^\/goal\s*$/)
    await page.locator(COMPOSER).fill('')
  }, 120_000)

  it('opens a settings page and switches themes', async () => {
    onFailure('settings')
    await runQuery(page, '#models', /Models/)
    const nav = page.locator('[role="dialog"][aria-modal="true"] nav')
    await nav.waitFor({ timeout: 10_000 })
    await expect.poll(() => nav.locator('button[aria-current="true"]').innerText(), { timeout: 10_000 }).toBe('Models')
    await page.keyboard.press('Escape')
    await nav.waitFor({ state: 'detached' })

    await runQuery(page, '#dark', /Dark/)
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    if (SCREENSHOT !== undefined) {
      await openMenu(page)
      await page.keyboard.type('palette')
      await menu(page).getByRole('group', { name: 'Messages' }).waitFor({ timeout: 30_000 })
      await page.screenshot({ path: SCREENSHOT })
      await page.keyboard.press('Escape')
    }
    await runQuery(page, '#light', /Light/)
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)
  }, 120_000)

  it('lists recently used entries first on a blank query', async () => {
    onFailure('recents')
    await openMenu(page)
    const recent = menu(page).getByRole('group', { name: 'Recent' })
    await recent.waitFor()
    expect((await recent.getByRole('option').first().innerText())).toContain('Light')
    await page.keyboard.press('Escape')
  }, 60_000)

  it('becomes a full-screen sheet at phone width', async () => {
    onFailure('sheet')
    const phone = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await phone.goto(server!.url, { waitUntil: 'load' })
      await phone.locator(COMPOSER).waitFor({ timeout: 30_000 })
      await phone.keyboard.press('ControlOrMeta+K')
      const dialog = menu(phone)
      await dialog.waitFor()
      const box = await dialog.boundingBox()
      expect(box?.width).toBe(390)
      await dialog.getByRole('button', { name: 'Close' }).tap()
      await dialog.waitFor({ state: 'detached' })
    } finally {
      await phone.close()
    }
  }, 120_000)
})
