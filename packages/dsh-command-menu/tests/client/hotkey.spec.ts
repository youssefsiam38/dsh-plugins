import { describe, expect, it } from 'vitest'
import { hotkeyLabels, isApplePlatform, isToggleEvent, matchesHotkey, parseHotkey } from '../../src/client/hotkey.ts'
import type { KeyInput } from '../../src/client/hotkey.ts'
import { RECENTS_CAP, RecentsStore, parseRecents } from '../../src/client/recents.ts'
import { en, zh } from '../../src/client/locales.ts'

function key(code: string, mods: Partial<KeyInput> = {}): KeyInput {
  return {
    code, key: code.replace(/^Key/, '').toLowerCase(), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, defaultPrevented: false, ...mods,
  }
}

describe('hotkeys', () => {
  it('maps Mod to Command on Apple platforms and Control elsewhere', () => {
    expect(isApplePlatform('MacIntel')).toBe(true)
    expect(isApplePlatform('Linux x86_64')).toBe(false)
    const mac = parseHotkey('Mod+K', true)
    const pc = parseHotkey('Mod+K', false)
    expect(matchesHotkey(mac, key('KeyK', { metaKey: true }))).toBe(true)
    expect(matchesHotkey(mac, key('KeyK', { ctrlKey: true }))).toBe(false)
    expect(matchesHotkey(pc, key('KeyK', { ctrlKey: true }))).toBe(true)
    expect(hotkeyLabels(mac, true)).toEqual(['⌘', 'K'])
    expect(hotkeyLabels(parseHotkey('Ctrl+Shift+P', false), false)).toEqual(['Ctrl', 'Shift', 'P'])
  })

  it('matches exact modifiers and physical keys', () => {
    const hotkey = parseHotkey('Mod+Shift+Slash', false)
    expect(matchesHotkey(hotkey, key('Slash', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(matchesHotkey(hotkey, key('Slash', { ctrlKey: true }))).toBe(false)
    expect(matchesHotkey(parseHotkey('Mod+K', false), key('KeyK', { ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('yields to a handler that took the key, to input-method composition, and to held keys', () => {
    const hotkeys = [parseHotkey('Mod+K', false)]
    expect(isToggleEvent(hotkeys, key('KeyK', { ctrlKey: true }))).toBe(true)
    expect(isToggleEvent(hotkeys, key('KeyK', { ctrlKey: true, defaultPrevented: true }))).toBe(false)
    expect(isToggleEvent(hotkeys, key('KeyK', { ctrlKey: true, isComposing: true }))).toBe(false)
    expect(isToggleEvent(hotkeys, key('KeyK', { ctrlKey: true, repeat: true }))).toBe(false)
    expect(isToggleEvent([], key('KeyK', { ctrlKey: true }))).toBe(false)
  })
})

describe('recents', () => {
  function storage(initial?: string) {
    const data = new Map<string, string>(initial === undefined ? [] : [['dsh-command-menu:recents', initial]])
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
  }

  it('moves used ids to the front, persists them, and forgets on request', () => {
    const backing = storage()
    const store = new RecentsStore(backing)
    let changes = 0
    store.subscribe(() => { changes += 1 })
    store.touch('a')
    store.touch('b')
    store.touch('a')
    expect(store.getSnapshot()).toEqual(['a', 'b'])
    expect(new RecentsStore(backing).getSnapshot()).toEqual(['a', 'b'])
    store.forget('b')
    store.forget('missing')
    expect(store.getSnapshot()).toEqual(['a'])
    expect(changes).toBe(4)
  })

  it('drops corrupt storage and caps the list', () => {
    expect(parseRecents('{nope')).toEqual([])
    expect(parseRecents('{"a":1}')).toEqual([])
    expect(parseRecents(JSON.stringify(['x', 3, 'x', 'y']))).toEqual(['x', 'y'])
    const store = new RecentsStore(storage())
    for (let index = 0; index < RECENTS_CAP + 5; index += 1) store.touch(`id-${index}`)
    expect(store.getSnapshot()).toHaveLength(RECENTS_CAP)
  })

  it('keeps working in memory when storage throws', () => {
    const store = new RecentsStore({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } })
    store.touch('a')
    expect(store.getSnapshot()).toEqual(['a'])
  })

  it('has a complete Chinese dictionary', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
