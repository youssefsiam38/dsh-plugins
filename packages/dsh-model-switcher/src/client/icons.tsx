/**
 * Provider logos: a configured image URL, else a known provider's mark from
 * the `simple-icons` set (CC0-1.0; `scripts/marks.mjs` copies the paths)
 * drawn in `currentColor` so it follows the theme, else a one-letter monogram.
 * @module dsh-model-switcher/client/icons
 */

import { MARKS as M } from './marks.generated.ts'
import { CLASS } from './classes.ts'

/** A `simple-icons` mark: an SVG path in a 24x24 box. */
interface Mark {
  readonly title: string
  readonly path: string
}

/** Provider-id fragments and the mark each names; the first matching fragment wins. */
const PATTERNS: readonly (readonly [RegExp, Mark])[] = [
  [/openrouter/, M.openrouter],
  [/anthropic|claude/, M.anthropic],
  [/deepseek/, M.deepseek],
  [/google|gemini|vertex/, M.googlegemini],
  [/mistral/, M.mistralai],
  [/ollama/, M.ollama],
  [/hugging\s*face|huggingface|\bhf\b/, M.huggingface],
  [/perplexity/, M.perplexity],
  [/copilot/, M.githubcopilot],
  [/vercel/, M.vercel],
  [/cloudflare/, M.cloudflare],
  [/nvidia|nim\b/, M.nvidia],
  [/qwen|dashscope/, M.qwen],
  [/alibaba|bailian/, M.alibabacloud],
  [/kimi/, M.kimi],
  [/moonshot/, M.moonshotai],
  [/minimax/, M.minimax],
  [/lm\s*studio|lmstudio/, M.lmstudio],
  [/\bmeta\b|llama/, M.meta],
  [/bytedance|doubao|volcengine|\bark\b/, M.bytedance],
  [/baidu|qianfan|ernie/, M.baidu],
  [/tencent|hunyuan/, M.tencenthy],
]

/**
 * Find the mark for a provider by its id, then its display name.
 * @param id - provider route id.
 * @param name - provider display name.
 * @returns the mark, or undefined for an unknown provider.
 */
export function markOf(id: string, name: string): Mark | undefined {
  for (const text of [id.toLowerCase(), name.toLowerCase()]) {
    for (const [pattern, mark] of PATTERNS) if (pattern.test(text)) return mark
  }
  return undefined
}

/** Props of {@link ProviderLogo}. */
export interface ProviderLogoProps {
  readonly id: string
  readonly name: string
  /** Configured image URL override. */
  readonly url?: string | undefined
  readonly size?: number
}

/**
 * Render a provider's logo (decorative: the provider name is always shown or announced beside it).
 * @param props - provider id and name, optional URL override, and edge size.
 * @returns the logo element.
 */
export function ProviderLogo({ id, name, url, size = 16 }: ProviderLogoProps) {
  if (url !== undefined) {
    return <img className={CLASS.logo} src={url} alt="" width={size} height={size} aria-hidden="true" draggable={false} />
  }
  const mark = markOf(id, name)
  if (mark !== undefined) {
    return (
      <svg className={CLASS.logo} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" data-mark={mark.title}>
        <path d={mark.path} fill="currentColor" />
      </svg>
    )
  }
  const letter = (name.trim()[0] ?? id[0] ?? '?').toUpperCase()
  return <span className={CLASS.monogram} style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }} aria-hidden="true">{letter}</span>
}

/**
 * The "All providers" glyph: four small squares.
 * @param props - edge size.
 * @returns the glyph.
 */
export function AllProvidersGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg className={CLASS.logo} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="5" height="5" rx="1.5" fill="currentColor" />
      <rect x="9" y="2" width="5" height="5" rx="1.5" fill="currentColor" opacity="0.6" />
      <rect x="2" y="9" width="5" height="5" rx="1.5" fill="currentColor" opacity="0.6" />
      <rect x="9" y="9" width="5" height="5" rx="1.5" fill="currentColor" />
    </svg>
  )
}
