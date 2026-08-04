/**
 * gold_corpus_score:eval — the cheap in-suite guard over the golden-corpus score.
 *
 * Joe, 2026-08-04, on eval practice: we had a golden corpus and NO consumer, so the suite could say
 * "these 392 specific things have not regressed" and could never say "the agent is X% right." The
 * scorer (`scripts/gold_corpus_score.ts`) produces the number; this pins the machinery around it and
 * ratchets the floor.
 *
 * DELIBERATELY SPLIT IN TWO. Scoring costs a compose + 3 judge calls per item and minutes of wall
 * clock, so it runs OUT of band (box, nightly/on-demand) exactly like the release gate's inputs.
 * What runs in `ci:eval` is this: pure assertions on the pure core, plus the ratchet read off the
 * scorer's report. No LLM, no network.
 *
 * WHY THE FLOOR STARTS UNSET. A ratchet seeded from a number nobody has looked at is worse than no
 * ratchet — it either blocks the build for noise or enshrines a bad score as "fine". Until the first
 * real run is read by a human, `GOLD_SCORE_FLOOR` is absent and the ratchet is INERT while every
 * structural assertion below still runs. Set the floor once the first score is in hand, with
 * headroom for judge jitter (55-74% self-agreement), and raise it only deliberately.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pairKey, splitFor } from "../services/api/src/domain/goldCorpusHarvest.js";
import {
  buildGoldEquivalencePrompt,
  checkGoldScoreFloor,
  isGoldScoreStale,
  isScoreableGoldExample,
  summarizeGoldScore,
  tallyVotes,
  type GoldItemVerdict
} from "../services/api/src/domain/goldCorpusScore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err?.message ?? err}`);
  }
}

const item = (correct: boolean, tier = "human_verbatim"): GoldItemVerdict => ({
  key: `k${Math.abs(correct ? 1 : 2)}`,
  convId: "+1716",
  tier,
  correct,
  votes: [correct],
  why: ""
});

console.log("gold_corpus_score:eval");

check("scoreable: needs BOTH sides and a real customer turn", () => {
  assert.equal(isScoreableGoldExample({ inbound: "What is the out the door price?", reply: "It's $29,399 plus tax" }), true);
  assert.equal(isScoreableGoldExample({ inbound: "What is the price?", reply: "" }), false, "no human label = nothing to grade against");
  assert.equal(isScoreableGoldExample({ inbound: "", reply: "Sure thing" }), false);
  assert.equal(isScoreableGoldExample({ inbound: "👍", reply: "You bet" }), false, "a trivial turn measures nothing");
  assert.equal(isScoreableGoldExample(null), false);
  // A voice transcript is OUR recording, not a customer message. One scored pair was the IVR menu
  // itself — no reply can be right, so it only drags the number down. (2 of 81 on 2026-08-04.)
  assert.equal(
    isScoreableGoldExample({
      inbound: "Agent: Thank you for calling American Harley Davidson. If you know your party's extension, you may enter it at any time.",
      reply: "we are not buying outright anymore at this time"
    }),
    false,
    "an IVR transcript is not an answerable customer turn"
  );
});

check("the vote is a majority, and a tie or an empty vote is NOT correct", () => {
  assert.equal(tallyVotes([true, true, false]), true);
  assert.equal(tallyVotes([true, false, false]), false);
  assert.equal(tallyVotes([true, false]), false, "a tie must fail — the score is a floor, so bias pessimistic");
  assert.equal(tallyVotes([]), false, "no usable verdict is not a pass");
  assert.equal(tallyVotes([null, undefined, true]), true, "unparseable samples drop out, the rest still vote");
});

check("the summary counts overall and per human-label tier", () => {
  const s = summarizeGoldScore([
    item(true),
    item(false),
    item(true, "positive_feedback"),
    item(true, "positive_feedback")
  ]);
  assert.equal(s.scored, 4);
  assert.equal(s.correct, 3);
  assert.equal(s.score, 75);
  assert.deepEqual(s.byTier.human_verbatim, { scored: 2, correct: 1 });
  assert.deepEqual(s.byTier.positive_feedback, { scored: 2, correct: 2 });
  assert.equal(summarizeGoldScore([]).score, 0, "an empty run is 0%, never 100%");
});

check("A THIN RUN IS A BROKEN RUN — never a pass, however good the percentage", () => {
  const perfectButTiny = summarizeGoldScore([item(true), item(true), item(true)]);
  assert.equal(perfectButTiny.score, 100);
  const verdict = checkGoldScoreFloor(perfectButTiny, 70, 20);
  assert.equal(verdict.ok, false, "3/3 is an outage, not a 100% — this is the trap every ratchet here has hit");
  assert.match(verdict.reason, /thin run/);
});

check("the floor blocks a regression and admits a hold", () => {
  const s = summarizeGoldScore(Array.from({ length: 40 }, (_, i) => item(i < 30)));
  assert.equal(s.score, 75);
  assert.equal(checkGoldScoreFloor(s, 70, 20).ok, true, "above the floor passes");
  assert.equal(checkGoldScoreFloor(s, 75, 20).ok, true, "exactly at the floor passes");
  assert.equal(checkGoldScoreFloor(s, 80, 20).ok, false, "below the floor fails");
  assert.equal(checkGoldScoreFloor(null, 70, 20).ok, false, "a missing report is a failure, not a skip");
});

check("a stale score is not evidence about today's agent", () => {
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  assert.equal(isGoldScoreStale("2026-08-04T06:00:00.000Z", now, 24), false);
  assert.equal(isGoldScoreStale("2026-08-01T06:00:00.000Z", now, 24), true);
  assert.equal(isGoldScoreStale(null, now, 24), true, "no timestamp = stale");
  assert.equal(isGoldScoreStale("not-a-date", now, 24), true);
});

check("the hold-out is STABLE — a growing corpus must not reshuffle the split", () => {
  const k = pairKey("+17165241170", "You could always use your tour pack until the new one arrives");
  assert.equal(splitFor(k), splitFor(k), "same pair, same side, every run");
  assert.notEqual(pairKey("+1716", "a"), pairKey("+1716", "b"), "different replies are different pairs");

  // Scoring the TRAIN side would be marking our own homework — few-shots may draw from it, so the
  // ~20% hold-out has to actually hold.
  //
  // MEASURE THE REAL KEY SHAPE. `splitFor` hashes with FNV-1a, which is lumpy over short SEQUENTIAL
  // strings in a small window — `gold_0..gold_499` lands at 38.6% eval, and a naive test built on
  // those keys reads as a broken split function when nothing is wrong. Actual corpus keys are
  // `pairKey` digests of convId|reply and distribute cleanly (18.6% at n=500, 20.3% at n=2000).
  // Assert on the shape the corpus really contains, not on a synthetic one.
  const N = 2000;
  let evalN = 0;
  for (let i = 0; i < N; i++) if (splitFor(pairKey(`+1716000${i}`, `reply body ${i}`), 0.2) === "eval") evalN++;
  const pct = (evalN / N) * 100;
  assert.ok(pct > 15 && pct < 25, `~20% hold-out over real pair keys, got ${pct.toFixed(1)}%`);
});

check("the judge is asked about SUBSTANCE, not wording", () => {
  const p = buildGoldEquivalencePrompt({ inbound: "whats the price", humanReply: "It's $29,399", agentReply: "That one is $29,399 before tax." });
  assert.ok(/ACCOMPLISH WHAT THE HUMAN'S REPLY ACCOMPLISHED/.test(p));
  assert.ok(/Do NOT grade wording, warmth, length, or style/.test(p), "two good replies can share no words");
  assert.ok(/different route is CORRECT/.test(p));
  assert.ok(p.includes("It's $29,399") && p.includes("That one is $29,399 before tax."), "both sides reach the judge");
});

check("WIRING: the scorer scores the EVAL split only, and never writes to conversations", () => {
  const src = fs.readFileSync(path.join(repoRoot, "scripts/gold_corpus_score.ts"), "utf8");
  assert.ok(/splitFor\([\s\S]{0,120}\) === "eval"/.test(src), "must filter to the eval hold-out");
  assert.ok(!/writeFileSync\([^)]*conversations/i.test(src), "the scorer is read-only on conversations");
  assert.ok(/resolveReportDir\(/.test(src), "output goes through the report-path convention, not cwd");
});

// ---------------------------------------------------------------------------------------------
// The ratchet itself — inert until a human sets a floor from a real score (see the header).
// ---------------------------------------------------------------------------------------------
const FLOOR = process.env.GOLD_SCORE_FLOOR ? Number(process.env.GOLD_SCORE_FLOOR) : null;
const MIN_SCORED = Number(process.env.GOLD_SCORE_MIN_SCORED ?? 20);
const reportPath =
  process.env.GOLD_SCORE_SUMMARY ||
  (process.env.REPORT_ROOT ? path.join(process.env.REPORT_ROOT, "gold_score", "gold_score_summary.json") : "");

if (FLOOR === null) {
  console.log("  --  ratchet INERT: set GOLD_SCORE_FLOOR once the first real score has been read");
} else if (!reportPath || !fs.existsSync(reportPath)) {
  failures += 1;
  console.error(`  FAIL ratchet: GOLD_SCORE_FLOOR=${FLOOR} is set but no score report at ${reportPath || "(REPORT_ROOT unset)"}`);
} else {
  const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const verdict = checkGoldScoreFloor(rep?.summary, FLOOR, MIN_SCORED);
  if (verdict.ok) console.log(`  ok  ratchet: ${verdict.reason}`);
  else {
    failures += 1;
    console.error(`  FAIL ratchet: ${verdict.reason}`);
  }
}

if (failures) {
  console.error(`\ngold_corpus_score:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("gold_corpus_score:eval passed");
