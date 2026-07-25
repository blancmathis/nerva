export const REVIEW_STYLES = String.raw`
.review-studio {
  --rv-shell-bg: #161b1a;
  --rv-shell-panel: #202825;
  --rv-shell-control: #27302d;
  --rv-shell-fg: #f1f4ef;
  --rv-shell-muted: #adb8b2;
  --rv-shell-line: #4e5a55;
  --rv-paper-bg: #f3f0e5;
  --rv-paper-sheet: #fbf9f1;
  --rv-paper-fg: #17201e;
  --rv-paper-muted: #55615b;
  --rv-paper-line: #b8bbb1;
  --rv-ink: var(--rv-paper-fg);
  --rv-muted: var(--rv-paper-muted);
  --rv-paper: var(--rv-paper-bg);
  --rv-sheet: var(--rv-paper-sheet);
  --rv-line: var(--rv-paper-line);
  --rv-dark: var(--rv-shell-bg);
  --rv-dark-2: var(--rv-shell-panel);
  --rv-cobalt: #4d7cff;
  --rv-action: #315fc7;
  --rv-tide: #76b8ad;
  --rv-accent-text: #76b8ad;
  --rv-coral: #ed725f;
  --rv-amber: #e8ae4a;
  color: var(--rv-shell-fg);
  background: var(--rv-shell-bg);
  display: grid;
  gap: 12px;
  grid-template-rows: auto auto minmax(0, 1fr);
  height: max(660px, calc(100dvh - 118px));
  min-width: 0;
  position: relative;
}
.review-studio *, .review-studio *::before, .review-studio *::after { box-sizing: border-box; }
.review-studio button, .review-studio input, .review-studio textarea, .review-studio select { font: inherit; }
.review-studio button, .review-studio label:has(input[type="file"]) { -webkit-tap-highlight-color: transparent; }
.review-studio button { cursor: pointer; min-height: 44px; }
.review-studio button:disabled { cursor: not-allowed; opacity: .44; }
.review-studio code { font: 600 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
.review-studio-header { align-items: end; display: flex; gap: 20px; justify-content: space-between; min-width: 0; }
.review-studio-header > div:first-child { min-width: 0; }
.review-studio .section-register { color: var(--rv-tide); font: 750 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .15em; text-transform: uppercase; }
.review-studio-header h1 { font-size: clamp(24px, 3vw, 39px); font-weight: 520; letter-spacing: -.045em; line-height: 1; margin: 5px 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-studio-header p { color: #939e99; margin: 0; }
.review-header-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 9px; justify-content: flex-end; }
.review-draft-state { color: #9ba7a1; font: 650 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .05em; text-transform: uppercase; }
.review-header-actions button { background: transparent; border: 1px solid #49534f; color: var(--paper-100, #f1f0e7); padding: 0 14px; }
.review-status-stack { display: grid; gap: 6px; }
.review-banner { align-items: center; background: #24322e; border: 1px solid #3e5b53; color: #c6ded6; display: flex; font-size: 12px; gap: 12px; justify-content: space-between; min-height: 40px; padding: 6px 8px 6px 12px; }
.review-banner.is-error { background: #362321; border-color: #6f3933; color: #f3b1a7; }
.review-banner button { background: transparent; border: 0; color: inherit; min-height: 30px; min-width: 34px; padding: 0; }
.review-update-banner { align-items: center; background: #332d20; border: 1px solid #6d5b36; color: #f0dfba; display: grid; gap: 3px 16px; grid-template-columns: auto minmax(0, 1fr); min-height: 44px; padding: 8px 12px; }
.review-update-banner strong { color: #f4c971; font-size: 11px; }
.review-update-banner span { color: #c8bdab; font-size: 10px; line-height: 1.4; }
.review-main-layout { display: grid; gap: 10px; grid-template-columns: 178px minmax(430px, 1fr) minmax(270px, 320px); min-height: 0; }
.review-filmstrip, .review-notes { background: var(--rv-dark); border: 1px solid #38413e; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.review-filmstrip { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
.review-filmstrip > header { align-items: center; border-bottom: 1px solid #343d39; display: flex; font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; justify-content: space-between; letter-spacing: .11em; min-height: 42px; padding: 0 12px; text-transform: uppercase; }
.review-filmstrip > header strong { color: var(--rv-tide); }
.review-filmstrip ol { list-style: none; margin: 0; overflow: auto; padding: 7px; }
.review-filmstrip li { border-left: 3px solid transparent; display: grid; gap: 3px; grid-template-columns: minmax(0, 1fr) auto; margin-bottom: 6px; padding-left: 3px; }
.review-filmstrip li.is-active { border-left-color: var(--rv-cobalt); }
.review-frame-select { align-items: center; background: #1d2522; border: 1px solid #35403b; color: var(--paper-100, #f1f0e7); display: grid; gap: 7px; grid-template-columns: 23px 43px minmax(0, 1fr); min-height: 62px; padding: 6px; text-align: left; width: 100%; }
.review-filmstrip li.is-active .review-frame-select { background: #26302c; border-color: #73837c; }
.review-frame-index { color: #7d8983; font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.review-frame-thumb, .review-frame-blank { background: #ece9de; border: 1px solid #59635f; height: 42px; object-fit: cover; width: 42px; }
.review-frame-blank { align-items: center; color: #7b8781; display: flex; font-size: 18px; justify-content: center; }
.review-frame-select > span:last-child { min-width: 0; }
.review-frame-select strong, .review-frame-select small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-frame-select strong { font-size: 11px; font-weight: 650; }
.review-frame-select small { color: #8e9994; font: 500 8px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 4px; }
.review-frame-order { display: flex; flex-direction: column; gap: 2px; }
.review-frame-order button { background: #202824; border: 1px solid #3a4540; color: #9ea8a3; min-height: 30px; min-width: 28px; padding: 0; }
.review-add-menu { border-top: 1px solid #343d39; display: grid; gap: 5px; padding: 7px; }
.review-add-menu button, .review-add-menu label { align-items: center; background: #222b27; border: 1px solid #3c4842; color: #d4d7cf; display: flex; font-size: 10px; font-weight: 650; justify-content: center; min-height: 42px; padding: 0 8px; position: relative; text-align: center; }
.review-add-menu label { cursor: pointer; }
.review-add-menu input[type="file"], .review-after-import input[type="file"] { inset: 0; opacity: 0; position: absolute; }
.review-workbench { background: var(--rv-paper); border: 1px solid #606760; color: var(--rv-ink); min-height: 0; overflow: auto; overscroll-behavior: contain; position: relative; }
.review-workbench::before { background: linear-gradient(90deg, var(--rv-cobalt) 0 33%, var(--rv-tide) 33% 66%, var(--rv-coral) 66%); content: ""; height: 3px; inset: 0 0 auto; position: absolute; z-index: 4; }
.review-surface-controls { align-items: center; background: #e4e1d7; border-bottom: 1px solid var(--rv-line); display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; min-height: 52px; padding: 7px 10px; position: sticky; top: 0; z-index: 8; }
.review-surface-switch, .review-input-modes, .review-compare-modes { display: flex; flex-wrap: wrap; gap: 4px; }
.review-surface-controls button, .review-compare-modes button { background: transparent; border: 1px solid #b8b9ae; color: #59635e; font-size: 10px; font-weight: 700; min-height: 36px; padding: 0 10px; }
.review-surface-controls button.is-active, .review-compare-modes button.is-active { background: var(--rv-ink); border-color: var(--rv-ink); color: #f8f5eb; }
.review-site-setup { align-items: center; background: #eeeae0; border-bottom: 1px solid var(--rv-line); display: grid; gap: 3px 11px; grid-template-columns: 34px minmax(0, 1fr); padding: 11px 12px; }
.review-site-setup > span { align-items: center; background: #e5d8bc; border: 1px solid #cbb889; border-radius: 11px; color: #805b16; display: flex; font-size: 18px; height: 34px; justify-content: center; width: 34px; }
.review-site-setup strong { color: var(--rv-paper-fg); display: block; font-size: 11px; }
.review-site-setup p, .review-site-setup small { color: var(--rv-paper-muted); font-size: 10px; line-height: 1.45; margin: 2px 0 0; }
.review-site-setup small { grid-column: 2; }
.review-live-site { display: grid; gap: 0; min-height: 100%; }
.review-site-modes { background: #2a322f; border-bottom: 1px solid #49534e; color: #e3e7e3; display: grid; gap: 8px 16px; grid-template-columns: minmax(150px, .55fr) minmax(260px, 1.45fr); padding: 11px 12px; }
.review-site-mode-heading { display: flex; flex-direction: column; gap: 4px; }
.review-site-mode-heading span { color: #91a09a; font: 700 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .09em; text-transform: uppercase; }
.review-site-mode-heading strong { color: #f0f2ee; font-size: 12px; }
.review-site-mode-options { display: grid; gap: 6px; grid-template-columns: 1fr 1.35fr; }
.review-site-mode-options button { align-items: flex-start; background: #202825; border: 1px solid #4d5953; color: #aeb7b2; display: flex; flex-direction: column; gap: 3px; justify-content: center; min-height: 44px; padding: 6px 9px; text-align: left; }
.review-site-mode-options button.is-active { background: #213a35; border-color: #5e9c8e; color: #f2f7f4; }
.review-site-mode-options button:disabled { cursor: default; opacity: 1; }
.review-site-mode-options small { color: #8f9b95; font: 650 8px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
.review-site-mode-options button.is-active small { color: #a9d8cd; }
.review-site-modes p { color: #b8c0bc; font-size: 10px; grid-column: 2; line-height: 1.45; margin: 0; }
.review-site-modes p strong { color: #e7c27d; }
.review-site-modes .review-site-mode-proof { color: #91a09a; }
.review-site-route { align-items: start; display: grid; gap: 4px; }
.review-site-route span { color: #91a09a; font: 700 8px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
.review-site-route code { color: #d9e3de; overflow-wrap: anywhere; user-select: text; }
.review-browser-bar { align-items: center; background: #242c29; color: #d1d6d2; display: grid; gap: 9px; grid-template-columns: 8px minmax(0, 1fr) auto; min-height: 44px; padding: 4px 10px; }
.review-browser-bar form { display: grid; grid-template-columns: minmax(0, 1fr) auto; min-width: 0; }
.review-browser-bar input { background: #18201d; border: 1px solid #46524d; color: #dbe0dc; min-height: 34px; min-width: 0; padding: 0 8px; }
.review-browser-bar form button { background: #35413c; border: 1px solid #52605a; color: white; min-height: 34px; padding: 0 10px; }
.review-browser-bar a { color: #a9c5ff; font-size: 10px; font-weight: 700; }
.review-browser-signal { background: var(--rv-tide); border-radius: 50%; box-shadow: 0 0 12px color-mix(in srgb, var(--rv-tide) 68%, transparent); height: 7px; width: 7px; }
.review-capture-state { align-items: center; background: #eeeae0; border-top: 1px solid var(--rv-line); display: grid; gap: 5px 12px; grid-template-columns: minmax(0, 1fr) auto; padding: 12px; }
.review-capture-state > span { color: #34665c; font-size: 11px; font-weight: 750; }
.review-capture-state.is-degraded > span { color: #96651b; }
.review-capture-state p { color: var(--rv-muted); font-size: 11px; grid-column: 1; margin: 0; }
.review-capture-viewport { align-items: center; color: var(--rv-muted); display: flex; font-size: 10px; gap: 8px; grid-column: 1; }
.review-capture-viewport select { background: var(--rv-sheet); border: 1px solid #b6b9b0; color: var(--rv-ink); min-height: 34px; }
.review-capture-state button { background: var(--rv-ink); border: 0; color: white; grid-column: 2; grid-row: 1 / span 3; padding: 0 14px; }
.review-sandbox-note { background: #dfddd3; color: #646c68; font-size: 10px; line-height: 1.5; margin: 0; padding: 10px 12px; }
@media (max-width: 760px) {
  .review-site-modes { grid-template-columns: 1fr; }
  .review-site-modes p { grid-column: 1; }
}
.review-frame-editor { min-height: 100%; }
.review-frame-stage { aspect-ratio: 4 / 3; background: #d7d5ca; border-bottom: 1px solid var(--rv-line); max-height: 62dvh; min-height: 340px; overflow: hidden; position: relative; }
.review-frame-background, .review-blank-paper, .review-static-interact-note { height: 100%; inset: 0; position: absolute; width: 100%; }
.review-frame-background { object-fit: contain; }
.review-blank-paper { align-items: center; background: linear-gradient(#f6f3e9 31px, #deddd2 32px); background-size: 100% 32px; color: #8e938c; display: flex; font: 650 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; justify-content: center; letter-spacing: .08em; text-transform: uppercase; }
.review-static-interact-note { align-items: center; background: rgba(20, 26, 24, .76); color: white; display: flex; font-size: 13px; justify-content: center; padding: 30px; text-align: center; z-index: 5; }
.review-drawing-layer { inset: 0; position: absolute; z-index: 3; }
.review-drawing-layer.drawing-canvas-editor { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; width: 100%; }
.review-drawing-layer .drawing-canvas-editor__tools { align-items: center; backdrop-filter: blur(12px); background: rgba(25, 32, 30, .9); border-bottom: 1px solid rgba(255,255,255,.16); color: white; display: flex; flex-wrap: wrap; gap: 4px; min-height: 48px; padding: 4px 7px; }
.review-drawing-layer .drawing-canvas-editor__tools button, .review-drawing-layer .drawing-canvas-editor__tools select { background: #28312e; border: 1px solid #4a5751; color: #e9ebe6; min-height: 38px; min-width: 38px; padding: 0 8px; }
.review-drawing-layer .drawing-canvas-editor__tools button.is-active { background: var(--rv-cobalt); border-color: #91adff; }
.review-drawing-layer .drawing-canvas-editor__text { background: white; border: 1px solid #aeb4ae; color: #19221f; min-height: 38px; padding: 0 8px; width: min(180px, 24vw); }
.review-drawing-layer .drawing-canvas-editor__color input { height: 34px; width: 38px; }
.review-drawing-layer .drawing-canvas-editor__canvas { background: transparent; display: block; height: 100%; min-height: 0; width: 100%; }
.review-frame-details { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; padding: 14px; }
.review-frame-details label, .review-general-instruction label { display: grid; gap: 5px; }
.review-frame-details label > span, .review-general-instruction label > span { color: var(--rv-muted); font: 750 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
.review-frame-details input, .review-frame-details textarea, .review-general-instruction textarea { background: var(--rv-sheet); border: 1px solid #bebfb5; color: var(--rv-ink); min-height: 44px; padding: 9px 10px; width: 100%; }
.review-frame-details textarea { min-height: 86px; resize: vertical; }
.review-frame-details label:has(textarea), .review-frame-metadata, .review-frame-actions { grid-column: 1 / -1; }
.review-frame-metadata { color: #69736e; display: flex; flex-wrap: wrap; font: 600 9px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; gap: 14px; }
.review-frame-actions { display: flex; gap: 7px; justify-content: flex-end; }
.review-frame-actions button, .review-after-import, .review-store-iteration { align-items: center; background: transparent; border: 1px solid #aeb2a8; color: #4d5752; display: inline-flex; font-size: 10px; font-weight: 700; justify-content: center; min-height: 42px; padding: 0 12px; position: relative; }
.review-after-import { cursor: pointer; }
.review-image-missing { align-items: center; background: #d8d7cd; color: #747b77; display: flex; font-size: 9px; justify-content: center; text-align: center; }
.review-comparison { border-top: 1px solid var(--rv-line); display: grid; gap: 12px; padding: 14px; }
.review-comparison header h3 { font-size: 21px; font-weight: 560; margin: 4px 0 0; }
.review-compare-side { display: grid; gap: 8px; grid-template-columns: 1fr 1fr; }
.review-compare-side figure { background: #e1dfd4; margin: 0; }
.review-compare-side img { aspect-ratio: 4 / 3; display: block; object-fit: contain; width: 100%; }
.review-compare-side figcaption { color: var(--rv-muted); font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 7px; text-transform: uppercase; }
.review-compare-overlay { aspect-ratio: 4 / 3; background: #d9d8cf; overflow: hidden; position: relative; }
.review-compare-overlay > img, .review-compare-after { height: 100%; inset: 0; object-fit: contain; position: absolute; width: 100%; }
.review-compare-after img { height: 100%; object-fit: contain; width: 100%; }
.review-compare-overlay label { bottom: 10px; display: grid; gap: 2px; inset-inline: 12px; position: absolute; z-index: 2; }
.review-compare-overlay label span { background: rgba(20,25,23,.8); color: white; font-size: 9px; justify-self: start; padding: 3px 5px; }
.review-compare-blink { background: #dad9d0; display: grid; gap: 8px; justify-items: center; padding: 8px; }
.review-compare-blink img { aspect-ratio: 4 / 3; object-fit: contain; width: 100%; }
.review-compare-blink button { background: var(--rv-ink); border: 0; color: white; padding: 0 12px; }
.review-compare-blink span { color: var(--rv-muted); font-size: 10px; }
.review-compare-diff { background: #1b211f; border: 1px solid #68716d; color: var(--rv-muted); display: grid; margin: 0; min-height: 170px; overflow: hidden; }
.review-compare-diff.is-unavailable { align-items: center; background: #e3e1d6; border-style: dashed; gap: 5px; justify-items: center; padding: 22px; text-align: center; }
.review-compare-diff.is-unavailable strong { color: var(--rv-ink); }
.review-compare-diff-viewport { align-items: center; background: #151a18; display: grid; max-height: 62dvh; min-height: 190px; overflow: hidden; position: relative; }
.review-compare-diff-canvas { display: block; height: 100%; image-rendering: auto; inset: 0; object-fit: contain; position: absolute; width: 100%; }
.review-compare-diff-message { align-items: center; background: #e3e1d6; color: var(--rv-muted); display: grid; gap: 5px; inset: 0; justify-items: center; padding: 22px; position: absolute; text-align: center; }
.review-compare-diff-message strong { color: var(--rv-ink); }
.review-compare-diff-caption { align-items: center; background: #242b28; color: #c4ccc8; display: grid; gap: 8px 14px; grid-template-columns: minmax(0, 1fr) auto; padding: 10px 12px; }
.review-compare-diff-caption > div:first-child { display: grid; gap: 3px; }
.review-compare-diff-caption strong { color: #f3f5f1; font-size: 13px; }
.review-compare-diff-caption span, .review-compare-diff-caption small { font: 600 9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
.review-compare-diff-caption small { color: #9fa9a4; grid-column: 1 / -1; }
.review-compare-diff-legend { align-items: center; display: flex; flex-wrap: wrap; gap: 9px; }
.review-compare-diff-legend span { align-items: center; display: flex; gap: 5px; }
.review-compare-diff-legend i { border: 1px solid rgba(255,255,255,.28); display: inline-block; height: 10px; width: 10px; }
.review-compare-diff-legend i.is-changed { background: #ed725f; }
.review-compare-diff-legend i.is-unchanged { background: #454d49; }
.review-store-iteration { justify-self: end; }
.review-notes { display: grid; gap: 0; grid-template-rows: minmax(150px, 1fr) auto; }
.review-general-instruction, .review-send-dock { border-bottom: 1px solid #343d39; padding: 12px; }
.review-general-instruction textarea { background: #1c2421; border-color: #414c47; color: #e4e7df; min-height: 92px; resize: vertical; }
.review-send-dock { border-bottom: 0; display: grid; gap: 6px; grid-template-columns: 1fr; }
.review-send-dock > div { background: #202824; border: 1px solid #38423e; display: grid; padding: 7px; text-align: center; }
.review-send-dock strong { color: #eef0e9; font: 700 17px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.review-send-dock span, .review-send-dock small { color: #84908a; font-size: 8px; text-transform: uppercase; }
.review-send-dock button, .review-send-confirm { background: var(--rv-cobalt); border: 0; color: white; font-size: 11px; font-weight: 750; grid-column: 1 / -1; padding: 0 12px; }
.review-send-dock small { grid-column: 1 / -1; text-align: center; }
.review-send-backdrop { align-items: end; background: rgba(8, 12, 11, .66); display: flex; inset: 0; justify-content: center; padding: max(14px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(14px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); position: fixed; z-index: 100; }
.review-send-sheet { background: var(--rv-paper); border: 1px solid #d5d3c8; box-shadow: 0 -24px 90px rgba(0,0,0,.34); color: var(--rv-ink); display: grid; gap: 13px; max-height: min(88dvh, 820px); max-width: 760px; overflow: auto; padding: 22px; width: 100%; }
.review-send-sheet h2 { font-size: clamp(23px, 4vw, 34px); font-weight: 540; letter-spacing: -.04em; margin: 5px 0; }
.review-send-sheet header p, .review-send-sheet section p { color: var(--rv-muted); font-size: 12px; margin: 0; }
.review-send-summary { display: grid; gap: 7px; grid-template-columns: repeat(2, 1fr); }
.review-send-summary div { background: #e5e2d8; border-left: 3px solid var(--rv-tide); display: grid; padding: 10px; }
.review-send-summary strong { font: 700 22px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.review-send-summary span { color: var(--rv-muted); font-size: 9px; margin-top: 4px; text-transform: uppercase; }
.review-send-sheet h3 { font-size: 12px; margin: 0 0 6px; text-transform: uppercase; }
.review-send-files { border: 1px solid var(--rv-line); list-style-position: inside; margin: 0; padding: 5px 9px; }
.review-send-files li { align-items: center; border-bottom: 1px solid #d8d6cb; display: flex; font-size: 11px; gap: 10px; justify-content: space-between; min-height: 36px; }
.review-send-files li:last-child { border-bottom: 0; }
.review-atomic-note { background: #e3e8f5; color: #3e526f; font-size: 11px; margin: 0; padding: 9px; }
.review-delivery-unavailable { background: #ece7d8; border-left: 3px solid var(--rv-amber); color: #6d5832; font-size: 11px; margin: 0; padding: 9px; }
.review-result { font-size: 12px; font-weight: 700; margin: 0; padding: 9px; }
.review-result.is-success { background: #dceee2; color: #315e3e; }
.review-result.is-pending { background: #ece7d8; color: #6d5832; }
.review-result.is-error { background: #f3ded9; color: #8a3830; }
.review-clear-confirm { align-items: center; background: #f3ded9; border-left: 3px solid #a7463b; display: grid; gap: 8px; grid-template-columns: 1fr auto auto; padding: 10px; }
.review-clear-confirm p { color: #71362f; font-size: 11px; grid-column: 1 / -1; margin: 0; }
.review-clear-confirm button { background: transparent; border: 1px solid #a36b64; color: #71362f; min-height: 44px; padding: 0 12px; }
.review-send-sheet footer { display: flex; gap: 8px; justify-content: flex-end; }
.review-send-sheet footer button { background: transparent; border: 1px solid #aeb1a7; color: var(--rv-ink); padding: 0 14px; }
.review-send-sheet footer .review-send-confirm { background: var(--rv-cobalt); border-color: var(--rv-cobalt); color: white; }
.review-studio.is-loading, .review-studio.is-error { align-items: center; border: 1px solid #3b4541; display: flex; justify-content: center; min-height: 420px; padding: 30px; text-align: center; }
@media (max-width: 1180px) {
  .review-main-layout { grid-template-columns: 158px minmax(430px, 1fr); }
  .review-notes { grid-column: 1 / -1; grid-template-columns: minmax(260px, 1fr) 190px; grid-template-rows: minmax(180px, auto); }
  .review-general-instruction { border-bottom: 0; border-right: 1px solid #343d39; }
  .review-send-dock { align-content: center; }
}
@media (max-width: 820px), (orientation: portrait) {
  .review-studio { height: auto; min-height: 100%; }
  .review-studio-header { align-items: stretch; flex-direction: column; }
  .review-header-actions { justify-content: space-between; }
  .review-main-layout { display: flex; flex-direction: column; }
  .review-filmstrip { flex: 0 0 auto; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto auto; overflow: hidden; }
  .review-filmstrip > header { grid-column: 1 / -1; }
  .review-filmstrip ol { display: flex; gap: 6px; overflow-x: auto; padding: 7px; }
  .review-filmstrip li { flex: 0 0 154px; margin: 0; }
  .review-frame-order { display: none; }
  .review-frame-select { grid-template-columns: 18px 38px minmax(0, 1fr); }
  .review-frame-thumb, .review-frame-blank { height: 38px; width: 38px; }
  .review-add-menu { border-left: 1px solid #343d39; border-top: 0; grid-template-columns: 1fr; min-width: 120px; }
  .review-workbench { min-height: 640px; overflow: visible; }
  .review-frame-stage { min-height: 430px; }
  .review-notes { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto auto; }
  .review-general-instruction { border-bottom: 1px solid #343d39; border-right: 1px solid #343d39; }
}
@media (max-width: 620px) {
  .review-main-layout { gap: 8px; }
  .review-update-banner { grid-template-columns: 1fr; }
  .review-filmstrip { display: block; }
  .review-add-menu { border-left: 0; border-top: 1px solid #343d39; grid-template-columns: repeat(3, 1fr); }
  .review-workbench { min-height: 560px; }
  .review-surface-controls { align-items: stretch; flex-direction: column; }
  .review-frame-stage { min-height: 360px; }
  .review-drawing-layer .drawing-canvas-editor__tools { overflow-x: auto; flex-wrap: nowrap; }
  .review-frame-details, .review-notes { grid-template-columns: 1fr; }
  .review-frame-details label, .review-general-instruction { grid-column: 1; }
  .review-notes > * { border-bottom: 1px solid #343d39; border-right: 0; }
  .review-capture-state { grid-template-columns: 1fr; }
  .review-capture-state button { grid-column: 1; grid-row: auto; }
  .review-send-summary { grid-template-columns: 1fr; }
  .review-send-files li { align-items: flex-start; flex-direction: column; justify-content: center; }
  .review-compare-diff-caption { grid-template-columns: 1fr; }
  .review-compare-diff-caption small { grid-column: 1; }
}

/* Local surface tokens keep Review readable in both app themes. The shell and
   paper workbench deliberately use separate foreground/muted pairs. */
.review-studio-header p,
.review-draft-state,
.review-frame-index,
.review-frame-select small,
.review-frame-order button,
.review-site-mode-heading span,
.review-site-mode-options button,
.review-site-mode-options small,
.review-site-modes p,
.review-site-modes .review-site-mode-proof,
.review-send-dock span,
.review-send-dock small {
  color: var(--rv-shell-muted);
}

.review-studio .section-register,
.review-filmstrip > header strong {
  color: var(--rv-accent-text);
}

.review-header-actions button,
.review-frame-select,
.review-frame-order button,
.review-add-menu button,
.review-add-menu label,
.review-site-modes,
.review-browser-bar,
.review-browser-bar input,
.review-general-instruction textarea,
.review-send-dock > div {
  color: var(--rv-shell-fg);
}

.review-workbench,
.review-send-sheet {
  color: var(--rv-paper-fg);
  background: var(--rv-paper-bg);
}

.review-drawing-layer .drawing-canvas-editor__tools button.is-active,
.review-send-dock button,
.review-send-confirm,
.review-send-sheet footer .review-send-confirm {
  border-color: var(--rv-action);
  color: #ffffff;
  background: var(--rv-action);
}

.review-capture-state p,
.review-capture-viewport,
.review-sandbox-note,
.review-frame-details label > span,
.review-frame-metadata,
.review-compare-side figcaption,
.review-compare-blink span,
.review-compare-diff,
.review-send-sheet header p,
.review-send-sheet section p,
.review-send-summary span {
  color: var(--rv-paper-muted);
}

.review-general-instruction label > span {
  color: var(--rv-shell-muted);
}

.review-frame-blank,
.review-image-missing,
.review-blank-paper {
  color: var(--rv-paper-muted);
}

.review-capture-state.is-degraded > span {
  color: #805b16;
}

/* Specific component rules previously shrank these controls below the 44px
   interaction contract. Glyphs remain compact inside the larger target. */
.review-studio button,
.review-studio select,
.review-studio input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="range"]):not([type="file"]),
.review-studio label:has(input[type="file"]) {
  min-height: 44px;
}

.review-studio button {
  min-width: 44px;
}

.review-banner button,
.review-frame-order button,
.review-drawing-layer .drawing-canvas-editor__tools button,
.review-drawing-layer .drawing-canvas-editor__tools select,
.review-frame-actions button,
.review-after-import,
.review-store-iteration {
  min-width: 44px;
  min-height: 44px;
}

.review-studio button > svg {
  width: 18px;
  height: 18px;
}

:root[data-theme="light"] .review-studio {
  --rv-shell-bg: #f3f2ea;
  --rv-shell-panel: #ffffff;
  --rv-shell-control: #ecece4;
  --rv-shell-fg: #18201e;
  --rv-shell-muted: #505c56;
  --rv-shell-line: #aab2ac;
  --rv-accent-text: #2d6658;
}

:root[data-theme="light"] .review-header-actions button,
:root[data-theme="light"] .review-filmstrip,
:root[data-theme="light"] .review-notes,
:root[data-theme="light"] .review-frame-select,
:root[data-theme="light"] .review-frame-order button,
:root[data-theme="light"] .review-add-menu button,
:root[data-theme="light"] .review-add-menu label,
:root[data-theme="light"] .review-site-mode-options button,
:root[data-theme="light"] .review-browser-bar input,
:root[data-theme="light"] .review-general-instruction textarea,
:root[data-theme="light"] .review-send-dock > div {
  border-color: var(--rv-shell-line);
  color: var(--rv-shell-fg);
  background: var(--rv-shell-panel);
}

:root[data-theme="light"] .review-filmstrip > header,
:root[data-theme="light"] .review-add-menu,
:root[data-theme="light"] .review-general-instruction,
:root[data-theme="light"] .review-send-dock {
  border-color: var(--rv-shell-line);
}

:root[data-theme="light"] .review-filmstrip li.is-active .review-frame-select {
  color: var(--rv-shell-fg);
  background: #e3e7e1;
  border-color: #728078;
}

:root[data-theme="light"] .review-site-modes,
:root[data-theme="light"] .review-browser-bar {
  border-color: var(--rv-shell-line);
  color: var(--rv-shell-fg);
  background: var(--rv-shell-control);
}

:root[data-theme="light"] .review-site-mode-heading strong {
  color: var(--rv-shell-fg);
}

:root[data-theme="light"] .review-site-mode-options button.is-active {
  border-color: #4e7f72;
  color: #183d34;
  background: #d7e9e2;
}

:root[data-theme="light"] .review-site-mode-options button.is-active small {
  color: #285c50;
}

:root[data-theme="light"] .review-site-modes p strong {
  color: #805b16;
}

:root[data-theme="light"] .review-browser-bar form button {
  border-color: #35413c;
  color: #ffffff;
  background: #35413c;
}

:root[data-theme="light"] .review-browser-bar a {
  color: #244f9f;
}

:root[data-theme="light"] .review-send-dock strong {
  color: var(--rv-shell-fg);
}

:root[data-theme="light"] .review-studio.is-loading,
:root[data-theme="light"] .review-studio.is-error {
  border-color: var(--rv-shell-line);
}

@media (prefers-reduced-motion: no-preference) {
  .review-studio button { transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease; }
  .review-studio button:active { transform: scale(.98); }
  .review-browser-signal { animation: review-signal 1.8s ease-in-out infinite; }
  @keyframes review-signal { 50% { opacity: .5; box-shadow: 0 0 4px transparent; } }
}
`;
