/** ShellRun against the published local subprocess provider: output, markers, timeout, cancel, and the askpass FIFO. */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ShellRun } from '../src/runner.ts'
import type { ShellRunOptions } from '../src/runner.ts'
import type { UserShellAskpass } from '../src/types.ts'
import { FAKE_PASSWORD, fakeSudoDir } from './fixtures.ts'

let ctx: Context
let cwd: string
let sudo: { dir: string; dispose: () => Promise<void> }

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.subprocess
  cwd = await mkdtemp(join(tmpdir(), 'dsh-user-shell-cwd-'))
  sudo = await fakeSudoDir()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(cwd, { recursive: true, force: true })
  await sudo.dispose()
})

function options(command: string, extra: Partial<ShellRunOptions> = {}): ShellRunOptions {
  return {
    cwd,
    command,
    shell: '/bin/sh',
    askpass: true,
    timeoutMs: 20_000,
    killGraceMs: 500,
    captureBytes: 1 << 20,
    env: { PATH: `${sudo.dir}:${process.env['PATH'] ?? '/usr/bin:/bin'}` },
    ...extra,
  }
}

function collect() {
  const chunks: string[] = []
  const asks: UserShellAskpass[] = []
  const closed: string[] = []
  return {
    chunks,
    asks,
    closed,
    events: {
      output: (text: string) => { chunks.push(text) },
      askpass: (request: UserShellAskpass) => { asks.push(request) },
      askpassClosed: (requestId: string) => { closed.push(requestId) },
    },
  }
}

describe('ShellRun', () => {
  it('runs in the cwd with stdin on /dev/null and merges stderr', async () => {
    const sink = collect()
    const run = new ShellRun(ctx.subprocess, options('pwd; echo out; echo err >&2; cat; exit 3'), sink.events)
    const result = await run.done
    expect(result.status).toEqual({ kind: 'exited', exitCode: 3 })
    expect(result.output).toBe(`${cwd}\nout\nerr\n`)
    expect(sink.chunks.join('')).toBe(result.output)
    expect(result.output).not.toContain('DSH-USER-SHELL')
  })

  it('reports an empty output with its exit code and removes its private directory', async () => {
    const sink = collect()
    const run = new ShellRun(ctx.subprocess, options('printf %s "$SUDO_ASKPASS" > askpass-path'), sink.events)
    const result = await run.done
    expect(result).toMatchObject({ status: { kind: 'exited', exitCode: 0 }, output: '' })
    const helper = (await readFile(join(cwd, 'askpass-path'), 'utf8')).trim()
    expect(helper).toMatch(/\/dsh-user-shell\.[^/]+\/askpass$/)
    expect(existsSync(helper)).toBe(false)
  })

  it('times out and terminates the process group', async () => {
    const sink = collect()
    const run = new ShellRun(ctx.subprocess, options('sleep 30 & sleep 30; echo never', { timeoutMs: 300 }), sink.events)
    const result = await run.done
    expect(result.status).toEqual({ kind: 'timeout' })
    expect(result.durationMs).toBeLessThan(10_000)
  })

  it('cancels', async () => {
    const sink = collect()
    const run = new ShellRun(ctx.subprocess, options('echo started; sleep 30'), sink.events)
    await expect.poll(() => sink.chunks.join('')).toContain('started')
    run.cancel()
    expect((await run.done).status).toEqual({ kind: 'cancelled' })
  })

  it('asks for the sudo password through the FIFO and never shows the marker or the password', async () => {
    const sink = collect()
    const log = join(cwd, 'sudo.log')
    const run = new ShellRun(ctx.subprocess, options('sudo id -un; echo done', { env: { PATH: `${sudo.dir}:${process.env['PATH'] ?? ''}`, FAKE_SUDO_LOG: log } }), sink.events)
    await expect.poll(() => sink.asks.length, { timeout: 10_000 }).toBe(1)
    const ask = sink.asks[0]!
    expect(ask.prompt).toBe('[sudo] password for tester:')
    expect(run.hasAskpass(ask.requestId)).toBe(true)
    expect(await run.answer(ask.requestId, FAKE_PASSWORD)).toBe(true)
    expect(await run.answer(ask.requestId, FAKE_PASSWORD)).toBe(false)
    const result = await run.done
    expect(result.status).toEqual({ kind: 'exited', exitCode: 0 })
    expect(result.output).toContain('fake-sudo: authenticated')
    expect(result.output).toContain('done')
    expect(result.output).not.toContain(FAKE_PASSWORD)
    expect(result.output).not.toContain('\u001e')
    expect(sink.closed).toEqual([ask.requestId])
    // The wrapper runs the real (here: fake) sudo with -A, and the prelude ends with sudo -k.
    const calls = (await readFile(log, 'utf8')).trim().split('\n')
    expect(calls[0]).toBe('-A id -un')
    expect(calls.at(-1)).toBe('-k')
  })

  it('a refused password prompt makes sudo fail cleanly', async () => {
    const sink = collect()
    const run = new ShellRun(ctx.subprocess, options('sudo true; echo "sudo exit $?"'), sink.events)
    await expect.poll(() => sink.asks.length, { timeout: 10_000 }).toBe(1)
    expect(await run.answer(sink.asks[0]!.requestId, undefined)).toBe(true)
    const result = await run.done
    expect(result.output).toContain('no password was provided')
    expect(result.output).toContain('sudo exit 1')
  })

  it('cancelling while sudo waits ends the run and closes the prompt', async () => {
    const sink = collect()
    const run = new ShellRun(ctx.subprocess, options('sudo true'), sink.events)
    await expect.poll(() => sink.asks.length, { timeout: 10_000 }).toBe(1)
    run.cancel()
    const result = await run.done
    expect(result.status).toEqual({ kind: 'cancelled' })
    expect(sink.closed).toEqual([sink.asks[0]!.requestId])
    expect(run.hasAskpass(sink.asks[0]!.requestId)).toBe(false)
  })

  it('without askpass, sudo is the plain one', async () => {
    const sink = collect()
    const result = await new ShellRun(ctx.subprocess, options('sudo true', { askpass: false }), sink.events).done
    expect(result.output).toContain('a terminal is required')
    expect(sink.asks).toEqual([])
  })

  it('bounds the kept output', async () => {
    const sink = collect()
    const result = await new ShellRun(ctx.subprocess, options('head -c 200000 /dev/zero | tr "\\0" x', { captureBytes: 65_536 }), sink.events).done
    expect(result.captureTruncated).toBe(true)
    expect(Buffer.byteLength(result.output)).toBe(65_536)
  })

  it('fails to start in a missing directory', async () => {
    const sink = collect()
    const result = await new ShellRun(ctx.subprocess, options('true', { cwd: join(cwd, 'missing') }), sink.events).done
    expect(result.status.kind).toBe('failed')
  })
})
