import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_LIBRARY_STYLES } from "./components/command-library-styles";
import { REVIEW_STYLES } from "./components/review-styles";

const globalStylesPath = [
  resolve(process.cwd(), "src/styles.css"),
  resolve(process.cwd(), "apps/web/src/styles.css"),
].find(existsSync);
if (!globalStylesPath) throw new Error("Could not locate the web stylesheet from the test workspace");
const globalStyles = readFileSync(globalStylesPath, "utf8");

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);
  const linear = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  const red = linear[0]!;
  const green = linear[1]!;
  const blue = linear[2]!;
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const light = Math.max(foregroundLuminance, backgroundLuminance);
  const dark = Math.min(foregroundLuminance, backgroundLuminance);
  return (light + 0.05) / (dark + 0.05);
}

describe("visual accessibility style contract", () => {
  it("keeps every local normal-text foreground pair above 4.5:1", () => {
    const pairs = [
      ["#f1f0e7", "#111615"],
      ["#b6c0bb", "#111615"],
      ["#18201e", "#e8e8df"],
      ["#46534d", "#e8e8df"],
      ["#f1f0e7", "#222a27"],
      ["#b2bcb7", "#222a27"],
      ["#18201e", "#f3f2ea"],
      ["#505c56", "#f3f2ea"],
      ["#f1f4ef", "#202825"],
      ["#adb8b2", "#202825"],
      ["#17201e", "#f3f0e5"],
      ["#55615b", "#f3f0e5"],
      ["#ffffff", "#315fc7"],
      ["#ffffff", "#2458d6"],
      ["#8facff", "#1c2220"],
      ["#f1c56f", "#1c2220"],
      ["#ff9b8b", "#1c2220"],
      ["#8fdbaf", "#1c2220"],
      ["#bba5f0", "#1c2220"],
      ["#3159b6", "#ecece4"],
      ["#795517", "#ecece4"],
      ["#953b31", "#ecece4"],
      ["#246447", "#ecece4"],
      ["#604596", "#ecece4"],
    ] as const;

    for (const [foreground, background] of pairs) {
      expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("defines light and dark local surface tokens for every requested view", () => {
    expect(globalStyles).toContain("--view-fg: #f1f0e7;");
    expect(globalStyles).toContain("--view-fg: #18201e;");
    expect(globalStyles).toContain("--topbar-muted: #b6c0bb;");
    expect(globalStyles).toContain("--spatial-muted: var(--view-muted);");
    expect(globalStyles).toContain("--drawing-muted: #b2bcb7;");
    expect(globalStyles).toContain("--drawing-muted: #505c56;");
    expect(REVIEW_STYLES).toContain("--rv-shell-fg: #f1f4ef;");
    expect(REVIEW_STYLES).toContain("--rv-shell-fg: #18201e;");
    expect(COMMAND_LIBRARY_STYLES).toContain("--cpl-ink: #f1f4ef;");
    expect(COMMAND_LIBRARY_STYLES).toContain("--cpl-ink: #18201e;");
  });

  it("keeps Review, Spatial, and Drawing controls at least 44px", () => {
    expect(REVIEW_STYLES).toMatch(/\.review-studio button \{\s*min-width: 44px;/);
    expect(REVIEW_STYLES).toContain(".review-banner button,");
    expect(globalStyles).toMatch(/\.spatial-box-controls button \{\s*min-width: 44px;/);
    expect(globalStyles).toMatch(/\.drawing-studio button \{\s*min-width: 44px;/);
    expect(globalStyles).toMatch(/\.drawing-swatch \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
    expect(globalStyles).toMatch(/\.drawing-swatch::before \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
  });

  it("uses a two-column Spatial board on tablets and one column on phones", () => {
    expect(globalStyles).toMatch(/@media \(max-width: 820px\)[\s\S]*?\.spatial-box-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(globalStyles).toMatch(/@media \(max-width: 540px\)[\s\S]*?\.spatial-box-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(globalStyles).toMatch(/\.spatial-box--wide \{\s*grid-column: 1 \/ -1;/);
  });

  it("keeps the bounded local diff legible and contained on narrow screens", () => {
    expect(REVIEW_STYLES).toMatch(/\.review-compare-diff-canvas \{[\s\S]*?object-fit: contain;/);
    expect(REVIEW_STYLES).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.review-compare-diff-caption \{\s*grid-template-columns: 1fr;/);
    expect(REVIEW_STYLES).toContain(".review-compare-diff-legend i.is-changed { background: #ed725f; }");
  });
});
