/** Number formatting for lane statistics. */

/**
 * Format milliseconds as seconds.
 * @param ms - duration.
 * @returns e.g. `0.42`, `3.1`, `41`.
 */
export function seconds(ms: number): string {
  const value = ms / 1000
  if (value < 10) return value.toFixed(2)
  if (value < 100) return value.toFixed(1)
  return value.toFixed(0)
}

/**
 * Format a token count compactly.
 * @param count - tokens.
 * @returns e.g. `940`, `1.2k`, `35k`, `1.4M`.
 */
export function tokens(count: number): string {
  if (count < 1000) return String(Math.round(count))
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * Format a US dollar amount with enough digits for small request costs.
 * @param usd - amount.
 * @returns e.g. `$0.0021`, `$0.013`, `$1.24`.
 */
export function usd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toPrecision(2)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
