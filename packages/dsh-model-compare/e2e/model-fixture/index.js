// Test-only model route `e2e/*` for the dsh-model-compare browser test.
// Models `alpha` and `beta` stream "<model>: <last user text> | tools=<names>"
// in a few chunks and report usage with a cost. When the last user text
// contains "please write" and no tool result has come back yet, the model
// first calls the `write` tool; after the result it answers
// "<model>: tool-result=<first 80 chars of the result>".
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-model-compare-e2e-model'
export const inject = ['llm']

const MODELS = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
]

function text(message) {
  const content = message.content ?? []
  return (Array.isArray(content) ? content : [content])
    .map(block => (typeof block === 'string' ? block : block.type === 'text' ? block.text : ''))
    .join('')
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class CompareAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'E2E' }
  }

  listModels(provider) {
    return Promise.resolve(MODELS.map(model => ({ provider, id: model.id, name: model.name, inputModalities: ['text'] })))
  }

  resolveModel(provider, model) {
    const known = MODELS.find(candidate => candidate.id === model)
    return Promise.resolve({ provider, id: model, name: known?.name ?? model, context: { contextWindow: 128_000 }, inputModalities: ['text'] })
  }

  async * stream(options) {
    const messages = options.messages ?? []
    const human = messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1)
    const prompt = human === undefined ? '' : text(human).slice(0, 80)
    const last = messages.at(-1)
    const tools = (options.tools ?? []).map(tool => tool.name).sort().join(',') || 'none'
    if (prompt.includes('please write') && last?.role !== 'tool') {
      const id = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const args = JSON.stringify({ path: 'compare-probe.txt', content: 'written by a comparison lane' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 10, costUsd: 0.0001 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const answer = last?.role === 'tool'
      ? `${options.model}: tool-result=${text(last).replace(/\s+/g, ' ').slice(0, 80)}`
      : `${options.model}: ${prompt} | tools=${tools}`
    await sleep(options.model === 'beta' ? 400 : 150)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    const words = answer.split(' ')
    let sent = ''
    for (const [index, word] of words.entries()) {
      const piece = index === 0 ? word : ` ${word}`
      sent += piece
      yield { type: 'text-delta', index: 0, text: piece }
      await sleep(30)
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: sent } }
    yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: words.length * 2, cacheReadTokens: 200, costUsd: options.model === 'beta' ? 0.0042 : 0.0013 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['e2e'], new CompareAdapter()), 'e2e model route')
}
