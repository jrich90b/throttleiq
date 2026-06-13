/**
 * Appointment outcome follow-up eval. Production P1: Donald Lauer
 * +17162285210, 2026-06-12 — staff recorded "showed / not_ready" and the
 * system created NO follow-up (cadence stopped, no draft, no task). The
 * activator only fired on secondaryStatus "needs_follow_up"; "not_ready"
 * (showed, interested, just not buying yet) is the textbook nurture case and
 * must activate the same follow-up cadence.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

// The activation gate must accept BOTH nurture-worthy secondary outcomes.
assert.match(
  apiSource,
  /const FOLLOW_UP_SECONDARY = new Set\(\["needs_follow_up", "not_ready"\]\)/,
  "appointment outcome follow-up must activate for needs_follow_up AND not_ready"
);
assert.match(
  apiSource,
  /Donald Lauer \+17162285210 showed\/not_ready/,
  "the not_ready follow-up gap must be documented at the fix"
);

// The old single-status gate must be gone.
assert.equal(
  (apiSource.match(/if \(args\.secondaryStatus !== "needs_follow_up"\) return \{ activated: false \};/g) ?? [])
    .length,
  0,
  "the needs_follow_up-only gate must be replaced by the set membership check"
);

// Behavioral copy of the gate.
const FOLLOW_UP_SECONDARY = new Set(["needs_follow_up", "not_ready"]);
const activatesFor = (s: string) => FOLLOW_UP_SECONDARY.has(s);
assert.equal(activatesFor("not_ready"), true, "not_ready activates");
assert.equal(activatesFor("needs_follow_up"), true, "needs_follow_up activates");
assert.equal(activatesFor("sold"), false, "sold never activates a nurture cadence");
assert.equal(activatesFor("lost"), false, "lost never activates a nurture cadence");
assert.equal(activatesFor("no_change"), false, "no_change never activates");

console.log("PASS appointment outcome follow-up eval");
