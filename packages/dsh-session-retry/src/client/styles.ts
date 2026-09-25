/** Stylesheet of the retry block; theme tokens only. */

import { CLASS } from './RetryBlock.tsx'

/** The block's CSS, injected once while the client plugin is loaded. */
export const RETRY_BLOCK_CSS = `
.${CLASS.block} {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 4 * var(--dsh-composer-dock-inset, 0px));
  max-width: calc(var(--dsh-composer-card-max-width, 100%) - 4 * var(--dsh-composer-dock-inset, 0px));
  min-height: 36px;
  margin: 0 auto;
  padding: 4px 5px 4px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.${CLASS.dot} {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
  opacity: 0.55;
  animation: dsh-session-retry-pulse 2.4s ease-in-out infinite;
}
.${CLASS.dotStill} {
  background: var(--dsw-alias-label-tertiary);
  animation: none;
}
.${CLASS.text} {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  outline: none;
}
.${CLASS.error} {
  flex: none;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
.${CLASS.actions} {
  display: flex;
  flex: none;
  gap: 4px;
}
@keyframes dsh-session-retry-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.85); }
  50% { opacity: 0.7; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .${CLASS.dot} { animation: none; }
}
`
