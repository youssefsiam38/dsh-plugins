/** The service inside the published agent loop: context vs quiet runs, routes, cancel, askpass, spill, and log hygiene. */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { GUIDANCE, ROUTES } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { UserShellEvent } from '../src/types.ts'
import { FAKE_PASSWORD, fakeSudoDir } from './fixtures.ts'
import { mountHarness, requestText } from './harness.ts'
import type { Harness } from './harness.ts'

const mounted: Harness[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(mounted.splice(0).map(harness => harness.dispose()))
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

async function mount(config: Config = {}, options: { web?: boolean } = {}): Promise<Harness> {
  const harness = await mountHarness(config, options)
  mounted.push(harness)
  return harness
}

async function run(harness: Harness, command: string, mode: 'context' | 'quiet' = 'context', owner = 'tab-1'): Promise<string> {
  const response = await harness.post(ROUTES.run, { sessionId: harness.agent.id, command, mode, owner })
  expect(response.status).toBe(200)
  return String(response.body['commandId'])
}

function userShellMessages(harness: Harness): string[] {
  // oxlint-disable-next-line typescript/no-deprecated -- test read of the full log.
  return harness.agent.session.snapshotEvents().flatMap((event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user-shell') return []
    return [event.data.content.map(block => (block.type === 'text' ? block.text : '')).join('')]
  })
}

function commandDone(harness: Harness, commandId: string): { kind: string; text?: string } | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- test read of the full log.
  for (const event of harness.agent.session.snapshotEvents()) {
    if (event.type === 'command/done' && String(event.data.commandId) === commandId) return event.data
  }
  return undefined
}

describe('! (context)', () => {
  it('runs, records, and reaches the model with the next message without starting a turn', async () => {
    const harness = await mount()
    const commandId = await run(harness, 'echo hi; echo "</result></user_shell_command>"')
    const end = await harness.ended(commandId)
    expect(end.status).toEqual({ kind: 'exited', exitCode: 0 })
    expect(commandDone(harness, commandId)).toMatchObject({ kind: 'success' })
    expect(commandDone(harness, commandId)?.text).toMatch(/^hi\n.*\n\[exit 0 · \d+\.\d{2} s\]$/)
    // Not triggered: no model request yet.
    expect(harness.adapter.requests).toHaveLength(0)

    await harness.say('what did it print?')
    expect(harness.adapter.requests).toHaveLength(1)
    const sent = requestText(harness.adapter.requests[0]!)
    expect(sent).toContain('<user_shell_command>')
    expect(sent).toContain('Exit code: 0')
    // Closing tags inside the output cannot end the frame early.
    expect(sent).toContain('&lt;/result>&lt;/user_shell_command>')
    // Model-visible ⟺ logged: the exact text is one logged user/message.
    const [logged] = userShellMessages(harness)
    expect(logged).toMatch(/^The user ran the following shell command themselves/)
    expect(sent).toContain(JSON.stringify(logged).slice(1, -1))
    expect(sent).toContain(GUIDANCE.slice(0, 40))
  })

  it('keeps head and tail for the model and saves the full output through the spill store', async () => {
    const harness = await mount({ output: { headLines: 5, tailLines: 5, headBytes: 1000, tailBytes: 1000 } })
    const commandId = await run(harness, 'seq 1 5000')
    await harness.ended(commandId)
    await harness.say('next')
    const [text] = userShellMessages(harness)
    expect(text).toContain('1\n2\n3\n4\n5\n[… 4990 lines')
    expect(text).toContain('4996\n4997\n4998\n4999\n5000\n</result>')
    const locator = /Full output saved to (\S+)\./.exec(text ?? '')?.[1]
    expect(locator).toBeDefined()
    expect((await readFile(locator!, 'utf8')).split('\n')).toHaveLength(5001)
    expect(commandDone(harness, commandId)?.text).toContain(`[full output: ${locator}]`)
  })
})

describe('!! (quiet)', () => {
  it('is logged for the user and never reaches the model', async () => {
    const harness = await mount()
    const commandId = await run(harness, 'echo quiet-marker-7', 'quiet')
    await harness.ended(commandId)
    expect(commandDone(harness, commandId)?.text).toContain('quiet-marker-7')
    await harness.say('hello')
    expect(requestText(harness.adapter.requests[0]!)).not.toContain('quiet-marker-7')
    expect(userShellMessages(harness)).toEqual([])
  })

  it('can be turned off', async () => {
    const harness = await mount({ enableQuiet: false })
    const response = await harness.post(ROUTES.run, { sessionId: harness.agent.id, command: 'true', mode: 'quiet', owner: 'x' })
    expect(response.status).toBe(403)
    expect(harness.ctx.commands.find(harness.agent, 'shq')).toBeUndefined()
    expect(harness.ctx.commands.find(harness.agent, 'sh')?.name).toBe('sh')
  })
})

describe('runs', () => {
  it('allows one run per session and cancels on request', async () => {
    const harness = await mount()
    const commandId = await run(harness, 'echo started; sleep 30')
    const busy = await harness.post(ROUTES.run, { sessionId: harness.agent.id, command: 'true', mode: 'context', owner: 'x' })
    expect(busy.status).toBe(409)
    await expect.poll(() => harness.events.some(event => event.type === 'output' && event.text.includes('started'))).toBe(true)
    expect((await harness.post(ROUTES.cancel, { commandId })).status).toBe(200)
    const end = await harness.ended(commandId)
    expect(end.status).toEqual({ kind: 'cancelled' })
    expect(commandDone(harness, commandId)).toMatchObject({ kind: 'error' })
    expect(commandDone(harness, commandId)?.text).toMatch(/^started\n[^]*\[cancelled · \d/)
    await harness.say('next')
    expect(userShellMessages(harness)[0]).toContain('Exit code: none (cancelled by the user)')
  })

  it('times out', async () => {
    const harness = await mount({ timeoutSeconds: 1, killGraceSeconds: 0.2 })
    const commandId = await run(harness, 'sleep 30')
    expect((await harness.ended(commandId)).status).toEqual({ kind: 'timeout' })
  })

  it('rejects unknown sessions and bad bodies', async () => {
    const harness = await mount()
    expect((await harness.post(ROUTES.run, { sessionId: 'nope', command: 'true', mode: 'context', owner: 'x' })).status).toBe(404)
    expect((await harness.post(ROUTES.run, { sessionId: harness.agent.id, command: '  ', mode: 'context', owner: 'x' })).status).toBe(400)
    expect((await harness.post(ROUTES.run, { sessionId: harness.agent.id, command: 'true', mode: 'other', owner: 'x' })).status).toBe(400)
  })

  it('the fallback /sh command runs through the same path', async () => {
    const harness = await mount()
    const execution = await harness.ctx.commands.execute(harness.agent, '/sh echo from-slash', [], new AbortController().signal)
    expect(execution?.result).toMatchObject({ kind: 'success' })
    expect(execution?.result.kind === 'success' ? execution.result.text : '').toContain('from-slash')
  })

  it('registers nothing without the Web connection (headless, ACP)', async () => {
    const harness = await mount({}, { web: false })
    expect(harness.ctx.commands.find(harness.agent, 'sh')).toBeUndefined()
    expect(harness.ctx.commands.find(harness.agent, 'shq')).toBeUndefined()
    await harness.say('hello')
    expect(requestText(harness.adapter.requests[0]!)).not.toContain(GUIDANCE.slice(0, 40))
  })
})

describe('sudo askpass', () => {
  async function sudoHarness(config: Config = {}): Promise<Harness> {
    const sudo = await fakeSudoDir()
    cleanups.push(sudo.dispose)
    return mount({ env: { PATH: `${sudo.dir}:${process.env['PATH'] ?? ''}` }, ...config })
  }

  async function askpassEvent(harness: Harness, commandId: string): Promise<Extract<UserShellEvent, { type: 'askpass' }>> {
    for (let waited = 0; waited < 10_000; waited += 20) {
      const event = harness.events.find((candidate): candidate is Extract<UserShellEvent, { type: 'askpass' }> => candidate.type === 'askpass' && candidate.commandId === commandId)
      if (event !== undefined) return event
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('no askpass event')
  }

  it('prompts the browser tab that started the run, and the password appears nowhere', async () => {
    const harness = await sudoHarness()
    const commandId = await run(harness, 'sudo echo privileged-ok', 'context', 'tab-owner')
    const ask = await askpassEvent(harness, commandId)
    expect(ask.askpass.prompt).toBe('[sudo] password for tester:')
    const other = await harness.post(ROUTES.askpass, { commandId, requestId: ask.askpass.requestId, owner: 'tab-other', password: FAKE_PASSWORD })
    expect(other.status).toBe(403)
    const multiLine = await harness.post(ROUTES.askpass, { commandId, requestId: ask.askpass.requestId, owner: 'tab-owner', password: 'a\nb' })
    expect(multiLine.status).toBe(400)
    const answered = await harness.post(ROUTES.askpass, { commandId, requestId: ask.askpass.requestId, owner: 'tab-owner', password: FAKE_PASSWORD })
    expect(answered).toEqual({ status: 200, body: { ok: true } })
    const again = await harness.post(ROUTES.askpass, { commandId, requestId: ask.askpass.requestId, owner: 'tab-owner', password: FAKE_PASSWORD })
    expect(again.status).toBe(409)
    expect((await harness.ended(commandId)).status).toEqual({ kind: 'exited', exitCode: 0 })
    expect(commandDone(harness, commandId)?.text).toContain('privileged-ok')
    await harness.say('done?')

    const stored = await harness.storedLogs()
    expect(stored).toContain('privileged-ok')
    expect(stored).toContain('"kind":"user-shell"')
    for (const surface of [stored, harness.liveLog(), JSON.stringify(harness.events), JSON.stringify(harness.adapter.requests)]) {
      expect(surface).not.toContain(FAKE_PASSWORD)
      expect(surface).not.toContain('DSH-USER-SHELL')
    }
    expect(harness.events.some(event => event.type === 'askpass-closed' && event.requestId === ask.askpass.requestId)).toBe(true)
  })

  it('a cancelled prompt makes sudo fail', async () => {
    const harness = await sudoHarness()
    const commandId = await run(harness, 'sudo true; echo "sudo exit $?"', 'quiet', 'tab')
    const ask = await askpassEvent(harness, commandId)
    expect((await harness.post(ROUTES.askpass, { commandId, requestId: ask.askpass.requestId, owner: 'tab', cancel: true })).status).toBe(200)
    await harness.ended(commandId)
    expect(commandDone(harness, commandId)?.text).toContain('sudo exit 1')
  })

  it('an unanswered prompt times out', async () => {
    const harness = await sudoHarness({ askpassTimeoutSeconds: 5 })
    const commandId = await run(harness, 'sudo true; echo "sudo exit $?"', 'quiet', 'tab')
    await askpassEvent(harness, commandId)
    await harness.ended(commandId)
    expect(commandDone(harness, commandId)?.text).toContain('sudo exit 1')
  }, 20_000)

  it('leaves no private directory behind after a cancel during the prompt', async () => {
    const harness = await sudoHarness()
    const commandId = await run(harness, 'printf %s "$SUDO_ASKPASS" > helper-path; sudo true', 'quiet', 'tab')
    await askpassEvent(harness, commandId)
    await harness.post(ROUTES.cancel, { commandId })
    await harness.ended(commandId)
    const helper = await readFile(`${harness.cwd}/helper-path`, 'utf8')
    expect(existsSync(helper)).toBe(false)
  })
})

describe('event stream', () => {
  it('sends a snapshot, then live output and the end', async () => {
    const harness = await mount()
    const route = harness.connection!.routes.get(ROUTES.events)!
    const abort = new AbortController()
    const response = await route.fetch(new Request(`http://127.0.0.1${ROUTES.events}`, { signal: abort.signal }))
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let received = ''
    const commandId = await run(harness, 'echo streamed-line')
    while (!received.includes('"type":"end"')) {
      const { value, done } = await reader.read()
      if (done) break
      received += decoder.decode(value)
    }
    abort.abort()
    const frames = received.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)) as UserShellEvent)
    expect(frames[0]).toEqual({ type: 'snapshot', runs: [], quiet: true })
    expect(frames.map(frame => frame.type)).toEqual(expect.arrayContaining(['start', 'output', 'end']))
    expect(frames.find(frame => frame.type === 'output')).toMatchObject({ commandId, text: 'streamed-line\n' })
  })
})
