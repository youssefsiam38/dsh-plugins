/**
 * Browser test against a real dsh Web server. It installs the packed plugin
 * and a test-only model route into a throwaway `DSH_HOME` with
 * `dsh plugin add`, boots the `web` profile, and drives Chromium.
 *
 * Choose the dsh to test with one of:
 * - `DSH_E2E_CHECKOUT=/path/to/deepseek-harness` runs `pnpm -s dsh` in a
 *   built checkout (the fork build);
 * - `DSH_E2E_BIN="npx -y @deepseek-ai/dsh@next"` runs any other launcher.
 * Without either the suite is skipped.
 */

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACTS = join(PACKAGE_DIR, '..', '..', '.artifacts')
const FIXTURE = join(PACKAGE_DIR, 'e2e', 'model-fixture')
const OVERLAY = join(PACKAGE_DIR, 'e2e', 'overlay.yml')
const SCREENSHOT = process.env['DSH_E2E_SCREENSHOT']

function launcher(): { command: string; args: string[]; cwd?: string } | undefined {
  const checkout = process.env['DSH_E2E_CHECKOUT']
  if (checkout !== undefined && checkout !== '') return { command: 'pnpm', args: ['-s', 'dsh'], cwd: checkout }
  const bin = process.env['DSH_E2E_BIN']
  if (bin !== undefined && bin !== '') {
    const [command, ...args] = bin.split(/\s+/)
    return { command: command!, args }
  }
  return undefined
}

const dsh = launcher()

async function packedTarball(): Promise<string> {
  const name = (await readdir(ARTIFACTS)).filter(file => /^dsh-session-retry-.*\.tgz$/.test(file)).sort().at(-1)
  if (name === undefined) throw new Error('run `pnpm run pack:tarball` first')
  return join(ARTIFACTS, name)
}

function runDsh(home: string, args: string[]): void {
  const result = spawnSync(dsh!.command, [...dsh!.args, ...args], {
    cwd: dsh!.cwd, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 300_000,
  })
  if (result.status !== 0) throw new Error(`dsh ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
}

function serve(home: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(dsh!.command, [...dsh!.args, '--profile', 'web', '--patch', OVERLAY, '--no-open', '--port', '0'], {
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
        resolve({ child, url })
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

async function send(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await input.waitFor({ timeout: 30_000 })
  await input.fill(text)
  await input.press('Enter')
  // The submission is accepted once the composer clears.
  await page.waitForFunction(
    () => document.querySelector('[data-composer-input]')?.textContent === '',
    undefined,
    { timeout: 30_000 },
  )
}

describe.skipIf(dsh === undefined)('retry block in the dsh Web UI', () => {
  let home: string
  let server: ChildProcess | undefined
  let url: string
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-session-retry-e2e-'))
    runDsh(home, ['plugin', '--profile', 'web', 'add', await packedTarball()])
    runDsh(home, ['plugin', '--profile', 'web', 'add', FIXTURE])
    const served = await serve(home)
    server = served.child
    url = served.url
    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 800 } })
    await page.goto(url, { waitUntil: 'load' })
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    if (server?.pid !== undefined) {
      try {
        process.kill(-server.pid, 'SIGTERM')
      } catch (error: unknown) {
        // The server group already exited.
        void error
      }
    }
    await rm(home, { recursive: true, force: true })
  })

  it('shows the count and next time, reveals the exact time on hover, and retries now', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-session-retry-e2e-retry-now.png') }) })
    await send(page, 'Deploy the site, FAIL please')
    const block = page.locator('.dsh-session-retry-block')
    // Attempt 1 and the 1-second retry (attempt 2) both fail; attempt 3 waits 2^10 s with the test overlay.
    await block.getByText(/Retrying 3\/25 · next in \d+ min/).waitFor({ timeout: 120_000 })
    expect(await block.locator('.dsh-session-retry-dot').count()).toBe(1)

    const text = block.locator('[data-retry-tooltip]')
    await text.hover()
    const tooltip = page.getByRole('tooltip')
    await tooltip.waitFor({ timeout: 10_000 })
    const tooltipText = await tooltip.innerText()
    expect(tooltipText).toMatch(/^Next retry: \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M · Reason: the connection to the model provider failed$/)
    if (SCREENSHOT !== undefined) await page.screenshot({ path: SCREENSHOT, clip: { x: 280, y: 420, width: 1000, height: 380 } })

    await block.getByRole('button', { name: 'Retry now' }).click()
    await page.getByText('Answered: (Automatic retry 3/25').waitFor({ timeout: 60_000 })
    await expect.poll(() => block.count(), { timeout: 30_000 }).toBe(0)
  }, 300_000)

  it('cancels the pending retry when a person writes', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-session-retry-e2e-cancel.png') }) })
    await page.getByRole('button', { name: 'New Session' }).first().click()
    await page.locator('[data-composer-input][data-placeholder^="Describe what you want to build"]').waitFor({ timeout: 30_000 })
    await send(page, 'Ship it, FAIL again')
    const block = page.locator('.dsh-session-retry-block')
    await block.getByText(/Retrying 3\/25/).waitFor({ timeout: 120_000 })
    await send(page, 'never mind, just say hi')
    await page.getByText('Answered: never mind, just say hi').waitFor({ timeout: 60_000 })
    await expect.poll(() => block.count(), { timeout: 30_000 }).toBe(0)
  }, 300_000)

  it('stops retrying from the Stop button', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-session-retry-e2e-stop.png') }) })
    await page.getByRole('button', { name: 'New Session' }).first().click()
    await page.locator('[data-composer-input][data-placeholder^="Describe what you want to build"]').waitFor({ timeout: 30_000 })
    await send(page, 'Migrate the database, FAIL')
    const block = page.locator('.dsh-session-retry-block')
    await block.getByText(/Retrying 3\/25/).waitFor({ timeout: 120_000 })
    await block.getByRole('button', { name: 'Stop' }).click()
    await expect.poll(() => block.count(), { timeout: 30_000 }).toBe(0)
    await page.getByText('Automatic retries stopped.').waitFor({ timeout: 10_000 })
  }, 300_000)
})
