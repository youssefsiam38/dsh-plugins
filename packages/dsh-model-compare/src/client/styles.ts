/** Class names and the stylesheet of the Compare view; theme tokens only. */

/** Class names, prefixed so they never collide with the app's. */
export const CLASS = {
  root: 'dmc-root',
  setup: 'dmc-setup',
  title: 'dmc-title',
  muted: 'dmc-muted',
  notice: 'dmc-notice',
  error: 'dmc-error',
  field: 'dmc-field',
  label: 'dmc-label',
  chips: 'dmc-chips',
  chip: 'dmc-chip',
  chipName: 'dmc-chip-name',
  chipPick: 'dmc-chip-pick',
  chipRemove: 'dmc-chip-remove',
  effort: 'dmc-effort',
  combo: 'dmc-combo',
  input: 'dmc-input',
  menu: 'dmc-menu',
  menuHeading: 'dmc-menu-heading',
  option: 'dmc-option',
  textarea: 'dmc-textarea',
  footer: 'dmc-footer',
  primary: 'dmc-primary',
  secondary: 'dmc-secondary',
  bar: 'dmc-bar',
  barActions: 'dmc-bar-actions',
  promptBox: 'dmc-prompt',
  promptText: 'dmc-prompt-text',
  toggle: 'dmc-toggle',
  tabs: 'dmc-tabs',
  tab: 'dmc-tab',
  lanes: 'dmc-lanes',
  laneSlot: 'dmc-lane-slot',
  lane: 'dmc-lane',
  laneHeader: 'dmc-lane-header',
  laneTitle: 'dmc-lane-title',
  laneIndex: 'dmc-lane-index',
  laneName: 'dmc-lane-name',
  laneActions: 'dmc-lane-actions',
  laneScroll: 'dmc-lane-scroll',
  status: 'dmc-status',
  stats: 'dmc-stats',
  transcript: 'dmc-transcript',
  userTurn: 'dmc-user-turn',
  answer: 'dmc-answer',
  reasoning: 'dmc-reasoning',
  reasoningText: 'dmc-reasoning-text',
  toolRow: 'dmc-tool',
  toolName: 'dmc-tool-name',
  toolError: 'dmc-tool-error',
} as const

const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** The plugin's CSS, injected once while the client plugin is loaded. */
export const MODEL_COMPARE_CSS = `
.${CLASS.root} {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  padding: 12px 16px 16px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.${CLASS.root} *, .${CLASS.root} *::before, .${CLASS.root} *::after { box-sizing: border-box; }
.${CLASS.setup} {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  padding: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.${CLASS.title} { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.${CLASS.muted} { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.${CLASS.notice} { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); }
.${CLASS.error} { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.${CLASS.field} { display: flex; flex-direction: column; gap: 6px; }
.${CLASS.label} { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }
.${CLASS.chips} { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.${CLASS.chip} {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 30px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  border-radius: 15px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
}
.${CLASS.chipName} { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${CLASS.chipPick} {
  min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer;
  text-decoration: underline dotted transparent; text-underline-offset: 3px;
}
.${CLASS.chipPick}:hover, .${CLASS.chipPick}:focus-visible { text-decoration-color: currentColor; }
.${CLASS.chipRemove} {
  width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: 11px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 15px; line-height: 22px; cursor: pointer;
}
.${CLASS.chipRemove}:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.${CLASS.effort}, .${CLASS.input}, .${CLASS.textarea} {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1));
  color: inherit;
  font: inherit;
}
.${CLASS.effort} { height: 24px; padding: 0 4px; font-size: 12px; }
.${CLASS.combo} { position: relative; }
.${CLASS.input} { width: 100%; height: 34px; padding: 0 10px; }
.${CLASS.input}:focus, .${CLASS.textarea}:focus, .${CLASS.effort}:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.${CLASS.menu} {
  position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px);
  max-height: 280px; overflow: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}
.${CLASS.menuHeading} { padding: 6px 8px 2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.${CLASS.option} {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  width: 100%; min-height: 32px; padding: 4px 8px;
  border: 0; border-radius: 6px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.${CLASS.option}:hover, .${CLASS.option}:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
.${CLASS.textarea} { width: 100%; min-height: 96px; padding: 8px 10px; resize: vertical; }
.${CLASS.footer} { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.${CLASS.primary}, .${CLASS.secondary} {
  height: 30px; padding: 0 12px;
  border-radius: 8px;
  font: inherit; font-weight: 500; white-space: nowrap; cursor: pointer;
}
.${CLASS.primary} { border: 1px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.${CLASS.secondary} { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; }
.${CLASS.secondary}:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.${CLASS.primary}:disabled, .${CLASS.secondary}:disabled { opacity: 0.5; cursor: default; }
.${CLASS.bar} { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 16px; }
.${CLASS.promptBox} { display: flex; flex-direction: column; flex: 1 1 280px; min-width: 0; }
.${CLASS.promptText} {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  white-space: pre-wrap; word-break: break-word;
}
.${CLASS.barActions} { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${CLASS.toggle} { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.${CLASS.tabs} {
  display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.${CLASS.tab} {
  flex: none; max-width: 60vw; height: 32px; padding: 0 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border: 0; border-bottom: 2px solid transparent;
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer;
}
.${CLASS.tab}[aria-selected="true"] { border-bottom-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); font-weight: 500; }
.${CLASS.lanes} {
  display: grid;
  grid-template-columns: repeat(var(--dmc-count, 2), minmax(300px, 1fr));
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 4px;
}
.${CLASS.root}[data-narrow] .${CLASS.lanes} {
  display: flex;
  gap: 0;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.${CLASS.root}[data-narrow] .${CLASS.laneSlot} { flex: 0 0 100%; width: 100%; scroll-snap-align: start; scroll-snap-stop: always; }
.${CLASS.laneSlot} { min-width: 0; }
.${CLASS.lane} {
  display: flex; flex-direction: column;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.${CLASS.lane}[data-status="error"] { border-color: var(--dsw-alias-state-error-primary); }
.${CLASS.laneHeader} {
  display: flex; flex-direction: column; gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
}
.${CLASS.laneTitle} { display: flex; align-items: center; gap: 8px; min-width: 0; }
.${CLASS.laneIndex} {
  flex: none; width: 20px; height: 20px; border-radius: 10px;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-1);
  font-size: 11px; font-weight: 600; line-height: 20px; text-align: center;
}
.${CLASS.laneName} { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.${CLASS.status} {
  flex: none; padding: 0 8px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 20px;
}
.${CLASS.status}[data-status="running"] { color: var(--dsw-alias-brand-primary); }
.${CLASS.status}[data-status="completed"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }
.${CLASS.status}[data-status="error"] { color: var(--dsw-alias-state-error-primary); }
.${CLASS.status}[data-status="max-tokens"], .${CLASS.status}[data-status="aborted"] { color: var(--dsw-alias-state-warn-primary); }
.${CLASS.stats} {
  display: flex; flex-wrap: wrap; gap: 2px 10px;
  color: var(--dsw-alias-label-secondary);
  font-family: ${MONO}; font-size: 11px; line-height: 16px;
}
.${CLASS.laneActions} { display: flex; justify-content: flex-end; gap: 6px; }
.${CLASS.laneScroll} {
  position: relative;
  height: max(280px, calc(var(--dsh-conversation-viewport-height, 80vh) - var(--dsh-composer-height, 152px) - 170px));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 12px 14px;
}
.${CLASS.transcript} { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.${CLASS.userTurn} {
  align-self: flex-end; max-width: 90%;
  padding: 6px 10px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  white-space: pre-wrap; word-break: break-word;
}
.${CLASS.answer} { min-width: 0; overflow-wrap: anywhere; }
.${CLASS.reasoning} { margin-bottom: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.${CLASS.reasoning} summary { cursor: pointer; }
.${CLASS.reasoningText} { margin-top: 4px; padding-left: 10px; border-left: 2px solid var(--dsw-alias-border-l1); white-space: pre-wrap; }
.${CLASS.toolRow} {
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px 8px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 8px;
  font-size: 12px;
}
.${CLASS.toolName} { font-family: ${MONO}; color: var(--dsw-alias-label-secondary); }
.${CLASS.toolError} { color: var(--dsw-alias-state-warn-primary); }
.${CLASS.root}[data-narrow] .${CLASS.laneScroll} { height: max(260px, calc(var(--dsh-conversation-viewport-height, 80vh) - var(--dsh-composer-height, 152px) - 210px)); }
.${CLASS.root}[data-narrow] { padding: 8px 8px 12px; }
`
