/**
 * gold_score_gate — the release gate's golden-corpus check.
 *
 * `gold_corpus_score:eval` (in `ci:eval`) is the cheap in-suite RATCHET: it runs everywhere, needs no
 * network, and is inert until a floor is set. This is the stricter DEPLOY-time question, and it adds
 * the one thing the in-suite ratchet deliberately cannot ask: **is the number fresh?** A score from
 * last week says nothing about the agent you are about to ship, but failing `ci:eval` on staleness
 * would block every developer's build for a report only the box produces. So freshness lives here,
 * at the gate, where the answer is actionable: re-run the scorer on the box.
 *
 * Reads (never writes): $REPORT_ROOT/gold_score/gold_score_report.json.
 *
 * Fail-direction: this gates a DEPLOY, so every ambiguity fails CLOSED — missing report, unreadable
 * report, thin run, stale run, or a score under the floor all stop the release. That is the opposite
 * of the merge freeze (which fails open), and deliberately so: refusing to ship costs a delay,
 * shipping an unmeasured agent costs customers.
 *
 *   npx tsx scripts/gold_score_gate.ts     # exit 0 = ok to ship, exit 1 = stop
 *
 * Env: GOLD_SCORE_FLOOR (default GOLD_SCORE_DEFAULT_FLOOR = 25, Joe 2026-08-21; set it to 0 to
 *      disable the floor in an emergency without editing code), GOLD_SCORE_MIN_SCORED (default 20),
 *      GOLD_SCORE_MAX_AGE_HOURS (default 48), REPORT_ROOT / GOLD_SCORE_DIR.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOLD_SCORE_DEFAULT_FLOOR,
  checkGoldScoreFloor,
  isGoldScoreStale
} from "../services/api/src/domain/goldCorpusScore.ts";

const MAX_AGE_HOURS = Number(process.env.GOLD_SCORE_MAX_AGE_HOURS ?? 48);
const MIN_SCORED = Number(process.env.GOLD_SCORE_MIN_SCORED ?? 20);
// Joe set the floor on 2026-08-21, so the default is a NUMBER and this gate now enforces. The env
// var still wins when present — including `GOLD_SCORE_FLOOR=0`, the no-code-change escape hatch for
// an emergency ship. `""` is treated as absent, so an empty var cannot silently disable the gate.
const FLOOR_RAW = String(process.env.GOLD_SCORE_FLOOR ?? "").trim();
const FLOOR = FLOOR_RAW === "" ? GOLD_SCORE_DEFAULT_FLOOR : Number(FLOOR_RAW);

function reportPath(): string {
  const dir =
    process.env.GOLD_SCORE_DIR ||
    (process.env.REPORT_ROOT ? path.join(process.env.REPORT_ROOT, "gold_score") : path.resolve("reports/gold_score"));
  return path.join(dir, "gold_score_report.json");
}

function main(): void {
  const file = reportPath();

  if (!Number.isFinite(FLOOR)) {
    // Only reachable via a junk override (GOLD_SCORE_FLOOR=abc). Refuse rather than fall back to the
    // default: someone meant to change the floor and got it wrong, and silently enforcing a different
    // number than they asked for is worse than stopping. `=0` is finite and disables deliberately.
    console.error(`    GOLD_SCORE_FLOOR="${FLOOR_RAW}" is not a number — refusing to guess which floor you meant.`);
    process.exit(1);
  }
  if (FLOOR <= 0) {
    console.log(`    !! GOLD_SCORE_FLOOR=${FLOOR} — the golden-corpus check is DISABLED for this run.`);
    console.log("       The gate proved regressions only; it says NOTHING about agent quality.");
    process.exit(0);
  }

  if (!fs.existsSync(file)) {
    console.error(`    no gold score report at ${file} — run scripts/gold_corpus_score.ts on the box first.`);
    process.exit(1);
  }

  let rep: any;
  try {
    rep = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err: any) {
    console.error(`    gold score report is unreadable (${err?.message ?? err}) — treat as no evidence.`);
    process.exit(1);
  }

  if (isGoldScoreStale(rep?.generatedAt, Date.now(), MAX_AGE_HOURS)) {
    console.error(
      `    gold score is STALE (generated ${rep?.generatedAt ?? "never"}, max age ${MAX_AGE_HOURS}h) — ` +
        "re-run scripts/gold_corpus_score.ts on the box; an old number is not evidence about today's agent."
    );
    process.exit(1);
  }

  const verdict = checkGoldScoreFloor(rep?.summary, FLOOR, MIN_SCORED);
  if (!verdict.ok) {
    console.error(`    ${verdict.reason}`);
    process.exit(1);
  }

  const s = rep.summary;
  console.log(`    GOLD SCORE ${s.score}% (${s.correct}/${s.scored}) — floor ${FLOOR}%, generated ${rep.generatedAt}`);
  process.exit(0);
}

const isEntry = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main();
