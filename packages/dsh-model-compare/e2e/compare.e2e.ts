/**
 * Browser test against a real dsh Web server. It installs the packed plugin
 * and a test-only model route (`e2e/alpha`, `e2e/beta`) into a throwaway
 * `DSH_HOME` with `dsh plugin add`, boots the `web` profile, and drives
 * Chromium through a comparison: setup, two streaming columns with
 * statistics, the lane tool policy, continuing with one answer, and the
 * phone layout with tabs.
 *
 * Choose the dsh to test with:
 * - nothing: `npx -y @deepseek-ai/dsh@<version>` from npm, where the version is
 *   `DSH_E2E_VERSION` or the pinned `@deepseek-ai/dsh-*` dev dependency;
 * - `DSH_E2E_CHECKOUT=/path/to/deepseek-harness` runs `pnpm -s dsh` in a built checkout;
 * - `DSH_E2E_BIN="npx -y @deepseek-ai/dsh@next"` runs any other launcher.
 */

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACTS = join(PACKAGE_DIR, '..', '..', '.artifacts')
const FIXTURE = join(PACKAGE_DIR, 'e2e', 'model-fixture')
const SCREENSHOTS = process.env['DSH_E2E_SCREENSHOTS']
const consoleLog: string[] = []

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
  const name = (await readdir(ARTIFACTS)).filter(file => /^dsh-model-compare-.*\.tgz$/.test(file)).sort().at(-1)
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

function serve(home: string, overlay: string, workspace: string): Promise<Served> {
  const child = spawn(dsh!.command, [...dsh!.args, '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], {
    cwd: dsh!.cwd ?? workspace, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
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
  await page.waitForFunction(() => document.querySelector('[data-composer-input]')?.textContent === '', undefined, { timeout: 30_000 })
}

async function newSession(page: Page, url: string, first: string, fresh = true): Promise<void> {
  await page.goto(url, { waitUntil: 'load' })
  await page.locator(COMPOSER).waitFor({ timeout: 30_000 })
  // Later sessions start from the sidebar in the existing workspace.
  if (fresh) for (const fresh of await page.getByRole('button', { name: /^new session$/i }).all()) {
    if (await fresh.isVisible()) {
      await fresh.click()
      // The blank session's hero composer replaces the previous one.
      await page.waitForTimeout(1500)
      break
    }
  }
  await send(page, first)
  await page.getByText(`alpha: ${first}`).first().waitFor({ timeout: 60_000 })
}

async function openCompare(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Compare', exact: true }).or(page.getByRole('tab', { name: 'Compare', exact: true })).first().click()
  await page.locator('[data-model-compare-setup]').waitFor({ timeout: 30_000 })
}

async function pickBeta(page: Page): Promise<void> {
  const search = page.getByRole('combobox', { name: 'Search models' })
  await search.click()
  await search.fill('beta')
  await page.locator('[data-model-compare-option="e2e/beta"]').click()
}

async function storedCompares(home: string): Promise<string> {
  const files = await readdir(home, { recursive: true, withFileTypes: true })
  const texts = await Promise.all(files
    .filter(entry => entry.isFile() && join(entry.parentPath, entry.name).includes('model_compare'))
    .map(entry => readFile(join(entry.parentPath, entry.name), 'utf8')))
  return texts.join('\n')
}

describe('model comparison in the dsh Web UI', () => {
  let home: string
  let workspace: string
  let server: Served | undefined
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-model-compare-e2e-'))
    workspace = await mkdtemp(join(tmpdir(), 'dsh-model-compare-e2e-ws-'))
    const overlay = join(home, 'e2e-overlay.yml')
    await writeFile(overlay, [
      '- id: agent-default-model',
      '  config:',
      '    provider: e2e',
      '    model: alpha',
      '',
    ].join('\n'))
    runDsh(home, ['plugin', '--profile', 'web', 'add', await packedTarball()])
    runDsh(home, ['plugin', '--profile', 'web', 'add', FIXTURE])
    await acknowledgeWelcome(home)
    server = await serve(home, overlay, workspace)
    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1440, height: 960 } })
    page.on('console', (message) => { consoleLog.push(`[${message.type()}] ${message.text()}`) })
    page.on('pageerror', (error) => { consoleLog.push(`[pageerror] ${error.message}`) })
    page.on('dialog', (dialog) => { void dialog.accept() })
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    if (server !== undefined) await stop(server.child)
    if (process.env['DSH_E2E_KEEP_HOME'] === undefined) {
      await rm(home, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    } else console.log(`DSH_HOME kept at ${home}`)
  })

  it('compares two models side by side with statistics and continues with the picked answer', async () => {
    onTestFailed(async () => {
      await page.screenshot({ path: join(tmpdir(), 'dsh-model-compare-e2e-desktop.png'), fullPage: true })
      await writeFile(join(tmpdir(), 'dsh-model-compare-e2e-server.log'), server?.output() ?? '')
      await writeFile(join(tmpdir(), 'dsh-model-compare-e2e-console.log'), consoleLog.join('\n'))
    })
    await newSession(page, server!.url, 'hello there', false)
    await openCompare(page)
    // The default model is preselected; add the second one.
    await page.locator('[data-model-compare-chip="e2e/alpha"]').waitFor()
    await pickBeta(page)
    await page.locator('[data-model-compare-tools="none"]').waitFor()
    await page.locator('[data-model-compare-prompt]').fill('which is faster?')
    await page.locator('[data-model-compare-start]').click()

    const alpha = page.locator('[data-model-compare-lane]').nth(0)
    const beta = page.locator('[data-model-compare-lane]').nth(1)
    await expect.poll(() => page.locator('[data-model-compare-lane]').count(), { timeout: 30_000 }).toBe(2)
    // Each lane answered with its own model, without workspace tools. (Tools a
    // plugin registers on the lane's own agent scope, such as
    // `subagent` in some profiles, stay listed; the lane guard denies their calls.)
    const alphaAnswer = alpha.getByText(/^alpha: which is faster\? \| tools=/)
    const betaAnswer = beta.getByText(/^beta: which is faster\? \| tools=/)
    await alphaAnswer.waitFor({ timeout: 60_000 })
    await betaAnswer.waitFor({ timeout: 60_000 })
    for (const answer of [await alphaAnswer.innerText(), await betaAnswer.innerText()]) {
      expect(answer).not.toMatch(/\b(write|edit|bash|read)\b/)
    }
    await alpha.locator('[data-status="completed"][role="status"]').waitFor({ timeout: 30_000 })
    await beta.locator('[data-status="completed"][role="status"]').waitFor({ timeout: 30_000 })
    const stats = await beta.locator('[data-model-compare-stats]').innerText()
    expect(stats).toMatch(/First token \d+\.\d+ s/)
    expect(stats).toMatch(/Total \d+\.\d+ s/)
    expect(stats).toContain('1.4k in')
    expect(stats).toContain('$0.0042')
    expect(await page.locator('[data-model-compare-shown-prompt]').innerText()).toBe('which is faster?')
    if (SCREENSHOTS !== undefined) await page.screenshot({ path: join(SCREENSHOTS, 'compare-desktop.png') })

    // The source conversation did not receive the comparison prompt.
    await page.getByRole('tab', { name: 'Chat', exact: true }).or(page.getByRole('button', { name: 'Chat', exact: true })).first().click()
    expect(await page.getByText('which is faster?').count()).toBe(0)
    await openCompareLanes(page)

    await beta.locator('[data-model-compare-adopt]').click()
    // The continuation opens in the main view with the beta answer, and continues on beta.
    await page.getByText(/^beta: which is faster\? \| tools=/).first().waitFor({ timeout: 60_000 })
    await expect.poll(() => page.locator('[data-model-compare-lane]').count(), { timeout: 30_000 }).toBe(0)
    await send(page, 'and now with tools?')
    await page.getByText(/beta: and now with tools\? \| tools=.*write/).waitFor({ timeout: 60_000 })
    await expect.poll(async () => /"status":\s*"adopted"/.test(await storedCompares(home)), { timeout: 10_000 }).toBe(true)
  }, 300_000)

  it('keeps lanes from writing to the workspace', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-model-compare-e2e-tools.png'), fullPage: true }) })
    await newSession(page, server!.url, 'second session')
    await openCompare(page)
    await pickBeta(page)
    await page.locator('[data-model-compare-prompt]').fill('please write a file')
    await page.locator('[data-model-compare-start]').click()
    const alpha = page.locator('[data-model-compare-lane]').nth(0)
    await alpha.getByText(/alpha: tool-result=/).waitFor({ timeout: 60_000 })
    const probes = [workspace, home, ...dsh!.cwd === undefined ? [] : [dsh!.cwd]].map(dir => join(dir, 'compare-probe.txt'))
    expect(probes.filter(path => existsSync(path))).toEqual([])
    await page.locator('[data-model-compare-discard]').click()
    await page.locator('[data-model-compare-setup]').waitFor({ timeout: 30_000 })
  }, 300_000)

  it('shows one lane at a time with tabs on a phone', async () => {
    const phone = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    onTestFailed(async () => { await phone.screenshot({ path: join(tmpdir(), 'dsh-model-compare-e2e-phone.png'), fullPage: true }) })
    phone.on('dialog', (dialog) => { void dialog.accept() })
    try {
      await newSession(phone, server!.url, 'phone session')
      await openCompare(phone)
      await pickBeta(phone)
      await phone.locator('[data-model-compare-prompt]').fill('short answer please')
      await phone.locator('[data-model-compare-start]').click()
      const tabs = phone.getByRole('tab', { name: /^(Alpha|Beta)$/ })
      await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(2)
      const strip = phone.locator('[data-model-compare] .dmc-lanes')
      await phone.locator('[data-model-compare-lane]').nth(0).getByText('alpha: short answer please').waitFor({ timeout: 60_000 })
      expect(await phone.locator('[data-model-compare-lane]').nth(1).isVisible()).toBe(true)
      const before = await strip.evaluate(element => element.scrollLeft)
      await phone.getByRole('tab', { name: 'Beta' }).click()
      await expect.poll(() => strip.evaluate(element => element.scrollLeft), { timeout: 10_000 }).toBeGreaterThan(before + 100)
      await expect.poll(() => phone.getByRole('tab', { name: 'Beta' }).getAttribute('aria-selected')).toBe('true')
      // The Beta lane fills the strip once the swipe settles.
      await expect.poll(async () => {
        const [lane, box] = await Promise.all([phone.locator('[data-model-compare-lane]').nth(1).boundingBox(), strip.boundingBox()])
        return lane !== null && box !== null && Math.abs(lane.x - box.x) < 2 && lane.width <= box.width + 1
      }, { timeout: 10_000 }).toBe(true)
      await phone.locator('[data-model-compare-lane]').nth(1).getByText('beta: short answer please').waitFor({ timeout: 60_000 })
      if (SCREENSHOTS !== undefined) await phone.screenshot({ path: join(SCREENSHOTS, 'compare-phone.png') })
      await phone.locator('[data-model-compare-discard]').click()
      await phone.locator('[data-model-compare-setup]').waitFor({ timeout: 30_000 })
      await expect.poll(async () => /"status":\s*"discarded"/.test(await storedCompares(home)), { timeout: 10_000 }).toBe(true)
    } finally {
      await phone.close()
    }
  }, 300_000)
})

async function openCompareLanes(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Compare', exact: true }).or(page.getByRole('button', { name: 'Compare', exact: true })).first().click()
  await page.locator('[data-model-compare-lane]').first().waitFor({ timeout: 30_000 })
}
