// Test-only model route `e2e/editor` and two tools for the dsh-hunk-review
// browser test.
// - "setup" calls `e2e_setup`: a git repository in the session workspace with
//   a committed 30-line `review.txt`; the answer names the workspace.
// - "edit" calls `e2e_edit`: changes lines 3 and 25 of `review.txt`.
// - anything else answers "Answered: <message> | reverted=<path:hunks,...>"
//   from the `hunk-review` notes in the request.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-hunk-review-e2e-model'
export const inject = ['llm', 'tools']

export const ORIGINAL = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'

function text(message) {
  return (message.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
}

let calls = 0

class EditorAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'E2E' }
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: 'editor', name: 'Editor', inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: 'Editor', contextWindow: 128_000, inputModalities: ['text'] })
  }

  async * stream(options) {
    const messages = options.messages ?? []
    const last = messages.at(-1)
    if (last?.role === 'tool') {
      const answer = `Tool done: ${text(last)}`
      yield* this.say(answer)
      return
    }
    const human = messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1)
    const said = human === undefined ? '' : text(human).trim()
    if (said === 'setup' || said === 'edit') {
      calls += 1
      const id = `e2e-${calls}`
      const tool = said === 'setup' ? 'e2e_setup' : 'e2e_edit'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const reverted = messages
      .filter(message => message.role === 'user' && message.source?.kind === 'hunk-review')
      .flatMap(message => message.source.files.map(file => `${file.path}:${file.hunks.join('+')}`))
    yield* this.say(`Answered: ${said.slice(0, 60)} | reverted=${reverted.join(',') || 'none'}`)
  }

  async * say(answer) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function tool(toolName, run) {
  return {
    name: toolName,
    description: `E2E fixture tool ${toolName}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: (_args, exec) => {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) return Promise.reject(new Error('no workspace'))
      return Promise.resolve({ text: run(cwd) })
    },
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['e2e'], new EditorAdapter()), 'e2e model route')
  ctx.effect(() => ctx.tools.register(tool('e2e_setup', (cwd) => {
    const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' })
    git('init', '-q')
    writeFileSync(join(cwd, 'review.txt'), ORIGINAL)
    git('add', 'review.txt')
    git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'init')
    return `workspace=[${cwd}]`
  })), 'e2e setup tool')
  ctx.effect(() => ctx.tools.register(tool('e2e_edit', (cwd) => {
    const lines = readFileSync(join(cwd, 'review.txt'), 'utf8').split('\n')
    lines[2] = 'line 3 changed by the agent'
    lines[24] = 'line 25 changed by the agent'
    writeFileSync(join(cwd, 'review.txt'), lines.join('\n'))
    return 'edited review.txt'
  })), 'e2e edit tool')
}
