// Test-only model route `e2e/echo` for the dsh-user-shell browser test. It
// answers "Answered: <last message> | shell=<commands>", where <commands> are
// the commands of every `user-shell` message in the request, so the test can
// see what reached the model.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-user-shell-e2e-model'
export const inject = ['llm']

function text(message) {
  return (message.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
}

class EchoAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'E2E' }
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: 'echo', name: 'Echo', inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: 'Echo', contextWindow: 128_000, inputModalities: ['text'] })
  }

  async * stream(options) {
    const messages = options.messages ?? []
    const human = messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1)
    const shell = messages
      .filter(message => message.role === 'user' && message.source?.kind === 'user-shell')
      .map(message => /<command>\n([^]*?)\n<\/command>/.exec(text(message))?.[1] ?? '?')
    const answer = `Answered: ${human === undefined ? '' : text(human).slice(0, 60)} | shell=${shell.join(',') || 'none'}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['e2e'], new EchoAdapter()), 'e2e model route')
}
