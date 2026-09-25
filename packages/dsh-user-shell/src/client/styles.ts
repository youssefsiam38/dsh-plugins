/** Stylesheet of the shell block and composer chip; theme tokens only. */

import { CLASS } from './ShellBlock.tsx'

/** The plugin's CSS, injected once while the client plugin is loaded. */
export const USER_SHELL_CSS = `
.${CLASS.block} {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  overflow: hidden;
}
.${CLASS.header} {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 4px 6px 4px 10px;
}
.${CLASS.badge} {
  flex: none;
  min-width: 22px;
  padding: 0 5px;
  border-radius: 6px;
  background: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-bg-layer-1);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-weight: 600;
  text-align: center;
}
.${CLASS.block}[data-mode="quiet"] .${CLASS.badge} {
  background: var(--dsw-alias-label-tertiary);
}
.${CLASS.command} {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.${CLASS.status} {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.${CLASS.block}[data-state="failed"] .${CLASS.status} {
  color: var(--dsw-alias-state-error-primary);
}
.${CLASS.output} {
  margin: 0;
  max-height: 360px;
  overflow: auto;
  padding: 8px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-all;
}
.${CLASS.note} {
  padding: 4px 10px 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.${CLASS.askpass} {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.${CLASS.askpass} label {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 220px;
}
.${CLASS.askpass} input {
  flex: 1;
  min-width: 160px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  font: inherit;
}
.${CLASS.error} {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
.${CLASS.mode} {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  border-radius: 12px;
  background: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  white-space: nowrap;
}
.${CLASS.mode}[data-user-shell-mode="quiet"] {
  background: var(--dsw-alias-label-tertiary);
}
.${CLASS.mode}[data-user-shell-mode="unsupported"] {
  background: var(--dsw-alias-state-error-primary);
}
[data-composer-card]:has(.${CLASS.mode}[data-user-shell-mode="context"]),
[data-composer-card]:has(.${CLASS.mode}[data-user-shell-mode="quiet"]) {
  border-color: var(--dsw-alias-state-warn-primary);
}
[data-composer-card]:has(.${CLASS.mode}[data-user-shell-mode="context"]) [data-composer-input],
[data-composer-card]:has(.${CLASS.mode}[data-user-shell-mode="quiet"]) [data-composer-input] {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
`
