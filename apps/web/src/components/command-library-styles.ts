export const COMMAND_LIBRARY_STYLES = String.raw`
.cpl-shell {
  --cpl-bg: #161b1a;
  --cpl-panel: #202825;
  --cpl-ink: #f1f4ef;
  --cpl-muted: #adb8b2;
  --cpl-paper: var(--cpl-bg);
  --cpl-line: #4e5a55;
  --cpl-cobalt: #9cb9ff;
  --cpl-action: #315fc7;
  --cpl-danger: #ffb4ab;
  --cpl-error-bg: #3a2321;
  --cpl-error-fg: #ffb4ab;
  --cpl-success-bg: #20362b;
  --cpl-success-fg: #a9dfbd;
  --cpl-signal: #9cb9ff;
  color: var(--cpl-ink);
  background: var(--cpl-bg);
  display: grid;
  gap: 16px;
  min-width: 0;
}
.cpl-shell *, .cpl-shell *::before, .cpl-shell *::after { box-sizing: border-box; }
.cpl-head { align-items: end; display: flex; gap: 16px; justify-content: space-between; }
.cpl-kicker { color: var(--cpl-cobalt); font: 700 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; margin: 0 0 4px; text-transform: uppercase; }
.cpl-head h2 { font: 650 clamp(22px, 3vw, 32px)/1.05 "Avenir Next", Avenir, system-ui, sans-serif; letter-spacing: -.035em; margin: 0; }
.cpl-target { align-items: center; background: color-mix(in srgb, var(--cpl-panel) 78%, transparent); border: 1px solid var(--cpl-line); border-radius: 12px; display: grid; gap: 2px; min-height: 48px; min-width: min(100%, 230px); padding: 8px 12px 8px 18px; position: relative; }
.cpl-target::before { background: var(--cpl-muted); border-radius: 99px; content: ""; inset: 8px auto 8px 7px; position: absolute; width: 3px; }
.cpl-target.is-ready::before { background: var(--cpl-signal); box-shadow: 0 0 12px var(--cpl-signal); }
.cpl-target strong, .cpl-target code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpl-target strong { font: 650 13px/1.2 "Avenir Next", Avenir, system-ui, sans-serif; }
.cpl-target code { color: var(--cpl-muted); font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
.cpl-toolbar { display: grid; gap: 10px; grid-template-columns: minmax(180px, 1fr) minmax(150px, auto) auto; }
.cpl-search, .cpl-select, .cpl-field input, .cpl-field select, .cpl-field textarea, .cpl-import-text, .cpl-export-text { appearance: none; background: var(--cpl-panel); border: 1px solid var(--cpl-line); border-radius: 10px; color: var(--cpl-ink); font: 500 15px/1.4 "Avenir Next", Avenir, system-ui, sans-serif; min-height: 48px; padding: 10px 12px; width: 100%; }
.cpl-field textarea, .cpl-import-text, .cpl-export-text { min-height: 180px; resize: vertical; }
.cpl-search:focus-visible, .cpl-select:focus-visible, .cpl-field input:focus-visible, .cpl-field select:focus-visible, .cpl-field textarea:focus-visible, .cpl-import-text:focus-visible, .cpl-export-text:focus-visible, .cpl-button:focus-visible, .cpl-icon-choice:focus-visible, .cpl-card button:focus-visible { outline: 3px solid var(--cpl-cobalt); outline-offset: 2px; }
.cpl-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.cpl-button, .cpl-card button, .cpl-icon-choice { -webkit-tap-highlight-color: transparent; align-items: center; background: var(--cpl-panel); border: 1px solid var(--cpl-line); border-radius: 10px; color: var(--cpl-ink); cursor: pointer; display: inline-flex; font: 650 13px/1 "Avenir Next", Avenir, system-ui, sans-serif; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 13px; touch-action: manipulation; }
.cpl-button:hover, .cpl-card button:hover, .cpl-icon-choice:hover { border-color: color-mix(in srgb, var(--cpl-cobalt) 50%, var(--cpl-line)); }
.cpl-button:disabled, .cpl-card button:disabled { cursor: not-allowed; opacity: .46; }
.cpl-button.is-primary { background: var(--cpl-ink); border-color: var(--cpl-ink); color: var(--cpl-paper); }
.cpl-button.is-run { background: var(--cpl-action); border-color: var(--cpl-action); color: white; }
.cpl-button.is-danger { color: var(--cpl-danger); }
.cpl-count { color: var(--cpl-muted); font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; }
.cpl-grid { display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); list-style: none; margin: 0; padding: 0; }
.cpl-card { background: color-mix(in srgb, var(--cpl-panel) 90%, transparent); border: 1px solid var(--cpl-line); border-radius: 14px; display: grid; gap: 12px; grid-template-columns: 48px minmax(0, 1fr) auto; min-height: 92px; overflow: hidden; padding: 12px; position: relative; }
.cpl-card::before { background: var(--cpl-signal); content: ""; inset: 0 auto 0 0; opacity: .78; position: absolute; width: 3px; }
.cpl-glyph { align-items: center; background: color-mix(in srgb, var(--cpl-cobalt) 9%, transparent); border: 1px solid color-mix(in srgb, var(--cpl-cobalt) 18%, transparent); border-radius: 10px; display: flex; font: 500 24px/1 "Avenir Next", Avenir, system-ui, sans-serif; height: 48px; justify-content: center; width: 48px; }
.cpl-card-copy { align-self: center; min-width: 0; }
.cpl-card-copy strong { display: block; font: 650 15px/1.2 "Avenir Next", Avenir, system-ui, sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpl-card-copy span { color: var(--cpl-muted); display: block; font: 550 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.cpl-card-actions { align-items: center; display: flex; gap: 5px; }
.cpl-card-actions button { font-size: 15px; padding: 0; }
.cpl-card-actions .cpl-run { min-width: 58px; padding: 0 12px; }
.cpl-empty { border: 1px dashed var(--cpl-line); border-radius: 14px; color: var(--cpl-muted); padding: 28px; text-align: center; }
.cpl-empty strong { color: var(--cpl-ink); display: block; font: 650 16px/1.3 "Avenir Next", Avenir, system-ui, sans-serif; margin-bottom: 4px; }
.cpl-note, .cpl-error, .cpl-success { border-radius: 9px; font: 600 13px/1.4 "Avenir Next", Avenir, system-ui, sans-serif; margin: 0; padding: 9px 11px; }
.cpl-note { background: color-mix(in srgb, var(--cpl-cobalt) 8%, transparent); color: var(--cpl-muted); }
.cpl-error { background: var(--cpl-error-bg); color: var(--cpl-error-fg); }
.cpl-success { background: var(--cpl-success-bg); color: var(--cpl-success-fg); }
.cpl-overlay { align-items: center; background: rgba(13, 20, 29, .54); display: flex; inset: 0; justify-content: center; padding: max(18px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); position: fixed; z-index: 90; }
.cpl-dialog { background: var(--cpl-paper); border: 1px solid color-mix(in srgb, white 20%, transparent); border-radius: 18px; box-shadow: 0 24px 80px rgba(0, 0, 0, .28); display: grid; gap: 16px; max-height: min(90dvh, 820px); max-width: 620px; overflow: auto; padding: 20px; width: 100%; }
.cpl-dialog-head { align-items: start; display: flex; gap: 12px; justify-content: space-between; }
.cpl-dialog h3 { font: 650 23px/1.1 "Avenir Next", Avenir, system-ui, sans-serif; letter-spacing: -.025em; margin: 0; }
.cpl-dialog-head p, .cpl-confirm-copy { color: var(--cpl-muted); font: 500 14px/1.45 "Avenir Next", Avenir, system-ui, sans-serif; margin: 5px 0 0; }
.cpl-field { display: grid; gap: 6px; }
.cpl-field > span, .cpl-glyph-field > span { font: 700 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .09em; text-transform: uppercase; }
.cpl-field small { color: var(--cpl-muted); }
.cpl-form-grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
.cpl-glyphs { display: grid; gap: 6px; grid-template-columns: repeat(6, 1fr); margin-top: 7px; }
.cpl-icon-choice { font-size: 19px; padding: 0; }
.cpl-icon-choice.is-selected { background: var(--cpl-ink); color: var(--cpl-paper); }
.cpl-dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.cpl-confirm-target { background: var(--cpl-panel); border: 1px solid var(--cpl-line); border-radius: 12px; display: grid; gap: 5px; padding: 14px; }
.cpl-confirm-target strong { font: 650 16px/1.2 "Avenir Next", Avenir, system-ui, sans-serif; }
.cpl-confirm-target code { color: var(--cpl-cobalt); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.cpl-file { cursor: pointer; display: inline-flex; overflow: hidden; position: relative; }
.cpl-file input { inset: 0; opacity: 0; position: absolute; }
.cpl-search::placeholder, .cpl-field input::placeholder, .cpl-field textarea::placeholder { color: var(--cpl-muted); opacity: 1; }
:root[data-theme="light"] .cpl-shell {
  --cpl-bg: #f3f2ea;
  --cpl-panel: #ffffff;
  --cpl-ink: #18201e;
  --cpl-muted: #505c56;
  --cpl-paper: var(--cpl-bg);
  --cpl-line: #aab2ac;
  --cpl-cobalt: #2458d6;
  --cpl-action: #2458d6;
  --cpl-danger: #982c2c;
  --cpl-error-bg: #fff0ed;
  --cpl-error-fg: #8f2925;
  --cpl-success-bg: #e9f7ee;
  --cpl-success-fg: #245b38;
  --cpl-signal: #2458d6;
}
@media (max-width: 760px) {
  .cpl-head { align-items: stretch; flex-direction: column; }
  .cpl-target { width: 100%; }
  .cpl-toolbar { grid-template-columns: 1fr; }
  .cpl-grid { grid-template-columns: 1fr; }
  .cpl-form-grid { grid-template-columns: 1fr; }
  .cpl-glyphs { grid-template-columns: repeat(4, 1fr); }
  .cpl-card { grid-template-columns: 48px minmax(0, 1fr); }
  .cpl-card-actions { grid-column: 1 / -1; justify-content: flex-end; }
}
@media (prefers-reduced-motion: no-preference) {
  .cpl-button, .cpl-card button, .cpl-icon-choice { transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease; }
  .cpl-button:active, .cpl-card button:active, .cpl-icon-choice:active { transform: scale(.98); }
}
`;
