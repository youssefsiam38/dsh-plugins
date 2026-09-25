/**
 * Stylesheet of the menu. It uses the Web client's semantic `--dsw-*`
 * tokens only (the same ones the stock menus use), so light and dark themes
 * need no rules of their own. Every selector is scoped to a `dcm-` class.
 */

import { CLASS as C } from './classes.ts'
import { SHEET_MEDIA } from './CommandMenu.tsx'

const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** The plugin's CSS, injected once while the client plugin is loaded. */
export const COMMAND_MENU_CSS = `
.${C.root} {
  position: fixed; inset: 0; z-index: 1200; display: flex; justify-content: center; align-items: flex-start;
  padding: max(12vh, var(--dsh-frame-top-clearance, 0px)) 16px 16px;
}
.${C.scrim} { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24)); backdrop-filter: var(--dsw-mask-blur, none); }
.${C.panel} {
  position: relative; z-index: 1; box-sizing: border-box; display: flex; flex-direction: column;
  width: min(640px, 100%); max-height: min(560px, 76vh);
  border-radius: 16px; overflow: hidden;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2));
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 18px;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.${C.header} {
  display: flex; align-items: center; gap: 6px; flex: 0 0 auto; padding: 8px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.${C.back}, .${C.scope} {
  display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; max-width: 40%; height: 26px; padding: 0 8px 0 6px;
  border: none; border-radius: 8px; background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap;
}
.${C.scope} { padding: 0 8px; cursor: default; }
.${C.crumb} { overflow: hidden; text-overflow: ellipsis; }
.${C.field} { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; height: 36px; color: var(--dsw-alias-label-tertiary); cursor: text; }
.${C.fieldIcon} { display: inline-flex; flex: 0 0 auto; }
.${C.input} {
  flex: 1; min-width: 0; height: 100%; padding: 0; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 15px;
}
.${C.input}::placeholder { color: var(--dsw-alias-label-tertiary); opacity: 1; }
.${C.close} {
  display: grid; place-items: center; flex: 0 0 auto; width: 36px; height: 36px; padding: 0; border: none;
  border-radius: 50%; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.${C.close}:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${C.list} { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 6px 6px; }
.${C.group} + .${C.group} { margin-top: 4px; }
.${C.groupTitle} {
  position: sticky; top: -4px; z-index: 1; padding: 6px 8px 2px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; font-weight: 500;
}
.${C.option} {
  display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 6px 8px;
  border-radius: 8px; cursor: pointer; color: inherit; user-select: none;
}
.${C.option}[data-active] { background: var(--dsw-alias-interactive-bg-hover); }
.${C.optionIcon} { display: inline-grid; place-items: center; flex: 0 0 18px; color: var(--dsw-alias-label-secondary); }
.${C.optionIcon} [data-flip] { display: inline-flex; transform: scaleX(-1); }
.${C.optionMain} { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.${C.optionTitle} { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.${C.option}[data-kind="command"] .${C.optionTitle} { font-family: ${MONO}; font-weight: 500; }
.${C.optionDetail} {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 16px;
}
.${C.option}[data-kind="message"] .${C.optionDetail} { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.${C.optionHint} { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; }
.${C.option}[aria-current="true"] .${C.optionHint} { color: var(--dsw-alias-label-secondary); font-weight: 600; }
.${C.chevron} { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.${C.keys} { display: inline-flex; flex: 0 0 auto; gap: 3px; }
.${C.kbd} {
  display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box;
  border-radius: 4px; background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 1;
}
.${C.mark} { background: transparent; color: var(--dsw-alias-label-primary); font-weight: 700; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.${C.status}, .${C.empty}, .${C.more} { padding: 10px 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.${C.more} { padding: 2px 8px 4px 36px; font-size: 11px; }
.${C.status}[data-status="error"] { color: var(--dsw-alias-state-error-primary); }
.${C.footer} {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px; flex: 0 0 auto; padding: 6px 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-tertiary); font-size: 11px;
}
.${C.footer} > span { display: inline-flex; align-items: center; gap: 4px; }
.${C.footer} > .${C.keys} { margin-left: auto; }
.${C.toast} {
  position: fixed; left: 50%; bottom: 24px; z-index: 1200; transform: translateX(-50%);
  max-width: min(560px, calc(100vw - 32px)); padding: 8px 14px; border-radius: 10px;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent); font-size: 13px; line-height: 18px; pointer-events: auto;
}
.${C.srOnly} {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
[data-command-menu-hit] {
  border-radius: 4px; background: var(--dsw-alias-state-warn-bg, rgba(255, 196, 0, 0.28));
  box-shadow: 0 0 0 2px var(--dsw-alias-state-warn-primary, rgba(255, 196, 0, 0.6));
  transition: background 600ms ease, box-shadow 600ms ease;
}
@media ${SHEET_MEDIA} {
  .${C.root} { padding: 0; }
  .${C.panel} {
    width: 100%; height: 100%; max-height: none; border-radius: 0;
    padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .${C.input} { font-size: 16px; }
  .${C.option} { min-height: 48px; }
  .${C.keys} { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  [data-command-menu-hit] { transition: none; }
}
`
