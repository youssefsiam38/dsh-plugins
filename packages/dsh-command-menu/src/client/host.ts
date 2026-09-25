/**
 * The menu's view of the Web client: gathers {@link MenuFacts} from the
 * loaded client services and runs chosen entries through them. Every
 * service is optional: a missing one hides its entries instead of failing.
 *
 * Seams used (all public client services):
 * - `ctx.sessions` (Session Controller): the session list, the current
 *   session (the one the main view retains), `search()` for message text,
 *   and each session's `cancel()`;
 * - `ctx.uiWorkspace`: `openSession`, `startSession`, `openWorkspace`, `forkSession`;
 * - `ctx.workspaces`: workspace rows and the archived-session set;
 * - `ctx.modelDirectories`: the current session's shared model directory
 *   (the same state as the composer model control and `/model`);
 * - `ctx.remote.commands.list`: the current session's slash commands, run
 *   by writing `/name` into that session's composer and submitting it, the
 *   same path as typing it;
 * - `ctx.layout.toggleSidebar`, `ctx.sidebarRight.toggleExpanded`, `ctx.theme`;
 * - `settings.section` slot entries for the settings page list. The settings
 *   dialog keeps its open state inside its component, so opening a page
 *   clicks the sidebar settings trigger and then the page's nav button.
 * @module dsh-command-menu/client/host
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the Session Controller client service (`ctx.sessions`).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the Workspace Controller client service (`ctx.workspaces`).
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the Workspace navigation service (`ctx.uiWorkspace`).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the layout service (`ctx.layout`) and its `shell.overlay` slot.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the theme service (`ctx.theme`).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: the per-session model directories (`ctx.modelDirectories`).
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
// Type-only: the conversation service (`ctx.conversation`).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the `settings.section` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the renderer-owned slots service (`ctx.slots`).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { EMPTY_FACTS, SEARCH_OFF } from './entries.ts'
import type { CommandFact, Loadable, MenuFacts, MessageHit, ModelFact, SessionFact, SettingsFact, WorkspaceFact } from './entries.ts'
import type { MenuEntry } from './model.ts'

/** A Remote call result, as the typert protocol returns it. */
export type WireResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The slash-command descriptor fields the menu reads. */
interface CommandDescriptorView {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
}

/** Right-sidebar face the menu reads, when that plugin is loaded. */
interface SidebarRightView {
  toggleExpanded(): void
}

/** What running an entry produced. */
export type RunOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'notice'; readonly text: string }

/** Localized copy the host itself needs. */
export interface HostCopy {
  readonly matchNotFound: (title: string) => string
  readonly failed: (reason: string) => string
  readonly settingsUnavailable: string
  /** The settings trigger's accessible name, when the settings plugin's dictionary has one. */
  readonly settingsTrigger: () => string | undefined
}

/** How long a revealed message search match waits for the conversation to render, in ms. */
export const REVEAL_TIMEOUT = 4000

/** How long the settings dialog may take to mount after its trigger is clicked, in ms. */
export const SETTINGS_TIMEOUT = 1500

function service<T>(ctx: ClientContext, name: string): T | undefined {
  try {
    return ctx.get(name as never) as T | undefined
  } catch (error: unknown) {
    // An unregistered service is an absent capability.
    void error
    return undefined
  }
}

function frame(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 16) })
}

async function waitFor<T>(probe: () => T | undefined, timeout: number): Promise<T | undefined> {
  const deadline = Date.now() + timeout
  for (;;) {
    const found = probe()
    if (found !== undefined) return found
    if (Date.now() > deadline) return undefined
    await frame()
  }
}

/**
 * Find the first element under `root` whose own text contains `needle`, case-insensitively.
 * @param root - container to search.
 * @param needle - text to find.
 * @returns the element holding the matching text node.
 */
export function findTextElement(root: ParentNode, needle: string): HTMLElement | undefined {
  const lower = needle.toLowerCase()
  if (lower === '') return undefined
  const doc = (root as Node).ownerDocument ?? document
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.textContent ?? '').toLowerCase().includes(lower) && node.parentElement !== null) {
      if (node.parentElement.closest('[data-command-menu]') !== null) continue
      return node.parentElement
    }
  }
  return undefined
}

/** Live menu data plus the operations behind each entry. */
export class MenuHost {
  private facts: MenuFacts = EMPTY_FACTS
  private dirty = true
  private readonly listeners = new Set<() => void>()
  private commands: { sessionId: string; state: Loadable<CommandFact> } | undefined
  private modelSession: { sessionId: SessionId; unsubscribe: () => void } | undefined
  private modelsState: Loadable<ModelFact> = { status: 'unavailable' }

  /**
   * @param ctx - client root context.
   * @param copy - localized copy for notices.
   */
  constructor(private readonly ctx: ClientContext, private readonly copy: HostCopy) {}

  /**
   * Follow the sources the facts derive from.
   * @returns the disposer.
   */
  start(): () => void {
    const offs: Array<() => void> = []
    const invalidate = (): void => { this.invalidate() }
    const sessions = service<ISessions>(this.ctx, 'sessions')
    if (sessions !== undefined) offs.push(sessions.list.subscribe(invalidate))
    const workspaces = service<IWorkspaces>(this.ctx, 'workspaces')
    if (workspaces !== undefined) offs.push(workspaces.list.subscribe(invalidate))
    offs.push(this.ctx.on('theme/change', invalidate))
    const slots = service<ClientContext['slots']>(this.ctx, 'slots')
    if (slots !== undefined) {
      try {
        offs.push(slots.subscribe('settings.section', invalidate))
      } catch (error: unknown) {
        // No settings shell in this composition: no settings entries.
        void error
      }
    }
    return () => {
      for (const off of offs) off()
      this.modelSession?.unsubscribe()
      this.modelSession = undefined
    }
  }

  /** Observable read of the current facts. */
  getSnapshot = (): MenuFacts => {
    if (this.dirty) {
      this.facts = this.collect()
      this.dirty = false
    }
    return this.facts
  }

  /**
   * @param listener - called after the facts change.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Refresh per-session data when the menu opens: the command list and the model directory. */
  prepare(): void {
    this.invalidate()
    const current = this.getSnapshot().currentSessionId as SessionId | undefined
    this.loadCommands(current)
    this.followModels(current)
  }

  /**
   * Search message text through the Host.
   * @param text - literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns hits; rejects with the Host's message on failure.
   */
  searchMessages = async (text: string, signal: AbortSignal): Promise<readonly MessageHit[]> => {
    const sessions = service<ISessions>(this.ctx, 'sessions')
    if (sessions === undefined) return []
    const result = await sessions.search(text, signal)
    if (!result.ok) {
      const error = new Error(result.error.message)
      // The Host refuses content search when its index is configured off; the menu shows that as a setting, not a failure.
      if (/disabled/i.test(result.error.message)) error.name = SEARCH_OFF
      throw error
    }
    return result.value.items.map(item => ({ sessionId: item.sessionId, snippet: item.snippet }))
  }

  /**
   * Run one entry. The menu is already closed when this is called.
   * @param entry - the chosen entry.
   * @param query - the query text it was chosen with (used to reveal message matches).
   * @returns what happened.
   */
  async run(entry: MenuEntry, query: string): Promise<RunOutcome> {
    try {
      return await this.dispatch(entry, query)
    } catch (error: unknown) {
      return { kind: 'notice', text: this.copy.failed(error instanceof Error ? error.message : String(error)) }
    }
  }

  private async dispatch(entry: MenuEntry, query: string): Promise<RunOutcome> {
    const ref = entry.ref ?? ''
    const ui = service<ClientContext['uiWorkspace']>(this.ctx, 'uiWorkspace')
    switch (entry.kind) {
      case 'session':
        ui?.openSession(ref as SessionId)
        return { kind: 'done' }
      case 'message':
        ui?.openSession(ref as SessionId)
        return this.reveal(entry.title, query)
      case 'command':
        return this.runCommand(ref)
      case 'settings':
        return this.openSettings(ref)
      case 'theme':
        service<ClientContext['theme']>(this.ctx, 'theme')?.setTheme(ref)
        return { kind: 'done' }
      case 'model':
        return this.selectModel(ref)
      case 'workspace':
        await ui?.openWorkspace(ref as WorkspaceId)
        return { kind: 'done' }
      case 'scope':
        return { kind: 'done' }
      case 'action':
        return this.runAction(ref)
    }
  }

  private async runAction(ref: string): Promise<RunOutcome> {
    const ui = service<ClientContext['uiWorkspace']>(this.ctx, 'uiWorkspace')
    const current = this.getSnapshot().currentSessionId as SessionId | undefined
    if (ref.startsWith('new-session-in:')) {
      ui?.startSession(ref.slice('new-session-in:'.length) as WorkspaceId)
      return { kind: 'done' }
    }
    switch (ref) {
      case 'new-session':
        ui?.startSession()
        return { kind: 'done' }
      case 'toggle-sidebar':
        service<ClientContext['layout']>(this.ctx, 'layout')?.toggleSidebar()
        return { kind: 'done' }
      case 'toggle-rightbar':
        service<SidebarRightView>(this.ctx, 'sidebarRight')?.toggleExpanded()
        return { kind: 'done' }
      case 'toggle-theme': {
        const theme = service<ClientContext['theme']>(this.ctx, 'theme')
        if (theme !== undefined) theme.setTheme(theme.getTheme().active.colorScheme === 'dark' ? 'light' : 'dark')
        return { kind: 'done' }
      }
      case 'open-settings':
        return this.openSettings(undefined)
      case 'fork':
        if (current !== undefined) await ui?.forkSession(current)
        return { kind: 'done' }
      case 'stop': {
        if (current === undefined) return { kind: 'done' }
        const result = await service<ISessions>(this.ctx, 'sessions')?.binding(current)?.session.cancel()
        return result === undefined || result.ok ? { kind: 'done' } : { kind: 'notice', text: this.copy.failed(result.error.message) }
      }
      case 'focus-composer':
        this.composer(current)?.focus()
        return { kind: 'done' }
      default:
        return { kind: 'done' }
    }
  }

  private composer(sessionId: SessionId | undefined) {
    if (sessionId === undefined) return undefined
    const binding = service<ISessions>(this.ctx, 'sessions')?.binding(sessionId)
    if (binding === undefined) return undefined
    const conversation = service<ClientContext['conversation']>(binding.ctx, 'conversation')
    return conversation?.input.for(binding.ctx)
  }

  private runCommand(name: string): RunOutcome {
    const current = this.getSnapshot().currentSessionId as SessionId | undefined
    const input = this.composer(current)
    if (input === undefined) return { kind: 'notice', text: this.copy.failed(`/${name}`) }
    const state = this.commands?.state
    const descriptor = state?.status === 'ready' ? state.items.find(command => command.name === name) : undefined
    if (descriptor?.inputHint !== undefined) {
      // The command takes arguments: leave `/name ` in the composer for the user to finish.
      input.setDraft(`/${name} `)
      input.focus()
      return { kind: 'done' }
    }
    input.setDraft(`/${name}`)
    input.submit()
    return { kind: 'done' }
  }

  private async selectModel(key: string): Promise<RunOutcome> {
    const at = key.indexOf('\u0000')
    const selection = { provider: key.slice(0, at), model: key.slice(at + 1) }
    const current = this.getSnapshot().currentSessionId as SessionId | undefined
    const directories = service<ClientContext['modelDirectories']>(this.ctx, 'modelDirectories')
    if (current === undefined || directories === undefined) return { kind: 'done' }
    const result = await directories.directoryFor(current).select(selection)
    return result.ok ? { kind: 'done' } : { kind: 'notice', text: this.copy.failed(result.error.message) }
  }

  private async openSettings(label: string | undefined): Promise<RunOutcome> {
    const dialogNav = (): HTMLElement | undefined => {
      const nav = document.querySelector('[role="dialog"][aria-modal="true"] nav')
      return nav instanceof HTMLElement ? nav : undefined
    }
    if (dialogNav() === undefined) {
      const trigger = this.settingsTrigger()
      if (trigger === undefined) return { kind: 'notice', text: this.copy.settingsUnavailable }
      trigger.click()
    }
    const nav = await waitFor(dialogNav, SETTINGS_TIMEOUT)
    if (nav === undefined) return { kind: 'notice', text: this.copy.settingsUnavailable }
    if (label === undefined) return { kind: 'done' }
    const button = [...nav.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === label)
    button?.click()
    return { kind: 'done' }
  }

  private settingsTrigger(): HTMLElement | undefined {
    // The shell renders the `settings.trigger` slot content inside its trigger button.
    const slotted = document.querySelector('[data-slot="settings.trigger"]')?.closest('button')
    if (slotted instanceof HTMLElement) return slotted
    const label = this.copy.settingsTrigger()
    const candidates = [...document.querySelectorAll<HTMLElement>('button[aria-haspopup="dialog"]')]
    if (label !== undefined) {
      const named = candidates.find(button => button.getAttribute('aria-label') === label)
      if (named !== undefined) return named
    }
    const expandable = candidates.filter(button => button.hasAttribute('aria-expanded'))
    return expandable.length === 1 ? expandable[0] : undefined
  }

  private async reveal(title: string, query: string): Promise<RunOutcome> {
    const hit = await waitFor(() => {
      const scroller = document.querySelector('[data-conversation-scroll]')
      return scroller === null ? undefined : findTextElement(scroller, query)
    }, REVEAL_TIMEOUT)
    if (hit === undefined) return { kind: 'notice', text: this.copy.matchNotFound(title) }
    if (typeof hit.scrollIntoView === 'function') hit.scrollIntoView({ block: 'center' })
    hit.setAttribute('data-command-menu-hit', '')
    setTimeout(() => { hit.removeAttribute('data-command-menu-hit') }, 2400)
    return { kind: 'done' }
  }

  private invalidate(): void {
    this.dirty = true
    for (const listener of this.listeners) listener()
  }

  private loadCommands(sessionId: SessionId | undefined): void {
    if (sessionId === undefined) {
      this.commands = undefined
      return
    }
    const list = this.commandList()
    if (list === undefined) {
      this.commands = { sessionId, state: { status: 'unavailable' } }
      return
    }
    this.commands = { sessionId, state: { status: 'loading' } }
    const settle = (state: Loadable<CommandFact>): void => {
      if (this.commands?.sessionId !== sessionId) return
      this.commands = { sessionId, state }
      this.invalidate()
    }
    list(sessionId).then((result) => {
      settle(result.ok
        ? { status: 'ready', items: result.value.map(command => ({ name: command.name, description: command.description, ...command.input === undefined ? {} : { inputHint: command.input.hint } })) }
        : { status: 'error', message: result.error.message })
    }, (error: unknown) => { settle({ status: 'error', message: error instanceof Error ? error.message : String(error) }) })
  }

  private commandList(): ((sessionId: SessionId) => Promise<WireResult<readonly CommandDescriptorView[]>>) | undefined {
    const remote = service<Record<string, unknown>>(this.ctx, 'remote.commands')
    const list = remote?.['list']
    if (typeof list !== 'function') return undefined
    return sessionId => (list as (id: SessionId) => Promise<WireResult<readonly CommandDescriptorView[]>>).call(remote, sessionId)
  }

  private followModels(sessionId: SessionId | undefined): void {
    if (this.modelSession?.sessionId === sessionId && sessionId !== undefined) {
      void this.loadModels(sessionId)
      return
    }
    this.modelSession?.unsubscribe()
    this.modelSession = undefined
    this.modelsState = { status: 'unavailable' }
    const sessions = service<ISessions>(this.ctx, 'sessions')
    const directories = service<ClientContext['modelDirectories']>(this.ctx, 'modelDirectories')
    if (sessionId === undefined || directories === undefined || sessions?.binding(sessionId) === undefined) return
    if (sessions.subagentAddress(sessionId) !== undefined) return
    try {
      const directory = directories.directoryFor(sessionId)
      const sync = (): void => {
        this.modelsState = modelsOf(directory.store.getSnapshot())
        this.invalidate()
      }
      this.modelSession = { sessionId, unsubscribe: directory.store.subscribe(sync) }
      sync()
      void this.loadModels(sessionId)
    } catch (error: unknown) {
      // The session scope ended between the binding check and the lookup.
      void error
    }
  }

  private async loadModels(sessionId: SessionId): Promise<void> {
    try {
      await service<ClientContext['modelDirectories']>(this.ctx, 'modelDirectories')?.directoryFor(sessionId).load()
    } catch (error: unknown) {
      // The directory store carries the failure into the models state.
      void error
    }
  }

  private collect(): MenuFacts {
    const sessions = service<ISessions>(this.ctx, 'sessions')
    const workspaces = service<IWorkspaces>(this.ctx, 'workspaces')
    const ui = service<ClientContext['uiWorkspace']>(this.ctx, 'uiWorkspace')
    const theme = service<ClientContext['theme']>(this.ctx, 'theme')
    const layout = service<ClientContext['layout']>(this.ctx, 'layout')
    const list = sessions?.list.getSnapshot()
    const workspaceSnapshot = workspaces?.list.getSnapshot()
    const archived = new Set<string>(workspaceSnapshot?.archivedSessionIds ?? [])
    const owner = new Map<string, { id: string; title: string }>()
    const workspaceFacts: WorkspaceFact[] = []
    for (const workspace of workspaceSnapshot?.items ?? []) {
      const live = workspace.sessionIds.filter(id => !archived.has(id) && list?.byId[id] !== undefined && list.byId[id].blank !== true)
      workspaceFacts.push({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionCount: live.length })
      for (const id of workspace.sessionIds) owner.set(id, { id: workspace.workspaceId, title: workspace.title })
    }
    let currentSessionId: string | undefined
    const sessionFacts: SessionFact[] = []
    for (const id of list?.ids ?? []) {
      const summary = list?.byId[id]
      if (summary === undefined) continue
      const current = (summary.retainedBy.mainView ?? 0) > 0
      if (current) currentSessionId = id
      if (summary.origin === 'subagent' || summary.blank || archived.has(id)) continue
      const workspace = owner.get(id)
      sessionFacts.push({
        id,
        title: summary.displayTitle,
        ...summary.cwd === undefined ? {} : { cwd: summary.cwd },
        updatedAt: summary.updatedAt,
        running: summary.running,
        current,
        ...workspace === undefined ? {} : { workspaceId: workspace.id, workspaceTitle: workspace.title },
      })
    }
    const commands = currentSessionId !== undefined && this.commands?.sessionId === currentSessionId
      ? this.commands.state
      : { status: 'unavailable' as const }
    const models = this.modelSession !== undefined && this.modelSession.sessionId === currentSessionId
      ? this.modelsState
      : { status: 'unavailable' as const }
    const snapshot = theme?.getTheme()
    const running = currentSessionId === undefined ? false : list?.byId[currentSessionId as SessionId]?.running === true
    return {
      sessions: sessionFacts,
      workspaces: workspaceFacts,
      commands,
      models,
      settings: this.settingsSections(),
      ...snapshot === undefined ? {} : {
        themes: {
          preference: snapshot.preference,
          active: snapshot.active.colorScheme,
          options: snapshot.themes.map(option => ({ id: option.id, colorScheme: option.colorScheme })),
        },
      },
      capabilities: {
        newSession: ui !== undefined,
        sidebar: layout !== undefined,
        rightbar: service<SidebarRightView>(this.ctx, 'sidebarRight') !== undefined,
        settings: this.settingsTrigger() !== undefined,
        fork: ui !== undefined,
        stop: running,
        focusComposer: currentSessionId !== undefined,
      },
      ...currentSessionId === undefined ? {} : { currentSessionId },
      now: Date.now(),
    }
  }

  private settingsSections(): SettingsFact[] {
    const slots = service<ClientContext['slots']>(this.ctx, 'slots')
    if (slots === undefined) return []
    try {
      return slots.entries('settings.section')
        .map(entry => ({ id: entry.options.id ?? '', label: resolveSlotLabel(entry.options.label) ?? '', order: entry.options.order ?? 0 }))
        .filter(section => section.id !== '' && section.label !== '')
        .sort((a, b) => a.order - b.order)
        .map(({ id, label }) => ({ id, label }))
    } catch (error: unknown) {
      // No settings shell in this composition.
      void error
      return []
    }
  }
}

function modelsOf(state: ModelDirectoryState): Loadable<ModelFact> {
  if (state.status === 'error') return { status: 'error', message: state.error ?? '' }
  if (state.groups.length === 0 && (state.status === 'idle' || state.status === 'loading')) return { status: 'loading' }
  const current = state.pending ?? state.current
  return {
    status: 'ready',
    items: state.groups.flatMap(group => group.models.map(model => ({
      provider: group.id,
      providerName: group.name,
      id: model.id,
      name: model.name,
      current: current?.provider === group.id && current.model === model.id,
    }))),
  }
}
