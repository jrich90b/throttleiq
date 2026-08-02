/**
 * canary_watch — watch a deploy, and say plainly whether it hurt anyone.
 *
 * Joe, 2026-08-01: "Is there a way to continuously work without me approving PRs."
 *
 * This is the other half of that answer. `decision_equivalence` proves a change is safe to ship;
 * this checks whether it WAS, by comparing what the agent actually did to customers before and
 * after. Autonomy is not made safe by a gate in front — it is made safe by being reversible with
 * detection behind. See services/api/src/domain/canaryHealth.ts for the reasoning and fail
 * direction.
 *
 * SHADOW MODE BY DEFAULT, and there is no --act. It prints the verdict and, when something
 * regressed, the exact rollback commands. It never reverts and never deploys. That is deliberate:
 * deciding a rollback is warranted and having authority to redeploy production are different
 * things, and this tool only ever has the first. Arming it is Joe's call, and the honest way to
 * earn that is a stretch of runs where its shadow verdicts were right.
 *
 *   # at deploy time, capture the "before" window
 *   CONVERSATIONS_DB_PATH=/tmp/c.json npx tsx scripts/canary_watch.ts baseline --out /tmp/canary.json
 *   # once the window (default 24h — this store sends ~26/day) has elapsed, judge it
 *   CONVERSATIONS_DB_PATH=/tmp/c.json npx tsx scripts/canary_watch.ts check --baseline /tmp/canary.json
 *
 * NEVER point CONVERSATIONS_DB_PATH at the live store: copy it, read the copy, delete the copy. It
 * is customer PII.
 *
 * EXIT CODES: 0 healthy · 1 regressed · 2 unknown/blocked. UNKNOWN is deliberately NOT 0 — a run
 * that concluded nothing must never be scriptable as success.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  computeCanaryCounters,
  decideCanaryVerdict,
  detectRunaway,
  findDeadCounters,
  typicalPeakOutboundPerHour,
  buildRevertPlan,
  DEFAULT_CANARY_THRESHOLDS,
  type CanaryCounters
} from "../services/api/src/domain/canaryHealth.ts";

type BaselineFile = {
  takenAtMs: number;
  windowMs: number;
  deployedSha: string;
  counters: CanaryCounters;
  /** The store's own busiest hour, so the fast tripwire scales with the dealership. */
  typicalPeakOutboundPerHour: number;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadConversations(): any[] {
  const dbPath =
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "conversations.json")
      : path.resolve("services/api/data/conversations.json"));
  if (!fs.existsSync(dbPath)) {
    console.error(`canary_watch: conversations store not found at ${dbPath}`);
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const convs: any[] = Array.isArray(raw) ? raw : (raw?.conversations ?? []);
  if (!convs.length) {
    // Fail closed: an empty store cannot clear a deploy.
    console.error("canary_watch: the store is empty — a canary that measured nothing proves nothing");
    process.exit(2);
  }
  return convs;
}

function currentSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const nowMs = (() => {
  const override = arg("now");
  if (!override) return Date.now();
  const t = Date.parse(override);
  if (!Number.isFinite(t)) {
    console.error(`canary_watch: --now "${override}" is not a valid ISO timestamp`);
    process.exit(2);
  }
  return t;
})();

const mode = process.argv[2];

if (mode === "baseline") {
  const out = arg("out");
  if (!out) {
    console.error("canary_watch baseline --out <file> [--hours N] [--now <iso>]");
    process.exit(2);
  }
  // 48h, not 6: this store sends ~26 customer messages a DAY (36 over 48h, 10 over a quiet 24h), so
  // anything shorter routinely falls under the 20-send floor and abstains. Measured, not assumed.
  const hours = Number(arg("hours") ?? 48) || 48;
  const windowMs = Math.max(1, hours) * 3_600_000;
  const conversations = loadConversations();

  // FAIL CLOSED on broken instrumentation. A counter reading zero across the whole store is not a
  // quiet period, it is a counter wired to the wrong field — which is exactly how the first version
  // of this tool shipped counting nothing while passing its own tests.
  const dead = findDeadCounters(conversations);
  if (dead.length) {
    console.error(
      `canary_watch: these counters read ZERO across the ENTIRE store: ${dead.join(", ")}.\n` +
        "  That is unwired instrumentation, not a quiet period. A baseline built on dead counters\n" +
        "  would clear any deploy. Fix the projection in domain/canaryHealth.ts before using this."
    );
    process.exit(2);
  }

  const counters = computeCanaryCounters(conversations, {
    startMs: nowMs - windowMs,
    endMs: nowMs
  });
  const payload: BaselineFile = {
    takenAtMs: nowMs,
    windowMs,
    deployedSha: arg("sha") ?? currentSha(),
    counters,
    typicalPeakOutboundPerHour: typicalPeakOutboundPerHour(conversations)
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(
    `canary baseline over the ${hours}h before the deploy -> ${out}\n` +
      `  sends=${counters.outboundToCustomer} drafts=${counters.draftsProduced} ` +
      `closed=${counters.conversationsClosed} held=${counters.draftsHeld} ` +
      `convs=${counters.activeConversations} · typical busy hour=${payload.typicalPeakOutboundPerHour}/h`
  );
  if (counters.outboundToCustomer < DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound) {
    console.log(
      "  NOTE: too quiet to judge a deploy against " +
        `(${counters.outboundToCustomer} < ${DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound} sends). ` +
        "The slow check will return UNKNOWN — widen --hours. The fast runaway tripwire still works."
    );
  }
  process.exit(0);
}

if (mode === "check") {
  const baselinePath = arg("baseline");
  if (!baselinePath || !fs.existsSync(baselinePath)) {
    console.error("canary_watch check --baseline <file> [--now <iso>]");
    process.exit(2);
  }
  const baseline: BaselineFile = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const watchEndMs = baseline.takenAtMs + baseline.windowMs;

  // Judging a half-elapsed window would compare a partial period against a full one and invent a
  // "collapse" every time. Not yet ready is UNKNOWN, never healthy.
  if (nowMs < watchEndMs) {
    const minsLeft = Math.ceil((watchEndMs - nowMs) / 60_000);
    console.log(
      `canary: UNKNOWN — the watch window has not elapsed (${minsLeft} min left).\n` +
        "  A partial window compared against a full one reads as a collapse. Re-run later."
    );
    process.exit(2);
  }

  const conversations = loadConversations();
  const current = computeCanaryCounters(conversations, {
    startMs: baseline.takenAtMs,
    endMs: watchEndMs
  });
  const runaway = detectRunaway(
    current.outboundToCustomer,
    baseline.windowMs,
    baseline.typicalPeakOutboundPerHour ?? typicalPeakOutboundPerHour(conversations)
  );
  const verdict = decideCanaryVerdict(baseline.counters, current, DEFAULT_CANARY_THRESHOLDS, runaway);

  const row = (label: string, c: CanaryCounters) =>
    `  ${label.padEnd(7)} sends=${c.outboundToCustomer} drafts=${c.draftsProduced} ` +
    `closed=${c.conversationsClosed} held=${c.draftsHeld} convs=${c.activeConversations}`;
  console.log(
    `canary check — ${baseline.windowMs / 3_600_000}h window, sha ${baseline.deployedSha.slice(0, 8) || "(unrecorded)"}` +
      ` · ${runaway.perHour}/h vs runaway ceiling ${runaway.limit}/h`
  );
  console.log(row("before", baseline.counters));
  console.log(row("after", current));
  console.log();

  if (verdict.status === "unknown") {
    console.log("canary: UNKNOWN — this is NOT a clean bill of health.");
    for (const b of verdict.blockers) console.log(`  - ${b}`);
    process.exit(2);
  }

  if (verdict.status === "regressed") {
    console.log("canary: REGRESSED — the deploy moved guarded counters past their limits:");
    for (const b of verdict.breaches) console.log(`  - [${b.kind}] ${b.detail}`);
    console.log("\nROLLBACK PLAN (shadow mode — NOT executed):");
    for (const line of buildRevertPlan(verdict, baseline.deployedSha)) console.log(`  ${line}`);
    process.exit(1);
  }

  console.log(`canary: HEALTHY — ${verdict.reason}`);
  process.exit(0);
}

console.error("Usage: canary_watch.ts <baseline --out <f> [--hours N] | check --baseline <f>> [--now <iso>]");
process.exit(2);
