// Test-only model routes `e2e/echo` and `e2e/second` for the dsh-command-menu
// browser test. Each answers "Answered: <last message> | model=<id>", so the
// test can see which model a session's request went to.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-command-menu-e2e-model'
export const inject = ['llm']

const MODELS = [{ id: 'echo', name: 'Echo One' }, { id: 'second', name: 'Echo Second' }]

function text(message) {
  return (message.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
}

class EchoAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'E2E' }
  }

  listModels(provider) {
    return Promise.resolve(MODELS.map(model => ({ provider, id: model.id, name: model.name, inputModalities: ['text'] })))
  }

  resolveModel(provider, model) {
    const found = MODELS.find(candidate => candidate.id === model) ?? MODELS[0]
    return Promise.resolve({ provider, id: model, name: found.name, contextWindow: 128_000, inputModalities: ['text'] })
  }

  async * stream(options) {
    const messages = options.messages ?? []
    const human = messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1)
    const answer = `Answered: ${human === undefined ? '' : text(human).slice(0, 60)} | model=${options.model}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['e2e'], new EchoAdapter()), 'e2e model route')
}
