/**
 * Compact lane transcript: answers through the dsh Markdown renderer
 * (`MarkdownText` from the shared primitives), reasoning in a disclosure, and
 * one row per tool call with its outcome.
 */

import { memo, useMemo } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './Setup.tsx'
import { CLASS } from './styles.ts'
import type { TranscriptItem } from './transcript.ts'

/** Props of {@link Transcript}. */
export interface TranscriptProps {
  readonly items: readonly TranscriptItem[]
  readonly t: Translate
}

/**
 * Render transcript items.
 * @param props - items and translator.
 * @returns the transcript.
 */
export const Transcript = memo(function Transcript({ items, t }: TranscriptProps) {
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  return (
    <div className={CLASS.transcript} data-model-compare-transcript="">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return <div key={item.key} className={CLASS.userTurn}>{item.text}</div>
          case 'answer':
            return (
              <div key={item.key} className={CLASS.answer} data-streaming={item.streaming ? '' : undefined}>
                {item.reasoning !== '' && (
                  <details className={CLASS.reasoning}>
                    <summary>{t('transcript.reasoning')}</summary>
                    <div className={CLASS.reasoningText}>{item.reasoning}</div>
                  </details>
                )}
                {item.text !== '' && <MarkdownText text={item.text} streaming={item.streaming} labels={labels} />}
                {item.text === '' && item.streaming && <span className={CLASS.muted}>{t('lane.running')}</span>}
              </div>
            )
          case 'tool':
            return (
              <div key={item.key} className={CLASS.toolRow} data-tool-failed={item.error === undefined ? undefined : ''}>
                <span className={CLASS.toolName}>{t('transcript.tool', { name: item.name })}</span>
                {item.error !== undefined && <span className={CLASS.toolError}>{item.error}</span>}
              </div>
            )
          case 'error':
            return <div key={item.key} className={CLASS.error}>{item.text}</div>
          default:
            return null
        }
      })}
    </div>
  )
})
