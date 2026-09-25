/** Shared test data: a translator and a populated facts snapshot. */
import type { MenuFacts, Translate } from '../../src/client/entries.ts'
import { en } from '../../src/client/locales.ts'
import type { CommandMenuKey } from '../../src/client/locales.ts'

export const t: Translate = (key: CommandMenuKey, params = {}) =>
  en[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))

export const NOW = Date.UTC(2026, 8, 25, 12, 0, 0)

export const FACTS: MenuFacts = {
  sessions: [
    { id: 's-old', title: 'Refactor the parser', updatedAt: NOW - 3 * 86_400_000, running: false, current: false, workspaceId: 'w1', workspaceTitle: 'harness' },
    { id: 's-now', title: 'Fix login bug', updatedAt: NOW - 5 * 60_000, running: false, current: true, workspaceId: 'w1', workspaceTitle: 'harness' },
    { id: 's-run', title: 'Write release notes', updatedAt: NOW - 2 * 3_600_000, running: true, current: false, workspaceId: 'w2', workspaceTitle: 'docs' },
  ],
  workspaces: [
    { id: 'w1', title: 'harness', path: '/home/me/harness', sessionCount: 2 },
    { id: 'w2', title: 'docs', path: '/home/me/docs', sessionCount: 1 },
  ],
  commands: {
    status: 'ready',
    items: [
      { name: 'compact', description: 'Compact older conversation history' },
      { name: 'goal', description: 'Set or view the goal', inputHint: '<objective>' },
    ],
  },
  models: {
    status: 'ready',
    items: [
      { provider: 'openrouter', providerName: 'OpenRouter', id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', current: true },
      { provider: 'openrouter', providerName: 'OpenRouter', id: 'openai/gpt-6', name: 'GPT-6', current: false },
    ],
  },
  settings: [{ id: 'general', label: 'General' }, { id: 'models', label: 'Models' }],
  themes: { preference: 'system', active: 'light', options: [{ id: 'light', colorScheme: 'light' }, { id: 'dark', colorScheme: 'dark' }] },
  capabilities: { newSession: true, sidebar: true, rightbar: true, settings: true, fork: true, stop: false, focusComposer: true },
  currentSessionId: 's-now',
  now: NOW,
}
