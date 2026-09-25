/**
 * Browser test against a real dsh Web server. It installs the packed plugin
 * and a test-only model route into a throwaway `DSH_HOME` with
 * `dsh plugin add`, boots the `web` profile with a fake `sudo` first on the
 * commands' PATH, and drives Chromium through `!`, `!!`, cancel, and the
 * sudo password prompt.
 *
 * Choose the dsh to test with one of:
 * - `DSH_E2E_CHECKOUT=/path/to/deepseek-harness` runs `pnpm -s dsh` in a
 *   built checkout (a fork build with line-prefix input-trigger sources);
 * - `DSH_E2E_BIN="npx -y @deepseek-ai/dsh@next"` runs any other launcher.
 * Without either the suite is skipped.
 */

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { FAKE_PASSWORD, fakeSudoDir } from '../tests/fixtures.ts'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACTS = join(PACKAGE_DIR, '..', '..', '.artifacts')
const FIXTURE = join(PACKAGE_DIR, 'e2e', 'model-fixture')
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
  const name = (await readdir(ARTIFACTS)).filter(file => /^dsh-user-shell-.*\.tgz$/.test(file)).sort().at(-1)
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

/** Every file under `DSH_HOME`, decompressed where it is a session log. */
async function everyStoredFile(home: string): Promise<string> {
  const files = await readdir(home, { recursive: true, withFileTypes: true })
  const texts = await Promise.all(files.filter(entry => entry.isFile()).map(async (entry) => {
    const path = join(entry.parentPath, entry.name)
    const bytes = await readFile(path)
    return path.endsWith('.zstd') ? zstdText(bytes) : bytes.toString('utf8')
  }))
  return texts.join('\n')
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

async function type(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await input.waitFor({ timeout: 30_000 })
  await input.fill(text)
}

async function send(page: Page, text: string): Promise<void> {
  await type(page, text)
  await page.locator('[data-composer-input][contenteditable="true"]').press('Enter')
  await page.waitForFunction(
    () => document.querySelector('[data-composer-input]')?.textContent === '',
    undefined,
    { timeout: 30_000 },
  )
}

describe.skipIf(dsh === undefined)('user shell in the dsh Web UI', () => {
  let home: string
  let server: Served | undefined
  let browser: Browser
  let page: Page
  let sudo: { dir: string; dispose: () => Promise<void> }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-user-shell-e2e-'))
    sudo = await fakeSudoDir()
    const overlay = join(home, 'e2e-overlay.yml')
    await writeFile(overlay, [
      '- id: agent-default-model',
      '  config:',
      '    provider: e2e',
      '    model: echo',
      '- id: user-shell',
      '  config:',
      '    askpassTimeoutSeconds: 60',
      '    env:',
      `      PATH: ${JSON.stringify(`${sudo.dir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`)}`,
      '      TERM: dumb',
      '',
    ].join('\n'))
    runDsh(home, ['plugin', '--profile', 'web', 'add', await packedTarball()])
    runDsh(home, ['plugin', '--profile', 'web', 'add', FIXTURE])
    server = await serve(home, overlay)
    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 900 } })
    await page.goto(server.url, { waitUntil: 'load' })
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    if (server !== undefined) await stop(server.child)
    await sudo?.dispose()
    if (process.env['DSH_E2E_KEEP_HOME'] === undefined) await rm(home, { recursive: true, force: true })
    else console.log(`DSH_HOME kept at ${home}`)
  })

  it('`!echo hi` runs, shows its output, and reaches the model only with the next message', async () => {
    onTestFailed(async () => {
      await page.screenshot({ path: join(tmpdir(), 'dsh-user-shell-e2e-context.png') })
      await writeFile(join(tmpdir(), 'dsh-user-shell-e2e-server.log'), server?.output() ?? '')
    })
    await type(page, '!echo hi')
    await expect.poll(() => page.locator('[data-user-shell-mode="context"]').count(), { timeout: 10_000 }).toBe(1)
    await send(page, '!echo hi')
    const block = page.locator('[data-user-shell-block]').first()
    await block.locator('[data-user-shell-output]').getByText('hi').waitFor({ timeout: 60_000 })
    await block.getByText(/Exit 0 · \d+\.\d{2} s/).waitFor({ timeout: 30_000 })
    await block.getByText('Goes to the agent with your next message').waitFor()
    // Not triggered: no answer arrives by itself.
    await page.waitForTimeout(1500)
    expect(await page.getByText(/^Answered:/).count()).toBe(0)
    if (SCREENSHOT !== undefined) await page.screenshot({ path: SCREENSHOT })

    await send(page, 'what did it print?')
    await page.getByText('Answered: what did it print? | shell=echo hi').waitFor({ timeout: 60_000 })
  }, 300_000)

  it('`!!` runs are shown but never reach the model', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-user-shell-e2e-quiet.png') }) })
    await type(page, '!!echo quiet-7')
    await expect.poll(() => page.locator('[data-user-shell-mode="quiet"]').count(), { timeout: 10_000 }).toBe(1)
    await send(page, '!!echo quiet-7')
    const block = page.locator('[data-user-shell-block][data-mode="quiet"]').last()
    await block.locator('[data-user-shell-output]').getByText('quiet-7').waitFor({ timeout: 60_000 })
    await block.getByText('Not added to the agent context').waitFor()
    await send(page, 'and now?')
    await page.getByText('Answered: and now? | shell=echo hi').waitFor({ timeout: 60_000 })
    const answers = await page.locator('p').filter({ hasText: /^Answered: .* \| shell=/ }).allInnerTexts()
    expect(answers.length).toBeGreaterThan(0)
    expect(answers.filter(answer => answer.includes('quiet-7'))).toEqual([])
  }, 300_000)

  it('Cancel stops a running command', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-user-shell-e2e-cancel.png') }) })
    await send(page, '!echo waiting; sleep 60')
    const block = page.locator('[data-user-shell-block]').last()
    await block.locator('[data-user-shell-output]').getByText('waiting').waitFor({ timeout: 60_000 })
    await block.getByRole('button', { name: 'Cancel' }).click()
    await block.getByText(/Cancelled · /).waitFor({ timeout: 30_000 })
  }, 300_000)

  it('sudo asks for the password in the page, and the password is stored nowhere', async () => {
    onTestFailed(async () => { await page.screenshot({ path: join(tmpdir(), 'dsh-user-shell-e2e-sudo.png') }) })
    await send(page, '!sudo echo root-ok')
    const block = page.locator('[data-user-shell-block]').last()
    const field = block.getByLabel('Password')
    await field.waitFor({ timeout: 60_000 })
    expect(await field.getAttribute('type')).toBe('password')
    await field.fill(FAKE_PASSWORD)
    await block.getByRole('button', { name: 'Submit' }).click()
    await block.locator('[data-user-shell-output]').getByText('root-ok').waitFor({ timeout: 60_000 })
    await block.getByText(/Exit 0 · /).waitFor({ timeout: 30_000 })
    expect(await block.locator('[data-user-shell-output]').innerText()).toContain('fake-sudo: authenticated')

    await send(page, 'done')
    await page.getByText(/Answered: done \| shell=echo hi,echo waiting; sleep 60,sudo echo root-ok/).waitFor({ timeout: 60_000 })
    // Let the session log checkpoint, then scan every file the server wrote and the page.
    await page.waitForTimeout(3000)
    const logs = await sessionLogs(home)
    expect(logs).toContain('root-ok')
    expect(logs).toContain('"kind":"user-shell"')
    expect(await everyStoredFile(home)).not.toContain(FAKE_PASSWORD)
    expect(server!.output()).not.toContain(FAKE_PASSWORD)
    expect(await page.content()).not.toContain(FAKE_PASSWORD)
  }, 300_000)
})
