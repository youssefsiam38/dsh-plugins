// Test-only model route `e2e/flaky` for the dsh-session-retry browser test.
// The last user message decides the outcome, so the scenario drives failures
// from the composer:
// - a message containing FAIL fails with a transport error;
// - "(Automatic retry 2/..." fails too, so the next slot is far enough away to observe;
// - anything else answers.
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

// One quick per-request retry keeps each failing turn short.
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
}, 'e2e model retryPolicy')

export const name = 'dsh-session-retry-e2e-model'
export const inject = ['llm']

function lastUserText(options) {
  const messages = options.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // Skip context the harness injects as user messages (skills, time, instructions).
    if (message.role !== 'user' || !['user', 'session-retry'].includes(message.source?.kind)) continue
    return (message.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
  }
  return ''
}

class FlakyAdapter extends LlmAdapter {
  providerRetryPolicy() {
    return RETRY_POLICY
  }

  providerInfo(provider) {
    return { id: provider, name: 'E2E' }
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: 'flaky', name: 'Flaky', inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: 'Flaky', contextWindow: 128_000, inputModalities: ['text'] })
  }

  async * stream(options) {
    const text = lastUserText(options)
    if (text.includes('FAIL') || text.startsWith('(Automatic retry 2/')) {
      throw new LlmError('connection reset by peer', 'TRANSPORT')
    }
    const answer = `Answered: ${text.slice(0, 60)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['e2e'], new FlakyAdapter()), 'e2e model route')
}
