/**
 * Browser test against a real dsh Web server. It installs the packed plugin
 * and a test-only model route into a throwaway `DSH_HOME` with
 * `dsh plugin add`, boots the `web` profile, and drives Chromium.
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
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACTS = join(PACKAGE_DIR, '..', '..', '.artifacts')
const FIXTURE = join(PACKAGE_DIR, 'e2e', 'model-fixture')
const OVERLAY = join(PACKAGE_DIR, 'e2e', 'overlay.yml')
const RESTART_OVERLAY = join(PACKAGE_DIR, 'e2e', 'restart-overlay.yml')
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

interface Served {
  readonly child: ChildProcess
  readonly url: string
  /** Everything the server printed so far. */
  output(): string
}

function serve(home: string, patches: readonly string[] = []): Promise<Served> {
  const extra = patches.flatMap(patch => ['--patch', patch])
  const child = spawn(dsh!.command, [...dsh!.args, '--profile', 'web', '--patch', OVERLAY, ...extra, '--no-open', '--port', '0'], {
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

/** Stop a server's process group and wait for it to exit. */
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

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode a log of appended zstd frames; `zstdDecompressSync` stops after the first frame. */
function zstdText(bytes: Buffer): string {
  const starts: number[] = []
  for (let index = bytes.indexOf(ZSTD_MAGIC); index >= 0; index = bytes.indexOf(ZSTD_MAGIC, index + 1)) starts.push(index)
  let text = ''
  let begin = starts[0] ?? bytes.length
  for (let next = 1; next <= starts.length; next += 1) {
    const end = next < starts.length ? starts[next]! : bytes.length
    try {
      text += zstdDecompressSync(bytes.subarray(begin, end)).toString('utf8')
      begin = end
    } catch (error: unknown) {
      // The magic bytes occurred inside a frame: extend the slice to the next candidate.
      void error
    }
  }
  return text
}

/** Every stored session log under `DSH_HOME/sessions`, decompressed. */
async function sessionLogs(home: string): Promise<string[]> {
  const root = join(home, 'sessions')
  const files = (await readdir(root, { recursive: true })).filter(file => /\.jsonl(\.zstd)?$/.test(file))
  return Promise.all(files.map(async (file) => {
    const bytes = await readFile(join(root, file))
    return file.endsWith('.zstd') ? zstdText(bytes) : bytes.toString('utf8')
  }))
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

describe('retry block in the dsh Web UI', () => {
  let home: string
  let server: Served | undefined
  let url: string
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-session-retry-e2e-'))
    runDsh(home, ['plugin', '--profile', 'web', 'add', await packedTarball()])
    runDsh(home, ['plugin', '--profile', 'web', 'add', FIXTURE])
    await acknowledgeWelcome(home)
    server = await serve(home)
    url = server.url
    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 800 } })
    await page.goto(url, { waitUntil: 'load' })
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    if (server !== undefined) await stop(server.child)
    if (process.env['DSH_E2E_KEEP_HOME'] === undefined) await rm(home, { recursive: true, force: true })
    else console.log(`DSH_HOME kept at ${home}`)
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

  it('continues a waiting retry after a restart without the session being opened', async () => {
    onTestFailed(async () => {
      if (!page.isClosed()) await page.screenshot({ path: join(tmpdir(), 'dsh-session-retry-e2e-restart.png') })
      await writeFile(join(tmpdir(), 'dsh-session-retry-e2e-restart.log'), server?.output() ?? '')
    })
    await page.getByRole('button', { name: 'New Session' }).first().click()
    await page.locator('[data-composer-input][data-placeholder^="Describe what you want to build"]').waitFor({ timeout: 30_000 })
    await send(page, 'Restart the workers, FAIL')
    const block = page.locator('.dsh-session-retry-block')
    await block.getByText(/Retrying 3\/25/).waitFor({ timeout: 120_000 })
    // The projection cache writes the failing turn's checkpoint in the background; give it a moment,
    // then close every browser view and restart the host.
    await new Promise(resolve => setTimeout(resolve, 2_000))
    await page.close()
    await stop(server!.child)

    server = await serve(home, [RESTART_OVERLAY])
    const restarted = async () => (await sessionLogs(home)).find(text => text.includes('Restart the workers, FAIL')) ?? ''
    await expect.poll(async () => (await restarted()).includes('Answered: (Automatic retry'), { timeout: 120_000, interval: 1_000 }).toBe(true)
    const log = await restarted()
    const retries = log.split('\n').filter(line => line.includes('"kind":"session-retry"') && line.includes('"type":"user/message"'))
    // Attempt 2 ran before the restart; the sweep ran exactly one later slot.
    expect(retries).toHaveLength(2)
  }, 300_000)
})
