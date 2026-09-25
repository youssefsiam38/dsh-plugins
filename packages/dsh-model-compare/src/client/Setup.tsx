/**
 * Comparison setup: pick 2–4 models from the Host catalog (favorites and
 * recents of `dsh-model-switcher` first), optionally an effort per model, and
 * type the prompt.
 */

import { useId, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { CatalogGroup, CompareModel, CompareStateResponse } from '../types.ts'
import type { ModelCompareKey } from './locales.ts'
import type { SwitcherPrefs } from './prefs.ts'
import { CLASS } from './styles.ts'

/** Translator for this plugin's namespace. */
export type Translate = (key: ModelCompareKey, params?: Record<string, string | number>) => string

/** One pickable catalog row. */
export interface ModelRow {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly name: string
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
}

/** A row in the selection, with its chosen effort. */
export interface Picked extends ModelRow {
  readonly key: string
  readonly reasoningEffort?: string
}

/**
 * Flatten the catalog groups.
 * @param groups - catalog groups.
 * @returns every model row.
 */
export function catalogRows(groups: readonly CatalogGroup[]): ModelRow[] {
  return groups.flatMap(group => group.models.map(model => ({
    provider: group.id,
    providerName: group.name,
    model: model.id,
    name: model.name,
    efforts: model.efforts,
  })))
}

/**
 * Rows to list for a query: favorites, then recents, then the rest, each
 * filtered by every whitespace-separated query term.
 * @param rows - all rows.
 * @param prefs - switcher favorites and recents.
 * @param query - search text.
 * @returns sections with their rows.
 */
export function listRows(rows: readonly ModelRow[], prefs: SwitcherPrefs, query: string): Array<{ section: 'favorites' | 'recents' | 'all'; rows: ModelRow[] }> {
  const terms = query.toLowerCase().split(/\s+/).filter(term => term !== '')
  const matches = (row: ModelRow) => terms.every(term => `${row.name} ${row.model} ${row.providerName} ${row.provider}`.toLowerCase().includes(term))
  const find = (pair: { provider: string; model: string }) => rows.find(row => row.provider === pair.provider && row.model === pair.model)
  const favorites = prefs.favorites.map(find).filter((row): row is ModelRow => row !== undefined && matches(row))
  const recents = prefs.recents.map(find).filter((row): row is ModelRow => row !== undefined && matches(row) && !favorites.includes(row))
  const rest = rows.filter(row => matches(row) && !favorites.includes(row) && !recents.includes(row))
  return [
    { section: 'favorites' as const, rows: favorites },
    { section: 'recents' as const, rows: recents },
    { section: 'all' as const, rows: rest },
  ].filter(section => section.rows.length > 0)
}

/** Props of {@link Setup}. */
export interface SetupProps {
  readonly state: CompareStateResponse
  readonly prefs: SwitcherPrefs
  readonly busy: boolean
  readonly error: string | undefined
  readonly onStart: (prompt: string, models: CompareModel[]) => void
  readonly t: Translate
}

let pickCounter = 0

/**
 * Model picker and prompt box.
 * @param props - catalog state, preferences, and the start callback.
 * @returns the setup form.
 */
export function Setup({ state, prefs, busy, error, onStart, t }: SetupProps) {
  const { settings, catalog } = state
  const rows = useMemo(() => catalogRows(catalog.groups), [catalog.groups])
  const [picked, setPicked] = useState<Picked[]>(() => {
    const first = catalog.default === null ? undefined : rows.find(row => row.provider === catalog.default?.provider && row.model === catalog.default.model)
    return first === undefined ? [] : [{ ...first, key: `pick-${pickCounter++}` }]
  })
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const listId = useId()
  const full = picked.length >= settings.maxModels
  const sections = useMemo(() => listRows(rows, prefs, query), [rows, prefs, query])
  const ready = !busy && picked.length >= settings.minModels && prompt.trim() !== ''

  const add = (row: ModelRow) => {
    if (full) return
    setPicked(current => [...current, { ...row, key: `pick-${pickCounter++}` }])
    setQuery('')
    setOpen(false)
  }
  const submit = () => {
    if (!ready) return
    onStart(prompt.trim(), picked.map(pick => ({
      provider: pick.provider,
      model: pick.model,
      ...pick.reasoningEffort === undefined ? {} : { reasoningEffort: pick.reasoningEffort },
    })))
  }
  const onPromptKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  if (rows.length === 0) {
    return <div className={CLASS.setup} data-model-compare-setup=""><p className={CLASS.notice}>{t('setup.empty')}</p></div>
  }

  return (
    <div className={CLASS.setup} data-model-compare-setup="">
      <h2 className={CLASS.title}>{t('setup.title')}</h2>
      <p className={CLASS.muted}>{t('setup.intro', { min: settings.minModels, max: settings.maxModels })}</p>
      <div className={CLASS.field}>
        <span className={CLASS.label}>{t('setup.models')}</span>
        <ul className={CLASS.chips} aria-label={t('setup.models')}>
          {picked.map(pick => (
            <li key={pick.key} className={CLASS.chip} data-model-compare-chip={`${pick.provider}/${pick.model}`}>
              <span className={CLASS.chipName} title={`${pick.providerName} · ${pick.model}`}>{pick.name}</span>
              {pick.efforts.length > 0 && (
                <select
                  className={CLASS.effort}
                  aria-label={t('setup.effort', { model: pick.name })}
                  value={pick.reasoningEffort ?? ''}
                  onChange={(event) => {
                    const value = event.target.value
                    setPicked(current => current.map(item => item.key === pick.key
                      ? { ...item, ...value === '' ? { reasoningEffort: undefined } : { reasoningEffort: value } }
                      : item))
                  }}
                >
                  <option value="">{t('setup.effortDefault')}</option>
                  {pick.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                </select>
              )}
              <button
                type="button"
                className={CLASS.chipRemove}
                aria-label={t('setup.remove', { model: pick.name })}
                onClick={() => { setPicked(current => current.filter(item => item.key !== pick.key)) }}
              >×</button>
            </li>
          ))}
        </ul>
        <div className={CLASS.combo}>
          <input
            type="search"
            className={CLASS.input}
            placeholder={full ? t('setup.full', { max: settings.maxModels }) : t('setup.add')}
            aria-label={t('setup.search')}
            aria-expanded={open}
            aria-controls={listId}
            role="combobox"
            disabled={full}
            value={query}
            onFocus={() => { setOpen(true) }}
            onBlur={() => { setTimeout(() => { setOpen(false) }, 150) }}
            onChange={(event) => {
              setQuery(event.target.value)
              setOpen(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false)
              if (event.key === 'Enter') {
                event.preventDefault()
                const first = sections[0]?.rows[0]
                if (first !== undefined) add(first)
              }
            }}
          />
          {open && !full && (
            <div className={CLASS.menu} id={listId} role="listbox">
              {sections.length === 0 && <div className={CLASS.muted}>{t('setup.noMatch')}</div>}
              {sections.map(section => (
                <div key={section.section} role="group" aria-label={section.section === 'favorites' ? t('setup.favorites') : section.section === 'recents' ? t('setup.recents') : undefined}>
                  {section.section !== 'all' && <div className={CLASS.menuHeading}>{section.section === 'favorites' ? t('setup.favorites') : t('setup.recents')}</div>}
                  {section.rows.map(row => (
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      key={`${section.section}:${row.provider}\u0000${row.model}`}
                      className={CLASS.option}
                      data-model-compare-option={`${row.provider}/${row.model}`}
                      onMouseDown={(event) => { event.preventDefault() }}
                      onClick={() => { add(row) }}
                    >
                      <span>{row.name}</span>
                      <span className={CLASS.muted}>{row.providerName}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <label className={CLASS.field}>
        <span className={CLASS.label}>{t('setup.prompt')}</span>
        <textarea
          className={CLASS.textarea}
          rows={4}
          maxLength={settings.maxPromptChars}
          placeholder={t('setup.placeholder')}
          value={prompt}
          onChange={(event) => { setPrompt(event.target.value) }}
          onKeyDown={onPromptKey}
          data-model-compare-prompt=""
        />
      </label>
      <p className={CLASS.muted} data-model-compare-tools={settings.tools}>{t(`tools.${settings.tools}`)}</p>
      {catalog.failures.length > 0 && <p className={CLASS.muted}>{t('setup.failures', { names: catalog.failures.map(failure => failure.name).join(', ') })}</p>}
      {error !== undefined && <p className={CLASS.error} role="alert">{error}</p>}
      <div className={CLASS.footer}>
        <span className={CLASS.muted}>
          {picked.length >= settings.minModels && t('setup.cost', { count: picked.length })}
          {settings.maxOutputTokens > 0 && ` ${t('setup.cap', { tokens: settings.maxOutputTokens })}`}
        </span>
        <button type="button" className={CLASS.primary} disabled={!ready} onClick={submit} data-model-compare-start="">
          {busy ? t('setup.starting') : t('setup.submit')}
        </button>
      </div>
    </div>
  )
}
