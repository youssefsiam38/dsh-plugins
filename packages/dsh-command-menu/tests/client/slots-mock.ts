/** Stand-in for the one `@deepseek-ai/dsh-client-ui-slots` value the menu imports. */
export function resolveSlotLabel(label: string | (() => string) | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}
