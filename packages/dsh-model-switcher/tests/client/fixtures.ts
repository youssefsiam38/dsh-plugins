/** Directory data shared by the client tests. */

import type { ModelCatalogFailure, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'

export const GROUPS: readonly ModelProviderGroup[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [
      { id: 'openai/gpt-5', name: 'GPT-5', description: 'OpenAI flagship', reasoning: { efforts: [{ id: 'minimal', name: 'Minimal' }, { id: 'medium', name: 'Medium' }] } },
      { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4' },
      { id: 'moonshotai/kimi-k2', name: 'Kimi K2' },
    ],
  },
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  },
]

export const FAILURES: readonly ModelCatalogFailure[] = [
  { id: 'groq', name: 'Groq', message: 'HTTP 401' },
]
