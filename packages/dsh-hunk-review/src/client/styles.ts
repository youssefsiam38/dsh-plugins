/** Stylesheet of the review tab and the turn-tail chip; theme tokens only. */

import { CLASS } from './ReviewPanel.tsx'

const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** The plugin's CSS, injected once while the client plugin is loaded. */
export const HUNK_REVIEW_CSS = `
.${CLASS.root} {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: auto;
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.${CLASS.header} {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 4px 8px 4px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));
  background: var(--dsw-alias-bg-layer-1);
}
.${CLASS.title} { font-weight: 600; }
.${CLASS.counts} { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.${CLASS.actions} { display: inline-flex; gap: 4px; margin-left: auto; align-items: center; }
.${CLASS.notice} {
  margin: 8px 12px 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.${CLASS.notice}[data-hunk-review-notice="failed"] { color: var(--dsw-alias-state-error-primary); }
.${CLASS.state} { margin: 0; padding: 16px; color: var(--dsw-alias-label-secondary); }
.${CLASS.file} { margin: 8px 8px 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
.${CLASS.fileHeader} {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 2px 6px 2px 10px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
}
.${CLASS.path} { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; font-family: ${MONO}; font-size: 12px; }
.${CLASS.added} { color: var(--dsw-alias-file-diff-added-marker, var(--dsw-alias-state-success-primary)); font-size: 12px; }
.${CLASS.deleted} { color: var(--dsw-alias-file-diff-deleted-marker, var(--dsw-alias-state-error-primary)); font-size: 12px; }
.${CLASS.tag} {
  flex: none;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
}
.${CLASS.tag}[data-status="kept"] { color: var(--dsw-alias-file-diff-added-marker, var(--dsw-alias-state-success-primary)); }
.${CLASS.tag}[data-status="reverted"] { color: var(--dsw-alias-label-tertiary); }
.${CLASS.tag}[data-status="conflict"] { color: var(--dsw-alias-state-warn-primary); }
.${CLASS.note} { margin: 0; padding: 4px 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.${CLASS.hunk} { border-top: 0.5px solid var(--dsw-alias-border-l1); }
.${CLASS.hunk}[data-focused] { box-shadow: inset 3px 0 0 var(--dsw-alias-label-primary); }
.${CLASS.hunk}[data-status="reverted"] .${CLASS.hunkHeader} { opacity: 0.7; }
.${CLASS.hunkHeader} { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 0 6px 0 10px; }
.${CLASS.status} { color: var(--dsw-alias-label-tertiary); font-family: ${MONO}; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.${CLASS.lines} { overflow-x: auto; font-family: ${MONO}; font-size: 12px; line-height: 20px; }
.${CLASS.line} { display: grid; grid-template-columns: 3.2em 3.2em 1.2em max-content; min-width: 100%; width: max-content; white-space: pre; }
.${CLASS.line}[data-sign="add"] { background: var(--dsw-alias-file-diff-added-bg, color-mix(in srgb, green 12%, transparent)); }
.${CLASS.line}[data-sign="del"] { background: var(--dsw-alias-file-diff-deleted-bg, color-mix(in srgb, red 12%, transparent)); }
.${CLASS.line}[data-sign="add"] .${CLASS.sign} { color: var(--dsw-alias-file-diff-added-marker, green); }
.${CLASS.line}[data-sign="del"] .${CLASS.sign} { color: var(--dsw-alias-file-diff-deleted-marker, red); }
.${CLASS.line}[data-sign="context"] .${CLASS.text} { color: var(--dsw-alias-label-secondary); }
.${CLASS.number} { padding-right: 6px; color: var(--dsw-alias-label-tertiary); text-align: right; user-select: none; }
.${CLASS.sign} { text-align: center; user-select: none; }
.${CLASS.text} { padding-right: 12px; }
.${CLASS.conflict} { border-top: 0.5px dashed var(--dsw-alias-state-warn-primary); }
.${CLASS.hint} { margin: 8px 12px 12px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.${CLASS.chip} {
  display: inline-flex;
  align-self: flex-start;
  width: fit-content;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 13px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.${CLASS.chip}:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
`
