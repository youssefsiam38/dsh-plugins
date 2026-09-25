/**
 * Browser test against a real dsh Web server. It installs the packed plugin
 * and a test-only model route with two tools into a throwaway `DSH_HOME` with
 * `dsh plugin add`, boots the `web` profile, lets the fixture set up a git
 * workspace and edit a file, then drives Chromium through the turn-tail chip,
 * the review tab, keyboard keep and revert, a conflict, and the note the
 * model receives about the reverted hunk.
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
  const name = (await readdir(ARTIFACTS)).filter(file => /^dsh-hunk-review-.*\.tgz$/.test(file)).sort().at(-1)
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
async function sessionLogs(home: string): Promise<string> {
  const root = join(home, 'sessions')
  const files = (await readdir(root, { recursive: true })).filter(file => /\.jsonl(\.zstd)?$/.test(file))
  const texts = await Promise.all(files.map(async (file) => {
    const bytes = await readFile(join(root, file))
    return file.endsWith('.zstd') ? zstdText(bytes) : bytes.toString('utf8')
  }))
  return texts.join('\n')
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await input.waitFor({ timeout: 30_000 })
  await input.fill(text)
  await input.press('Enter')
  await page.waitForFunction(
    () => document.querySelector('[data-composer-input]')?.textContent === '',
    undefined,
    { timeout: 30_000 },
  )
}

describe('hunk review in the dsh Web UI', () => {
  let home: string
  let server: Served | undefined
  let browser: Browser
  let page: Page
  let workspace: string | undefined
  const consoleErrors: string[] = []

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-hunk-review-e2e-'))
    const overlay = join(home, 'e2e-overlay.yml')
    await writeFile(overlay, [
      '- id: agent-default-model',
      '  config:',
      '    provider: e2e',
      '    model: editor',
      '- id: workspace-controller',
      '  config:',
      `    documentsDirectory: ${JSON.stringify(join(home, 'Documents'))}`,
      '',
    ].join('\n'))
    runDsh(home, ['plugin', '--profile', 'web', 'add', await packedTarball()])
    runDsh(home, ['plugin', '--profile', 'web', 'add', FIXTURE])
    await acknowledgeWelcome(home)
    server = await serve(home, overlay)
    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1440, height: 900 } })
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('pageerror', (error) => { consoleErrors.push(error.stack ?? error.message) })
    await page.goto(server.url, { waitUntil: 'load' })
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    if (server !== undefined) await stop(server.child)
    if (process.env['DSH_E2E_KEEP_HOME'] === undefined) await rm(home, { recursive: true, force: true })
    else console.log(`DSH_HOME kept at ${home}`)
  })

  it('the agent edits a file and the turn tail offers a review', async () => {
    onTestFailed(async () => {
      await page.screenshot({ path: join(tmpdir(), 'dsh-hunk-review-e2e-setup.png') })
      await writeFile(join(tmpdir(), 'dsh-hunk-review-e2e-server.log'), `${server?.output() ?? ''}\n--- browser errors ---\n${consoleErrors.join('\n')}`)
    })
    await send(page, 'setup')
    const done = page.getByText(/Tool done: workspace=\[.+\]/).first()
    await done.waitFor({ timeout: 60_000 })
    workspace = /workspace=\[(.+)\]/.exec(await done.innerText())![1]!
    // The workspace must be the throwaway one: the test edits files there.
    expect(workspace.startsWith(home)).toBe(true)
    expect(await readFile(join(workspace, 'review.txt'), 'utf8')).toContain('line 3\n')

    await send(page, 'edit')
    await page.getByText('Tool done: edited review.txt').first().waitFor({ timeout: 60_000 })
    const chip = page.locator('[data-hunk-review-chip]').last()
    await chip.waitFor({ timeout: 60_000 })
    expect(await chip.innerText()).toBe('1 file changed · Review')
    await chip.click()
    const review = page.locator('[data-hunk-review]')
    await review.waitFor({ timeout: 30_000 })
    await expect.poll(() => review.locator('[data-hunk-review-hunk][data-status="pending"]').count(), { timeout: 30_000 }).toBe(2)
    await review.getByText('Turn 2', { exact: true }).waitFor()
  }, 300_000)

  it('j / y keeps the first hunk and n reverts the second on disk', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-hunk-review-e2e-keys.png') }) })
    const review = page.locator('[data-hunk-review]')
    await review.focus()
    await page.keyboard.press('j')
    await expect.poll(() => review.locator('[data-focused]').getAttribute('data-hunk-review-hunk')).toBe('0:0')
    await page.keyboard.press('y')
    await expect.poll(() => review.locator('[data-hunk-review-hunk="0:0"]').getAttribute('data-status'), { timeout: 30_000 }).toBe('kept')
    await expect.poll(() => review.locator('[data-focused]').getAttribute('data-hunk-review-hunk')).toBe('0:1')
    await page.keyboard.press('n')
    await expect.poll(() => review.locator('[data-hunk-review-hunk="0:1"]').getAttribute('data-status'), { timeout: 30_000 }).toBe('reverted')
    await review.getByText('Reverted 1 hunk. The agent will see what you reverted with your next message.').waitFor()
    const text = await readFile(join(workspace!, 'review.txt'), 'utf8')
    expect(text).toContain('line 3 changed by the agent')
    expect(text).toContain('\nline 25\n')
    if (SCREENSHOT !== undefined) await page.screenshot({ path: SCREENSHOT })
  }, 300_000)

  it('a hunk the user changed afterwards shows as a conflict after Re-diff and cannot be reverted', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-hunk-review-e2e-conflict.png') }) })
    const path = join(workspace!, 'review.txt')
    const edited = (await readFile(path, 'utf8')).replace('line 3 changed by the agent', 'line 3 edited by me')
    await writeFile(path, edited)
    const review = page.locator('[data-hunk-review]')
    await review.locator('[data-hunk-review-action="refresh-all"]').click()
    const hunk = review.locator('[data-hunk-review-hunk="0:0"]')
    await expect.poll(() => hunk.getAttribute('data-status'), { timeout: 30_000 }).toBe('conflict')
    await hunk.locator('[data-hunk-review-conflict]').getByText('line 3 edited by me').waitFor()
    expect(await hunk.locator('[data-hunk-review-action="revert"]').count()).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(edited)
  }, 300_000)

  it('the model sees the reverted hunk with the next message, and the note is logged', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-hunk-review-e2e-model.png') }) })
    await send(page, 'what now?')
    await page.getByText('Answered: what now? | reverted=review.txt:1').waitFor({ timeout: 60_000 })
    await page.waitForTimeout(3000)
    expect(await sessionLogs(home)).toContain('"kind":"hunk-review"')
  }, 300_000)
})
