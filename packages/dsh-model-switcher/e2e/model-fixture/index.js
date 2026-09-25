// Test-only model routes for the dsh-model-switcher browser test. Every model
// answers "Answered: <last message> | route=<provider>/<model> effort=<effort>",
// so the test can see which selection reached the request. The routes are also
// declared as configurable providers with a model discovery, so the picker can
// read their context windows and input types.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-model-switcher-e2e-models'
export const inject = ['llm']

const EFFORTS = { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' }

export const PROVIDERS = {
  'demo-local': { name: 'Local Echo', models: [{ id: 'echo', name: 'Echo', contextWindow: 32_000, input: ['text'] }] },
  'demo-anthropic': {
    name: 'Anthropic (demo)',
    models: [
      { id: 'claude-sonnet-demo', name: 'Claude Sonnet (demo)', contextWindow: 200_000, input: ['text', 'image'], reasoning: EFFORTS },
      { id: 'claude-haiku-demo', name: 'Claude Haiku (demo)', contextWindow: 200_000, input: ['text', 'image'] },
    ],
  },
  'demo-openrouter': {
    name: 'OpenRouter (demo)',
    models: [
      { id: 'openai/gpt-demo', name: 'GPT (demo)', contextWindow: 400_000, input: ['text', 'image'], reasoning: EFFORTS },
      { id: 'moonshotai/kimi-demo', name: 'Kimi (demo)', contextWindow: 256_000, input: ['text'] },
      { id: 'mistralai/sonic-demo', name: 'Sonic Mistral (demo)', contextWindow: 128_000, input: ['text'] },
    ],
  },
}

function text(message) {
  return (message.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
}

function modelOf(provider, id) {
  return PROVIDERS[provider]?.models.find(model => model.id === id)
}

class EchoAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: PROVIDERS[provider]?.name ?? provider }
  }

  listModels(provider) {
    return Promise.resolve((PROVIDERS[provider]?.models ?? []).map(model => ({ provider, id: model.id, name: model.name, inputModalities: model.input })))
  }

  resolveModel(provider, id) {
    const model = modelOf(provider, id)
    return Promise.resolve({
      provider,
      id,
      name: model?.name ?? id,
      context: { contextWindow: model?.contextWindow ?? 32_000 },
      inputModalities: model?.input ?? ['text'],
      ...model?.reasoning === undefined ? {} : { reasoning: model.reasoning },
    })
  }

  async * stream(options) {
    const messages = options.messages ?? []
    const human = messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1)
    const answer = `Answered: ${human === undefined ? '' : text(human).slice(0, 60)} | route=${options.provider}/${options.model} effort=${options.reasoningEffort ?? 'none'}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  const routes = Object.keys(PROVIDERS)
  ctx.effect(() => ctx.llm.registerAdapter(routes, new EchoAdapter()), 'e2e model routes')
  ctx.effect(() => ctx.llm.registerConfigurableProviders(routes.map(provider => ({
    provider, displayName: PROVIDERS[provider].name, settingsNs: 'e2e-models', settingsPath: [provider],
  }))), 'e2e configurable providers')
  ctx.effect(() => ctx.llm.registerModelDiscovery('e2e-models', request => Promise.resolve(
    (PROVIDERS[request.provider ?? '']?.models ?? []).map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, inputModalities: model.input })),
  )), 'e2e model discovery')
}
