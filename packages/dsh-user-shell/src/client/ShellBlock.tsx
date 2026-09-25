/**
 * Transcript block of one `!` / `!!` run: badge, command, live or recorded
 * output, exit status and duration, Cancel while running, and the masked
 * password field while sudo asks. Live state comes from {@link UserShellStore};
 * once the `command/done` record exists the block renders from the record.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { parseRecord } from '../record.ts'
import type { UserShellMode, UserShellStatus } from '../types.ts'
import type { UserShellKey } from './locales.ts'
import type { ClientRun, UserShellStore } from './store.ts'

/** Class names; the stylesheet lives in `./styles.ts`. */
export const CLASS = {
  block: 'dsh-user-shell-block',
  header: 'dsh-user-shell-header',
  badge: 'dsh-user-shell-badge',
  command: 'dsh-user-shell-command',
  status: 'dsh-user-shell-status',
  output: 'dsh-user-shell-output',
  note: 'dsh-user-shell-note',
  askpass: 'dsh-user-shell-askpass',
  error: 'dsh-user-shell-error',
  mode: 'dsh-user-shell-mode',
} as const

/** The durable command record the chat passes to the block. */
export interface ShellBlockNode {
  readonly commandId: string
  readonly args: string | null
  readonly outcome: { readonly kind: 'success' | 'error'; readonly text?: string } | null
}

/** Props of {@link ShellBlock}. */
export interface ShellBlockProps {
  readonly node: ShellBlockNode
  readonly mode: UserShellMode
  readonly store: UserShellStore
  readonly t: Translate<UserShellKey>
}

function statusText(status: UserShellStatus, t: Translate<UserShellKey>): string {
  switch (status.kind) {
    case 'exited': return t('status.exit', { code: status.exitCode })
    case 'signal': return t('status.signal', { signal: status.signal })
    case 'cancelled': return t('status.cancelled')
    case 'timeout': return t('status.timeout')
    case 'failed': return t('status.failed', { reason: status.message })
  }
}

/**
 * Subscribe to one run of the store.
 * @param store - live store.
 * @param commandId - pairing id.
 * @returns the run, re-rendering on change.
 */
export function useRun(store: UserShellStore, commandId: string): ClientRun | undefined {
  return useSyncExternalStore(
    useCallback(listener => store.subscribe(listener), [store]),
    () => store.run(commandId),
  )
}

function AskpassForm({ run, store, t }: { run: ClientRun; store: UserShellStore; t: Translate<UserShellKey> }) {
  const askpass = run.askpass
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  useEffect(() => { input.current?.focus() }, [askpass?.requestId])
  if (askpass === undefined) return null
  if (!run.owned) return <div className={CLASS.askpass} role="status">{t('askpass.otherTab')}</div>
  const send = async (password: string | undefined): Promise<void> => {
    setBusy(true)
    // The field is cleared before the request so the password does not stay in the page.
    if (input.current !== null) input.current.value = ''
    const result = await store.answer(run.commandId, askpass, password)
    setBusy(false)
    setFailed(result.ok ? undefined : result.error)
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void send(input.current?.value ?? '')
  }
  return (
    <form className={CLASS.askpass} onSubmit={submit} data-user-shell-askpass={askpass.requestId}>
      <label>
        <span>{askpass.prompt === '' ? t('askpass.label') : `${t('askpass.label')}: ${askpass.prompt}`}</span>
        <input ref={input} type="password" autoComplete="off" spellCheck={false} placeholder={t('askpass.placeholder')} disabled={busy} aria-label={t('askpass.placeholder')} />
      </label>
      <Button type="submit" size="sm" disabled={busy}>{t('askpass.submit')}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { void send(undefined) }}>{t('askpass.cancel')}</Button>
      {failed !== undefined && <span className={CLASS.error} role="alert">{failed}</span>}
    </form>
  )
}

/** One run in the transcript. */
export function ShellBlock({ node, mode, store, t }: ShellBlockProps) {
  const live = useRun(store, node.commandId)
  const record = node.outcome === null ? undefined : parseRecord(node.outcome.text ?? '')
  const command = node.args?.trim() || live?.command || ''
  const output = record?.output ?? live?.output ?? ''
  const status = record?.status ?? live?.status
  const durationMs = record?.durationMs ?? live?.durationMs
  const running = record === undefined && status === undefined
  const [cancelFailed, setCancelFailed] = useState<string | undefined>(undefined)
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (running && pre.current !== null) pre.current.scrollTop = pre.current.scrollHeight
  }, [output, running])

  let stateText: string
  if (record !== undefined && record.status === undefined) stateText = ''
  else if (status !== undefined) {
    stateText = statusText(status, t)
    if (durationMs !== undefined) stateText += ` · ${t('status.duration', { seconds: (durationMs / 1000).toFixed(2) })}`
  } else stateText = live === undefined ? t('status.starting') : t('status.running')

  const ok = status?.kind === 'exited' && status.exitCode === 0
  return (
    <div className={CLASS.block} data-user-shell-block={node.commandId} data-mode={mode} data-state={running ? 'running' : ok ? 'ok' : 'failed'}>
      <div className={CLASS.header}>
        <span className={CLASS.badge} title={t(mode === 'quiet' ? 'badge.quiet' : 'badge.context')}>{mode === 'quiet' ? '!!' : '!'}</span>
        <code className={CLASS.command}>{command}</code>
        <span className={CLASS.status} data-user-shell-status="">{stateText}</span>
        {running && live !== undefined && (
          <Button variant="ghost" size="sm" onClick={() => {
            void store.cancel(node.commandId).then((result) => { setCancelFailed(result.ok ? undefined : result.error) })
          }}>
            {t('action.cancel')}
          </Button>
        )}
      </div>
      {live?.outputTruncated === true && running && <div className={CLASS.note}>{t('output.truncated')}</div>}
      {(output !== '' || !running) && (
        <pre ref={pre} className={CLASS.output} data-user-shell-output="">{output === '' ? t('output.empty') : output}</pre>
      )}
      {running && live !== undefined && <AskpassForm run={live} store={store} t={t} />}
      {cancelFailed !== undefined && <div className={CLASS.error} role="alert">{cancelFailed}</div>}
      {!running && (
        <div className={CLASS.note}>
          {t(mode === 'quiet' || status?.kind === 'failed' ? 'context.skipped' : 'context.added')}
          {record?.fullOutput !== undefined && ` · ${t('output.full', { path: record.fullOutput })}`}
        </div>
      )}
    </div>
  )
}

/** Props of {@link ShellModeIndicator}. */
export interface ShellModeIndicatorProps {
  /** Current draft text. */
  readonly draft: string
  /** Whether the composer claims `!` lines (the line-prefix seam). */
  readonly supported: boolean
  readonly t: Translate<UserShellKey>
}

/**
 * Composer chip shown while the draft starts with `!` or `!!`.
 * @param props - draft, seam support, and translate.
 * @returns the chip, or nothing for ordinary drafts.
 */
export function ShellModeIndicator({ draft, supported, t }: ShellModeIndicatorProps) {
  const text = draft.trimStart()
  if (!text.startsWith('!')) return null
  const mode = !supported ? 'unsupported' : text.startsWith('!!') ? 'quiet' : 'context'
  return (
    <span className={CLASS.mode} data-user-shell-mode={mode} role="status">
      {t(mode === 'unsupported' ? 'mode.unsupported' : mode === 'quiet' ? 'mode.quiet' : 'mode.context')}
    </span>
  )
}
