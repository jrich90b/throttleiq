/**
 * UI contrast guard eval (2026-07-11) — pins the light-island contrast fixes.
 *
 * Root cause (Joe, 7/10: "campaign setup / snooze button / booking link are not
 * high contrast enough"): CSS custom properties freeze their var() references at
 * the element where they are DECLARED. The --lr-app-* / --lr-* alias families are
 * declared on the DARK shell roots, so anything inside a LIGHT island
 * (.lr-light-modal, [data-actions-menu], the .bg-white/.bg-gray-50 flip surfaces)
 * that consumed them painted dark-shell colors onto light surfaces: near-white
 * input text on the white Campaign-setup panel, the washed-out Snooze button, the
 * reassign card's invisible Cancel/Save. The public /book page had the inverse:
 * no explicit text color, so a customer phone in dark mode flipped the inherited
 * body color near-white on the always-white card (invisible dates/times).
 *
 * Pins (all source guards — deterministic, no LLM):
 *   1. Both light-island blocks re-declare the alias families and paint their own
 *      foreground.
 *   2. No semantic-var/alias var() CYCLES (`--x: var(--lr-x)` mirrors) — cycles
 *      compute to guaranteed-invalid and leak OS-theme values into the shells.
 *   3. Campaign form/dialog inputs use surface-aware fills, never translucent
 *      white over an unknown surface.
 *   4. /book pins dark-on-light explicitly (text + color-scheme), and disabled
 *      calendar days use a legible muted color, not opacity.
 *   5. The Task Inbox snooze wrapper is NOT a light island (its button/menu sit
 *      on the dark row).
 *
 * Run: npx tsx scripts/ui_contrast_guard_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve("apps/web/src/app/globals.css"), "utf8");
const book = fs.readFileSync(path.resolve("apps/web/src/app/book/page.tsx"), "utf8");
const taskInbox = fs.readFileSync(
  path.resolve("apps/web/src/app/components/TaskInboxSection.tsx"),
  "utf8"
);

// --- 1) Light islands re-flip the alias families + paint their own foreground ---

// The .lr-light-modal/[data-actions-menu] island block.
const islandStart = css.indexOf(".lr-light-modal,\n[data-actions-menu] {");
assert.ok(islandStart >= 0, "the light-island block (.lr-light-modal, [data-actions-menu]) exists");
const islandBlock = css.slice(islandStart, css.indexOf("}", islandStart));
for (const decl of [
  "--lr-app-text: var(--text-primary)",
  "--lr-app-muted: var(--text-secondary)",
  "--lr-app-border: var(--border)",
  "--lr-text: var(--text-primary)",
  "--lr-muted: var(--text-secondary)",
  "--lr-surface-2: var(--surface-2)",
  "color: var(--text-primary)"
]) {
  assert.ok(
    islandBlock.includes(decl),
    `light-island block must re-declare "${decl}" (else island content paints dark-shell colors on light surfaces)`
  );
}

// The .bg-white/.bg-gray-50 utility flip block under the dark themes.
const flipStart = css.indexOf(".lr-app-theme .bg-white,");
assert.ok(flipStart >= 0, "the light-utility flip block exists");
const flipBlock = css.slice(flipStart, css.indexOf("}", flipStart));
for (const decl of ["--lr-app-text: var(--text-primary)", "--lr-text: var(--text-primary)", "--lr-muted: var(--text-secondary)"]) {
  assert.ok(
    flipBlock.includes(decl),
    `light-utility flip block must re-declare "${decl}" (Campaign setup labels/inputs washed out without it)`
  );
}

// --- 2) No semantic/alias var() cycles ---
// `--x: var(--lr-x)` next to `--lr-x: var(--x)` is a CSS custom-property cycle:
// both compute to guaranteed-invalid and the shells inherit OS-theme root values.
// Scan code only — comments may legitimately describe the anti-pattern.
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
const cycleMirror = cssCode.match(/--([a-z0-9-]+):\s*var\(--lr-\1\)/g);
assert.equal(
  cycleMirror,
  null,
  `no semantic var may point back at its own --lr- alias (cycle): found ${cycleMirror?.join(", ")}`
);

// --- 3) Campaign inputs are surface-aware ---
assert.ok(
  !css.includes("background: rgba(255, 255, 255, 0.03)"),
  "campaign form/dialog inputs must not use a translucent-white fill (invisible typing on light panels)"
);

// --- 4) /book (customer-facing booking link) pins dark-on-light ---
const bookRoots = book.match(/min-h-screen bg-gray-50 text-gray-900 \[color-scheme:light\]/g) ?? [];
assert.ok(
  bookRoots.length >= 2,
  "/book must pin text-gray-900 + [color-scheme:light] on BOTH page roots (main + Suspense fallback) — dark-mode phones otherwise render white-on-white dates/times"
);
assert.ok(
  !book.includes("opacity-40"),
  "/book disabled calendar days must use a legible muted color, not opacity"
);

// --- 5) Snooze wrapper is not a light island ---
const snoozeIdx = taskInbox.indexOf('"lr-task-snooze"');
assert.ok(snoozeIdx >= 0, "the snooze wrapper exists");
const snoozeLine = taskInbox.slice(snoozeIdx, taskInbox.indexOf(">", snoozeIdx) + 1);
assert.ok(
  !snoozeLine.includes("data-actions-menu"),
  "the snooze wrapper must NOT carry data-actions-menu (its button/menu sit on the dark row; the island flip washed them out)"
);

// ci:eval wiring.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(
  String(pkg.scripts?.["ci:eval"] ?? "").includes("ui_contrast_guard:eval"),
  "ui_contrast_guard:eval is wired into ci:eval"
);

console.log(
  "PASS ui contrast guard eval (island alias re-flip + no var cycles + surface-aware campaign inputs + /book dark-mode pin + snooze wrapper)"
);
