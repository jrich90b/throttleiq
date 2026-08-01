/**
 * Decision-equivalence harness — prove an un-stacking changed nothing.
 *
 * Joe, 2026-08-01. Un-stacking is meant to be behavior-preserving; this is what turns that from a
 * claim into a measurement, by replaying the LIVE conversation corpus through both versions of the
 * code and comparing what the agent DECIDED (not what it wrote — reply prose is LLM-generated and
 * differs every run; decisions are deterministic and are what un-stacking can break).
 *
 * TWO STEPS, because old and new code cannot both be loaded in one process:
 *
 *   # on main (the baseline)
 *   npx tsx scripts/decision_equivalence.ts snapshot --out /tmp/eq-before.json
 *   # on the un-stacking branch
 *   npx tsx scripts/decision_equivalence.ts snapshot --out /tmp/eq-after.json
 *   npx tsx scripts/decision_equivalence.ts diff --before /tmp/eq-before.json --after /tmp/eq-after.json
 *
 * The clock is PINNED and carried inside the snapshot: both runs must share it or the diff refuses
 * to compare (a wall-clock read would differ between runs for reasons unrelated to the change).
 * Pass --now <iso> on the first run and the same value on the second; the diff enforces it.
 *
 * EXIT CODES: 0 = provably identical. 1 = decisions changed, or the comparison could not be
 * trusted. There is no "probably fine" — a run that verified nothing exits 1.
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildDecisionRegistry,
  diffFingerprints,
  fingerprintCorpus,
  type FingerprintClock
} from "../services/api/src/domain/decisionFingerprint.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = process.argv[2];

if (mode === "snapshot") {
  const out = arg("out");
  if (!out) {
    console.error("decision_equivalence snapshot --out <file> [--now <iso>] [--tz <zone>]");
    process.exit(1);
  }
  const dbPath =
    process.env.CONVERSATIONS_DB_PATH || path.resolve("services/api/data/conversations.json");
  if (!fs.existsSync(dbPath)) {
    console.error(`decision_equivalence: conversations store not found at ${dbPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const conversations: any[] = Array.isArray(raw) ? raw : (raw?.conversations ?? []);

  const nowIso = arg("now");
  const nowMs = nowIso ? Date.parse(nowIso) : Date.parse("2026-08-01T12:00:00.000Z");
  if (!Number.isFinite(nowMs)) {
    console.error(`decision_equivalence: --now "${nowIso}" is not a valid ISO timestamp`);
    process.exit(1);
  }
  const clock: FingerprintClock = { nowMs, timeZone: arg("tz") || "America/New_York" };

  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const registry = buildDecisionRegistry(reducer);
  const run = fingerprintCorpus(conversations, registry, clock);

  fs.writeFileSync(out, JSON.stringify(run));
  console.log(
    `snapshot: ${run.conversations.length} conversation(s), ${run.decisionNames.length} decision(s)` +
      `${run.errors.length ? `, ${run.errors.length} PROJECTION ERROR(S)` : ""} -> ${out}`
  );
  // A snapshot that captured nothing must not silently become a green comparison later.
  if (!run.conversations.length) {
    console.error("decision_equivalence: the corpus is empty — this snapshot proves nothing");
    process.exit(1);
  }
  process.exit(0);
}

if (mode === "diff") {
  const beforePath = arg("before");
  const afterPath = arg("after");
  if (!beforePath || !afterPath) {
    console.error("decision_equivalence diff --before <file> --after <file>");
    process.exit(1);
  }
  const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
  const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
  const result = diffFingerprints(before, after);

  console.log(
    `compared ${result.comparedConversations} conversation(s) / ${result.comparedDecisions} decision(s)`
  );
  for (const blocker of result.blockers) console.error(`BLOCKER: ${blocker}`);

  if (result.changes.length) {
    console.error(`\n${result.changes.length} DECISION CHANGE(S) — this is NOT behavior-preserving:\n`);
    const byDecision = new Map<string, typeof result.changes>();
    for (const change of result.changes) {
      const list = byDecision.get(change.decision) ?? [];
      list.push(change);
      byDecision.set(change.decision, list);
    }
    for (const [decision, changes] of byDecision) {
      console.error(`  ${decision}: ${changes.length} conversation(s)`);
      for (const change of changes.slice(0, 5)) {
        console.error(
          `    ${change.convId}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`
        );
      }
      if (changes.length > 5) console.error(`    …and ${changes.length - 5} more`);
    }
    console.error(
      "\nIf these changes are INTENDED, this is a behavior change, not a cleanup: say so " +
        "prominently in the PR body and flag it for Joe. Never let it ride as 'refactor'."
    );
  }

  if (result.identical) {
    console.log("\nIDENTICAL — every sampled decision agreed across the whole corpus.");
    process.exit(0);
  }
  process.exit(1);
}

console.error("usage: decision_equivalence <snapshot|diff> ...");
process.exit(1);
