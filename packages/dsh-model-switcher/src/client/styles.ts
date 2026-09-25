/**
 * Stylesheet of the picker. It uses the Web client's semantic `--dsw-*`
 * tokens only (the same ones the stock model control and menus use), so
 * light and dark themes need no rules of their own. Every selector is
 * scoped to a `dms-` class.
 */

import { CLASS as C } from './classes.ts'
import { SHEET_MEDIA } from './ModelSwitcher.tsx'

const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** The plugin's CSS, injected once while the client plugin is loaded. */
export const MODEL_SWITCHER_CSS = `
.${C.root} { position: relative; min-width: 0; }
.${C.trigger} {
  display: flex; align-items: center; gap: 4px; min-width: 0;
  max-width: 220px; max-width: min(360px, 45cqw); height: 28px;
  padding: 0 4px 0 8px; border: none; border-radius: 24px; corner-shape: round; outline: none;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; cursor: pointer;
}
.${C.trigger}:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.${C.trigger}:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.${C.trigger}:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.${C.triggerLogo} { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); }
.${C.triggerLabel}, .${C.triggerEffort} {
  display: var(--dsh-composer-model-text-display, block);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.${C.triggerEffort} { flex-shrink: 1000; color: var(--dsw-alias-label-caption); }
.${C.chevron} { flex: 0 0 auto; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }
.${C.chevron}[data-open] { transform: rotate(180deg); }

.${C.panel} {
  position: fixed; z-index: 1100; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 4px;
  width: min(460px, calc(100vw - 24px));
  height: min(520px, calc(100vh - 96px));
  padding: 6px; border: 0; border-radius: 16px;
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 18px;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.${C.scrim} { position: fixed; inset: 0; z-index: 1099; background: var(--dsw-alias-bg-mask-1); }
.${C.panel}[data-sheet] {
  left: 0; right: 0; bottom: 0; top: auto;
  width: 100%; height: min(88vh, 720px); height: min(88dvh, 720px);
  padding: 8px 12px calc(12px + env(safe-area-inset-bottom, 0px));
  border-radius: 16px 16px 0 0;
  background: var(--dsw-alias-bg-layer-2); backdrop-filter: none;
}
.${C.panel}[data-sheet] .${C.groupTitle} { background: var(--dsw-alias-bg-layer-2); }
.${C.sheetHeader} { display: flex; align-items: center; justify-content: space-between; padding: 2px 2px 4px; }
.${C.sheetTitle} { font-size: 15px; line-height: 22px; font-weight: 600; }
.${C.close} {
  display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: none;
  border-radius: 50%; corner-shape: round; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.${C.close}:hover, .${C.close}:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }

.${C.providerBar} { position: relative; flex: 0 0 auto; }
.${C.field} {
  display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 8px;
  border-radius: 10px; background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-secondary); cursor: text;
}
.${C.field}:focus-within { box-shadow: 0 0 0 1.5px var(--dsw-alias-border-l3); }
.${C.fieldIcon} { display: inline-flex; flex: 0 0 auto; }
.${C.fieldIcon} svg { width: 16px; height: 16px; }
.${C.input} {
  flex: 1; min-width: 0; height: 100%; padding: 0; border: none; outline: none;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.${C.input}::placeholder { color: var(--dsw-alias-label-tertiary); opacity: 1; }
.${C.providerBar} .${C.input}::placeholder { color: var(--dsw-alias-label-primary); font-weight: 500; }
.${C.providerBar} .${C.input}:focus::placeholder { color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.${C.providerList} {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 2;
  max-height: min(300px, 60vh); overflow-y: auto; padding: 4px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-panel);
}
.${C.providerList}[hidden] { display: none; }
.${C.providerOption}, .${C.option} {
  display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 5px 8px;
  border-radius: 8px; cursor: pointer; color: inherit;
}
.${C.providerOption}[data-active], .${C.option}[data-active] { background: var(--dsw-alias-interactive-bg-hover); }
.${C.option}[aria-disabled="true"] { color: var(--dsw-alias-label-dimmed); cursor: default; }
.${C.providerName} { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.${C.providerMeta} { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.${C.status} {
  display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; padding: 0 6px; height: 18px;
  border-radius: 9px; corner-shape: round; font-size: 11px; line-height: 16px; font-weight: 500; white-space: nowrap;
}
.${C.status}::before { content: ''; width: 6px; height: 6px; border-radius: 50%; corner-shape: round; background: currentColor; }
.${C.status}[data-status="signed-in"], .${C.status}[data-status="ready"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }
.${C.status}[data-status="needs-key"] { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }
.${C.status}[data-status="error"] { color: var(--dsw-alias-state-error-primary); }
.${C.modelField} { flex: 0 0 auto; }

.${C.list} { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 0; }
.${C.group} + .${C.group} { margin-top: 4px; }
.${C.groupTitle} {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px;
  padding: 4px 8px 2px; background: var(--dsw-specific-menu);
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; font-weight: 500;
}
.${C.optionMain} { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.${C.optionName} { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.${C.optionId} {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; font-family: ${MONO};
}
.${C.badges} { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; }
.${C.badge} {
  display: inline-flex; align-items: center; height: 18px; padding: 0 5px; border-radius: 5px;
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; white-space: nowrap;
}
.${C.badge}[data-badge="context"] { font-family: ${MONO}; }
.${C.star} {
  display: grid; place-items: center; flex: 0 0 22px; width: 22px; height: 22px; padding: 0; border: none;
  border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;
  opacity: 0;
}
.${C.option}:hover .${C.star}, .${C.option}[data-active] .${C.star}, .${C.star}[data-favorite] { opacity: 1; }
.${C.star}[data-favorite] { color: var(--dsw-alias-state-warn-primary); }
.${C.star}:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${C.check} { display: grid; place-items: center; flex: 0 0 14px; color: var(--dsw-alias-label-primary); }
.${C.check} svg { width: 14px; height: 14px; }
.${C.logo} { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); border-radius: 3px; object-fit: contain; }
.${C.monogram} {
  display: inline-grid; place-items: center; flex: 0 0 auto; border-radius: 4px;
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-secondary); font-weight: 600; line-height: 1;
}

.${C.notice} {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
  padding: 6px 8px; border-radius: 8px; flex: 0 0 auto;
  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-warn-label);
  font-size: 11px; line-height: 16px;
}
.${C.noticeError} { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.${C.empty} {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  padding: 12px 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px;
}
.${C.link} {
  padding: 0; margin-right: 12px; border: none; background: transparent; color: var(--dsw-alias-link, inherit);
  font: inherit; font-weight: 600; cursor: pointer;
}
.${C.link}:focus-visible { text-decoration: underline dotted; text-underline-offset: 3px; }

.${C.effort} {
  display: flex; align-items: center; gap: 4px; flex: 0 0 auto; flex-wrap: wrap;
  padding: 6px 4px 2px; border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.${C.effortLabel} { margin-right: 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.${C.effortOption} {
  height: 26px; padding: 0 10px; border: none; border-radius: 13px; corner-shape: round;
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer;
}
.${C.effortOption}:hover:not(:disabled), .${C.effortOption}:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
.${C.effortOption}[aria-pressed="true"] { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-1); }
.${C.effortOption}:disabled { cursor: default; opacity: 0.6; }
.${C.panel}[data-centered] { left: 50%; top: max(12px, 12vh); transform: translateX(-50%); }
.${C.pickBar} {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 0 0 auto;
  padding: 6px 4px 2px; border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.${C.pickCount} { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.${C.done} {
  height: 28px; padding: 0 14px; border: none; border-radius: 14px; corner-shape: round;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-1);
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.${C.done}:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.${C.done}:disabled { cursor: default; opacity: 0.5; }
.${C.hints} {
  display: flex; flex-wrap: nowrap; gap: 10px; flex: 0 0 auto; padding: 4px 4px 0; overflow: hidden; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px;
}
.${C.hints} > span { display: inline-flex; align-items: center; gap: 3px; }
.${C.kbd} {
  display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px;
  border-radius: 4px; background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover));
  font: inherit; font-size: 10px;
}
.${C.srOnly} {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
@media ${SHEET_MEDIA} {
  .${C.panel}[data-sheet] .${C.input} { font-size: 16px; }
  .${C.panel}[data-sheet] .${C.field} { height: 40px; }
  .${C.panel}[data-sheet] .${C.option}, .${C.panel}[data-sheet] .${C.providerOption} { min-height: 44px; }
  .${C.panel}[data-sheet] .${C.star} { opacity: 1; }
  .${C.panel}[data-sheet] .${C.optionId} { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .${C.chevron} { transition: none; }
}
`
