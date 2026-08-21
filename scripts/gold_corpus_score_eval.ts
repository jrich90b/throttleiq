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
 *
 * ⚠️ AND IT STAYS UNSET *HERE*, even now that Joe has set one (25, 2026-08-21). The floor is applied
 * by the RELEASE GATE (`scripts/gold_score_gate.ts`), which runs where the score exists. THIS eval
 * runs in `ci:eval` — every worktree, every fresh clone, every other actor — and its ratchet branch
 * FAILS when a floor is set but no report is present. Defaulting it here would red-line the suite for
 * people who never asked about agent quality. Section "the floor Joe set" below pins that split so a
 * future tidy-up cannot quietly unify the two defaults.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pairKey, splitFor } from "../services/api/src/domain/goldCorpusHarvest.js";
import {
  GOLD_SCORE_DEFAULT_FLOOR,
  buildGoldEquivalencePrompt,
  checkGoldScoreFloor,
  isGoldScoreStale,
  isScoreableGoldExample,
  selectScoreableEvalItems,
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

check("COURTESY TURNS are not scoreable — read by hand 2026-08-04, they produced FALSE failures", () => {
  // "Ur welcome" -> the human happened to add "Dave I'm here I'll call you"; the agent's perfectly
  // good "Gotcha, thanks Dave" was marked wrong for not spontaneously promising a call. There is no
  // right answer to a thank-you, so it must not be graded.
  for (const t of ["Ur welcome", "thanks!", "Ok", "sounds good", "Got it", "will do", "no problem", "Perfect."]) {
    assert.equal(isScoreableGoldExample({ inbound: t, reply: "I'll call you" }), false, `courtesy turn should not be scored: ${t}`);
  }
  // But anything carrying real content still scores, including short questions.
  for (const t of ["ok what is the price?", "thanks - is it still available?", "Ur welcome, when can I come in?"]) {
    assert.equal(isScoreableGoldExample({ inbound: t, reply: "Sure — Tuesday works" }), true, `real content must still score: ${t}`);
  }
});

check("the judge keeps the STRICT equivalence bar — the loosened variant was measured and rejected", () => {
  const p = buildGoldEquivalencePrompt({ inbound: "no metal rack please", humanReply: "Do you own it or is there a lien?", agentReply: "Got it, no rack. Want me to hold the build?" });
  // Rebuilding this around "would the customer be WORSE OFF?" flipped a CONTROL: it rated a weak
  // web-lead first touch as fine. Catching those is the point, so the strict bar stays and the
  // score is read as "agreement with what our staff did", not "correctness". See goldCorpusScore.ts.
  assert.ok(/ACCOMPLISH WHAT THE HUMAN'S REPLY ACCOMPLISHED/.test(p), "equivalence, not a defect check");
  assert.ok(!/WORSE OFF/.test(p), "the rejected loosened variant must not creep back in unmeasured");
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

check("SELECTION: only scoreable items, and only the EVAL hold-out, ever get graded", () => {
  // Pinned by CALLING the selector, not by grepping the runner — a source-text assertion breaks on
  // every refactor and a sloppy re-pin passes while guarding nothing (eval_source_pin_ratchet).
  const corpus = [
    { convId: "a", reply: "real answer", inbound: "What is the out the door price on that Road Glide?" },
    { convId: "b", reply: "real answer", inbound: "Is the Street Bob still available this week?" },
    { convId: "c", reply: "", inbound: "What is the price?" }, // unscoreable: no human label
    { convId: "d", reply: "sure", inbound: "👍" }, // unscoreable: trivial turn
    { convId: "e", reply: "we are not buying outright", inbound: "Agent: Thank you for calling American Harley Davidson." } // IVR
  ];
  const key = (ex: { convId?: string | null }) => String(ex.convId ?? "");
  const allEval = selectScoreableEvalItems(corpus, () => "eval", key);
  assert.deepEqual(allEval.map(key), ["a", "b"], "the three unscoreable shapes are dropped");

  const allTrain = selectScoreableEvalItems(corpus, () => "train", key);
  assert.deepEqual(allTrain, [], "nothing on the TRAIN side is ever graded — that would be marking our own homework");

  const onlyB = selectScoreableEvalItems(corpus, k => (k === "b" ? "eval" : "train"), key);
  assert.deepEqual(onlyB.map(key), ["b"], "selection follows the split function, per item");
  assert.deepEqual(selectScoreableEvalItems(null, () => "eval", key), [], "no corpus selects nothing, never throws");
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

// ---------------------------------------------------------------------------------------------
// The floor Joe set — 25, 2026-08-21, against a measured 32.5% (and 29.1% on 08/04).
//
// Pinned as a DECISION, not a spelling: what matters is that the release gate enforces a positive
// floor by default, that the in-suite ratchet does NOT, and that the escape hatches behave. The gate
// script is EXECUTED against a synthetic report (trap 3: a source-text assertion cannot prove a
// script still runs), with `generatedAt` built relative to now so it can never go red at midnight.
// ---------------------------------------------------------------------------------------------
{
  assert.equal(GOLD_SCORE_DEFAULT_FLOOR, 25, "Joe's floor, 2026-08-21");
  assert.ok(
    GOLD_SCORE_DEFAULT_FLOOR > 0 && GOLD_SCORE_DEFAULT_FLOOR < 32.5,
    "a floor at or above the live reading turns judge jitter into a coin flip on every release"
  );

  // The pure ratchet, at the real floor and the real reading.
  assert.equal(checkGoldScoreFloor({ scored: 163, correct: 53, score: 32.5 } as any, GOLD_SCORE_DEFAULT_FLOOR, 20).ok, true, "today's 32.5% ships");
  assert.equal(checkGoldScoreFloor({ scored: 163, correct: 41, score: 25 } as any, GOLD_SCORE_DEFAULT_FLOOR, 20).ok, true, "exactly at the floor ships");
  assert.equal(checkGoldScoreFloor({ scored: 163, correct: 40, score: 24.9 } as any, GOLD_SCORE_DEFAULT_FLOOR, 20).ok, false, "a hair under does not");
  assert.equal(checkGoldScoreFloor({ scored: 3, correct: 3, score: 100 } as any, GOLD_SCORE_DEFAULT_FLOOR, 20).ok, false, "a thin run is a broken run, not a 100%");

  // THIS eval must not adopt the default — the whole point of the split.
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.ok(
    selfSrc.includes("process.env.GOLD_SCORE_FLOOR ? Number(process.env.GOLD_SCORE_FLOOR) : null"),
    "the in-suite ratchet must stay null-by-default or ci:eval breaks wherever no score report exists"
  );

  // WIRING: the gate reads the shared constant, and the release script pulls a fresh score first.
  const gateSrc = fs.readFileSync(new URL("./gold_score_gate.ts", import.meta.url), "utf8");
  assert.ok(gateSrc.includes("GOLD_SCORE_DEFAULT_FLOOR"), "the gate must use the shared floor, not a second copy of 25");
  const shSrc = fs.readFileSync(new URL("./release_gate_full.sh", import.meta.url), "utf8");
  const pullAt = shSrc.indexOf("gold_score_report.json");
  const checkAt = shSrc.indexOf("gold_score_gate.ts");
  assert.ok(pullAt > 0 && checkAt > 0 && pullAt < checkAt, "the release gate must pull the box's score BEFORE it checks the floor");

  // EXECUTE the gate against a synthetic report dir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goldgate-"));
  const dir = path.join(tmp, "gold_score");
  fs.mkdirSync(dir, { recursive: true });
  const writeReport = (score: number, ageHours: number) =>
    fs.writeFileSync(
      path.join(dir, "gold_score_report.json"),
      JSON.stringify({
        generatedAt: new Date(Date.now() - ageHours * 3_600_000).toISOString(),
        summary: { scored: 163, correct: Math.round((score / 100) * 163), score }
      })
    );
  const runGate = (env: Record<string, string>) => {
    const r = spawnSync("npx", ["tsx", fileURLToPath(new URL("./gold_score_gate.ts", import.meta.url))], {
      env: { ...process.env, GOLD_SCORE_DIR: dir, GOLD_SCORE_FLOOR: "", ...env },
      encoding: "utf8"
    });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  writeReport(32.5, 1);
  assert.equal(runGate({}).code, 0, "a fresh 32.5% passes the gate with no env at all — the floor is LIVE, not inert");

  writeReport(19.6, 1);
  const low = runGate({});
  assert.equal(low.code, 1, "a collapsed score STOPS the release");
  assert.ok(low.out.includes("below the floor"), "…and says why");

  writeReport(32.5, 100);
  assert.equal(runGate({}).code, 1, "a stale score stops it too — freshness is the gate's own question");

  writeReport(32.5, 1);
  assert.equal(runGate({ GOLD_SCORE_FLOOR: "0" }).code, 0, "GOLD_SCORE_FLOOR=0 is the deliberate emergency escape hatch");
  writeReport(19.6, 1);
  assert.equal(runGate({ GOLD_SCORE_FLOOR: "0" }).code, 0, "…and it really does disable the floor, not just lower it");
  assert.equal(runGate({ GOLD_SCORE_FLOOR: "abc" }).code, 1, "a junk floor is refused, never silently replaced by the default");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  ok  floor: default ${GOLD_SCORE_DEFAULT_FLOOR}, enforced by the release gate, inert in ci:eval`);
}

if (failures) {
  console.error(`\ngold_corpus_score:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("gold_corpus_score:eval passed");
