/**
 * report_path_convention:eval — a report the process writes must land where something reads it.
 *
 * Joe, 2026-08-04 ("is this happening anywhere else?"). It was. Every report picked its own env var
 * and defaulted to a CWD-RELATIVE path; the live API's cwd is `services/api`, so any writer that
 * fell through filed its output into the code tree. It fails SILENTLY — the directory is created,
 * the write succeeds, the data is simply invisible.
 *
 * The bill, measured on the box: the ADF-lane draft judge correctly HELD Lococo's fabricated
 * "$25,999-$44,999 / $560-$1,020/mo" draft at 2026-08-03T20:58Z — sixteen hours before Joe reported
 * the same draft by hand — and the verdict was unreadable. A daily compliance send audit had no
 * readable copy at all. `soft_visit_miss` / `stale_handoff` / `intent_handled` ran fresh while the
 * digest read copies up to five weeks stale.
 *
 * The guard that actually prevents recurrence is the SOURCE SWEEP at the bottom: one place decides
 * report paths, and a new writer cannot quietly reintroduce a cwd default.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reportRootConfigured,
  resetReportRootWarningForTests,
  resolveReportDir
} from "../services/api/src/domain/reportPaths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
let failures = 0;

function check(name: string, fn: () => void): void {
  const savedRoot = process.env.REPORT_ROOT;
  const savedLegacy = process.env.EMAIL_LANE_JUDGE_SHADOW_DIR;
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err?.message ?? err}`);
  } finally {
    if (savedRoot === undefined) delete process.env.REPORT_ROOT;
    else process.env.REPORT_ROOT = savedRoot;
    if (savedLegacy === undefined) delete process.env.EMAIL_LANE_JUDGE_SHADOW_DIR;
    else process.env.EMAIL_LANE_JUDGE_SHADOW_DIR = savedLegacy;
    resetReportRootWarningForTests();
  }
}

console.log("report_path_convention:eval");

check("REPORT_ROOT is used when set — the case that was broken", () => {
  process.env.REPORT_ROOT = "/runtime/reports";
  delete process.env.EMAIL_LANE_JUDGE_SHADOW_DIR;
  assert.equal(resolveReportDir("email_lane_judge"), path.join("/runtime/reports", "email_lane_judge"));
  assert.equal(reportRootConfigured(), true);
});

check("the report's own legacy env var still WINS — cron lines set these by name", () => {
  process.env.REPORT_ROOT = "/runtime/reports";
  process.env.EMAIL_LANE_JUDGE_SHADOW_DIR = "/explicit/somewhere";
  assert.equal(
    resolveReportDir("email_lane_judge", "EMAIL_LANE_JUDGE_SHADOW_DIR"),
    "/explicit/somewhere",
    "silently repointing an explicit override would move files a scheduler depends on"
  );
});

check("a blank or whitespace override does NOT count as set", () => {
  process.env.REPORT_ROOT = "/runtime/reports";
  process.env.EMAIL_LANE_JUDGE_SHADOW_DIR = "   ";
  assert.equal(
    resolveReportDir("email_lane_judge", "EMAIL_LANE_JUDGE_SHADOW_DIR"),
    path.join("/runtime/reports", "email_lane_judge")
  );
  process.env.REPORT_ROOT = "";
  assert.equal(reportRootConfigured(), false, "an empty REPORT_ROOT is unset, not root-relative");
});

check("with nothing configured it still resolves (never throws) AND warns exactly once", () => {
  delete process.env.REPORT_ROOT;
  delete process.env.EMAIL_LANE_JUDGE_SHADOW_DIR;
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    const a = resolveReportDir("email_lane_judge");
    const b = resolveReportDir("first_touch_autosend");
    assert.equal(a, path.resolve(process.cwd(), "reports", "email_lane_judge"), "still resolves — reports never break the caller");
    assert.ok(b.endsWith(path.join("reports", "first_touch_autosend")));
    assert.equal(warnings.length, 1, "warn ONCE per process — this fires from hot paths");
    assert.ok(String(warnings[0]?.[0] ?? "").includes("REPORT_ROOT is not set"), "the warning names the fix");
  } finally {
    console.warn = original;
  }
});

// ---------------------------------------------------------------------------------------------
// The guard that prevents this class from coming back.
// ---------------------------------------------------------------------------------------------

check("SOURCE SWEEP: no runtime code defaults a report path to the process CWD", () => {
  const roots = [path.join(repoRoot, "services/api/src")];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name === "reportPaths.ts") continue; // the one place allowed to name the fallback
      const src = fs.readFileSync(full, "utf8");
      if (/process\.cwd\(\)\s*,\s*["']reports["']/.test(src)) {
        offenders.push(path.relative(repoRoot, full));
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(
    offenders,
    [],
    `these write reports relative to the process CWD, where nothing reads them — use resolveReportDir(): ${offenders.join(", ")}`
  );
});

check("the three known runtime writers resolve through the shared helper", () => {
  const files = [
    ["services/api/src/domain/emailLaneJudgeShadow.ts", "email_lane_judge"],
    ["services/api/src/domain/firstTouchAutoSend.ts", "first_touch_autosend"],
    ["services/api/src/index.ts", "turn_understanding_shadow"]
  ] as const;
  for (const [file, name] of files) {
    const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.ok(
      new RegExp(`resolveReportDir\\(\\s*["']${name}["']`).test(src),
      `${file} must resolve "${name}" through resolveReportDir`
    );
  }
});

if (failures) {
  console.error(`\nreport_path_convention:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("report_path_convention:eval passed");
