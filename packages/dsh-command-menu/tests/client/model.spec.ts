import { describe, expect, it } from 'vitest'
import { buildEntries, messageEntries, relativeAge } from '../../src/client/entries.ts'
import { buildSections, flatten, moveActive, parseQuery, rankEntries } from '../../src/client/model.ts'
import type { MenuEntry, ParsedQuery } from '../../src/client/model.ts'
import { EMPTY_FACTS } from '../../src/client/entries.ts'
import { FACTS, NOW, t } from './fixtures.ts'

function entry(id: string, title: string, extra: Partial<MenuEntry> = {}): MenuEntry {
  return { id, kind: 'action', group: 'actions', title, icon: 'command', order: 0, ...extra }
}

const sectionsFor = (query: ParsedQuery, recents: string[] = [], entries = buildEntries(FACTS, 'root', t)) =>
  buildSections({ entries, query, recents, recentLimit: 5, groupLimit: 8, showAll: false })

describe('parseQuery', () => {
  it.each([
    ['>comp', 'commands', 'comp'],
    ['/goal', 'commands', 'goal'],
    ['@ login', 'sessions', 'login'],
    ['#model', 'settings', 'model'],
    ['?', 'help', ''],
    ['  plain words ', 'all', 'plain words'],
  ])('%j is scope %s with text %j', (raw, scope, text) => {
    expect(parseQuery(raw, 'root')).toEqual({ scope, text })
  })

  it('treats prefixes as text on nested pages', () => {
    expect(parseQuery('>x', 'models')).toEqual({ scope: 'all', text: '>x' })
  })
})

describe('rankEntries', () => {
  it('requires every term and prefers title starts over detail contains', () => {
    const entries = [
      entry('a', 'Open settings', { detail: 'preferences' }),
      entry('b', 'Toggle sidebar', { detail: 'settings panel' }),
      entry('c', 'Settings sync', { order: 2 }),
    ]
    expect(rankEntries(entries, 'settings').map(hit => hit.entry.id)).toEqual(['c', 'a', 'b'])
    expect(rankEntries(entries, 'open settings').map(hit => hit.entry.id)).toEqual(['a'])
  })

  it('matches keywords and fuzzy acronyms', () => {
    const entries = [entry('n', 'New session', { keywords: ['create', 'chat'] }), entry('s', 'Switch model')]
    expect(rankEntries(entries, 'chat').map(hit => hit.entry.id)).toEqual(['n'])
    expect(rankEntries(entries, 'sm')[0]?.entry.id).toBe('s')
  })

  it('never lets a keyword hit or a recent use outrank a better title match', () => {
    const entries = [entry('dark', 'Dark', { keywords: ['light', 'dark'], boost: 1 }), entry('light', 'Light', { keywords: ['light', 'dark'] })]
    expect(rankEntries(entries, 'light', ['dark']).map(hit => hit.entry.id)).toEqual(['light', 'dark'])
  })

  it('breaks ties with recent use, then boost, then order', () => {
    const entries = [entry('x', 'Deploy one', { order: 0 }), entry('y', 'Deploy two', { order: 1 }), entry('z', 'Deploy three', { order: 2, boost: 1 })]
    expect(rankEntries(entries, 'deploy').map(hit => hit.entry.id)).toEqual(['z', 'x', 'y'])
    expect(rankEntries(entries, 'deploy', ['y']).map(hit => hit.entry.id)).toEqual(['y', 'z', 'x'])
  })
})

describe('buildSections', () => {
  it('lists recents, actions, and sessions on a blank query; commands, settings, and models wait for a query', () => {
    const sections = sectionsFor({ scope: 'all', text: '' }, ['session:s-old', 'command:compact', 'gone'])
    expect(sections.map(section => section.group)).toEqual(['recent', 'actions', 'sessions', 'scopes'])
    expect(sections[0]?.entries.map(item => item.id)).toEqual(['session:s-old', 'command:compact'])
    // Recents are not repeated below.
    expect(sections.find(section => section.group === 'sessions')?.entries.map(item => item.id)).toEqual(['session:s-now', 'session:s-run'])
  })

  it('orders sessions newest first and marks the current and running ones', () => {
    const sessions = buildEntries(FACTS, 'root', t).filter(item => item.kind === 'session')
    expect(sessions.map(item => [item.title, item.hint])).toEqual([
      ['Fix login bug', 'Current'],
      ['Write release notes', 'Running'],
      ['Refactor the parser', '3d'],
    ])
  })

  it('orders typed groups by their best hit and caps each group', () => {
    const sections = sectionsFor({ scope: 'all', text: 'model' })
    expect(sections[0]?.group).toBe('settings')
    expect(sections.map(section => section.group)).toEqual(['settings', 'actions'])
    expect(sectionsFor({ scope: 'all', text: 'sonnet' }).map(section => section.group)).toEqual(['models'])
    const capped = buildSections({ entries: buildEntries(FACTS, 'root', t), query: { scope: 'all', text: 'e' }, recents: [], recentLimit: 5, groupLimit: 1, showAll: false })
    for (const section of capped) expect(section.entries.length).toBeLessThanOrEqual(1)
    expect(capped.some(section => section.more !== undefined)).toBe(true)
  })

  it('narrows to a scope and puts its main group first', () => {
    expect(sectionsFor({ scope: 'commands', text: '' }).map(section => section.group)).toEqual(['commands', 'actions'])
    expect(sectionsFor({ scope: 'settings', text: '' }).map(section => section.group)).toEqual(['settings', 'themes'])
    expect(flatten(sectionsFor({ scope: 'sessions', text: 'docs' })).map(item => item.id)).toEqual(['workspace:w2', 'session:s-run'])
  })

  it('keeps message hits after the ranked groups in Host order, one per session', () => {
    const hits = messageEntries([
      { sessionId: 's-old', snippet: 'the  parser\nfails' },
      { sessionId: 's-old', snippet: 'again' },
      { sessionId: 'unknown', snippet: 'x' },
      { sessionId: 's-now', snippet: 'parser fix' },
    ], FACTS, 'parser')
    expect(hits.map(hit => [hit.ref, hit.detail])).toEqual([['s-old', 'the parser fails'], ['s-now', 'parser fix']])
    const sections = sectionsFor({ scope: 'all', text: 'parser' }, [], [...buildEntries(FACTS, 'root', t), ...hits])
    expect(sections.at(-1)?.group).toBe('messages')
    expect(sections.at(-1)?.entries.map(item => item.ref)).toEqual(['s-old', 's-now'])
  })

  it('shows every row of a nested page', () => {
    const models = buildSections({ entries: buildEntries(FACTS, 'models', t), query: parseQuery('', 'models'), recents: [], recentLimit: 5, groupLimit: 1, showAll: true })
    expect(flatten(models).map(item => [item.title, item.current === true])).toEqual([['Claude Sonnet 5', true], ['GPT-6', false]])
  })
})

describe('buildEntries', () => {
  it('offers only the actions the loaded services support', () => {
    const none = buildEntries(EMPTY_FACTS, 'root', t).filter(item => item.kind === 'action').map(item => item.ref)
    expect(none).toEqual(['scopes'])
    const all = buildEntries(FACTS, 'root', t).filter(item => item.kind === 'action').map(item => item.ref)
    expect(all).toEqual(['new-session', 'models', 'workspaces', 'toggle-theme', 'themes', 'toggle-sidebar', 'toggle-rightbar', 'open-settings', 'fork', 'focus-composer', 'scopes'])
  })

  it('builds the theme, workspace, and help pages', () => {
    expect(buildEntries(FACTS, 'themes', t).map(item => [item.ref, item.current === true])).toEqual([['system', true], ['light', false], ['dark', false]])
    expect(buildEntries(FACTS, 'workspace:w1', t).map(item => item.id)).toEqual(['action:new-session-in:w1', 'session:s-now', 'session:s-old'])
    expect(buildEntries(FACTS, 'help', t).map(item => item.ref)).toEqual(['>', '@', '#'])
  })

  it('shows a command taking input with its hint', () => {
    const goal = buildEntries(FACTS, 'root', t).find(item => item.id === 'command:goal')
    expect(goal?.title).toBe('/goal')
    expect(goal?.detail).toContain('Takes input: <objective>')
  })
})

describe('relativeAge and moveActive', () => {
  it.each([
    [NOW - 10_000, 'now'], [NOW - 5 * 60_000, '5m'], [NOW - 3 * 3_600_000, '3h'], [NOW - 2 * 86_400_000, '2d'],
    [NOW - 65 * 86_400_000, '2mo'], [NOW - 800 * 86_400_000, '2y'],
  ])('%d is %s', (at, label) => {
    expect(relativeAge(at, NOW, t)).toBe(label)
  })

  it('wraps and clamps', () => {
    expect(moveActive('ArrowDown', -1, 3)).toBe(0)
    expect(moveActive('ArrowDown', 2, 3)).toBe(0)
    expect(moveActive('ArrowUp', 0, 3)).toBe(2)
    expect(moveActive('End', 0, 3)).toBe(2)
    expect(moveActive('PageDown', 0, 3)).toBe(2)
    expect(moveActive('PageUp', 2, 3)).toBe(0)
    expect(moveActive('Home', 2, 0)).toBe(-1)
  })
})
