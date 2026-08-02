import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

// The similarity math is IMPORTED, never re-declared here.
//
// Until 2026-08-02 this file carried a hand-copied duplicate of the algorithm, and the copy had
// drifted from the code that actually runs: it stripped only the ASCII apostrophe where the real
// code also strips the curly one. On the production pair pinned below, the copy scored 0.8095 and
// the shipped code scored 0.7727 — straddling the 0.82 decision threshold. The eval was green
// about math nobody deployed. Import the real module; never paste it back.
import {
  cadenceTokenOverlapScore,
  isCadenceNearDuplicateText,
  CADENCE_NEAR_DUPLICATE_OVERLAP_MIN
} from "../services/api/src/domain/cadenceRepeatSimilarity.js";

function normalizeOutboundText(text: string): string {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isInventoryUnavailableCadenceText(text: string): boolean {
  const normalized = normalizeOutboundText(text);
  if (!normalized) return false;
  const unavailable =
    /\b(bike|unit|that|specific)\b.{0,80}\b(has sold|sold|no longer available|on hold|hold right now)\b/.test(
      normalized
    ) ||
    /\b(has sold|no longer available|on hold|hold right now)\b/.test(normalized);
  const nextStep =
    /\b(check inventory|choose another bike|similar options|keep an eye|opens back up|available again)\b/.test(
      normalized
    );
  return unavailable && nextStep;
}

const exactUnitDraft =
  "Hey Lizbeth, I know you were interested in the 2022 Iron 883, but that bike has sold. If you want, I can check inventory with you so you can choose another bike.";
const familyFallbackDraft =
  "Hey Lizbeth, I know you were interested in the Sportster, but that bike has sold. If you want, I can check inventory with you so you can choose another bike.";
const unrelatedDraft =
  "Hey Lizbeth, we have fresh Nightster options in stock if you want current photos.";

assert.equal(isInventoryUnavailableCadenceText(exactUnitDraft), true);
assert.equal(isInventoryUnavailableCadenceText(familyFallbackDraft), true);
assert.equal(isInventoryUnavailableCadenceText(unrelatedDraft), false);
assert.ok(
  cadenceTokenOverlapScore(exactUnitDraft, familyFallbackDraft) >= 0.82,
  "sold update drafts with exact-unit vs family labels should be near-duplicate candidates"
);
assert.equal(
  isCadenceNearDuplicateText(exactUnitDraft, familyFallbackDraft),
  true,
  "the shipped guard must still catch the top-band case it was built for"
);

// ---------------------------------------------------------------------------
// PRODUCTION PIN — the repeat the token-overlap guard does NOT catch.
//
// Operator-reported by Joe (finding key `+16102170861::reported_issue`, dimension=cadence):
// "THIS GENERATED THE SAME FOLLOW UP CADENCE AS WE ALREADY SENT HIM." Seth Farrand, a Trade
// Accelerator trade-in lead, got the same touring-payment pitch twice — same bike, same $406/month,
// same ask, 11 days apart, only reworded.
//
// That specific send is already suppressed today by the engagement gate (#401) and the offer
// identity snap-back (#403), both merged 2026-08-01 AFTER this went out. What these rows pin is
// what those fixes did NOT close: for a lead who HAS engaged and HAS raised money — where #401 and
// #409 are inert by design — the last line of defence is this token-overlap threshold, and on real
// reworded copy it measures 0.7727 against a 0.82 bar. #403's commit body claims this backstop
// "on its own would have caught every case here"; these rows are the measurement showing it does
// not, so nobody relies on that claim again.
//
// These assert the SCORES, not a verdict, so they survive the fix that closes the gap: adding a
// semantic band on top does not move the arithmetic. Do NOT close the gap by lowering 0.82 — the
// legitimate alternatives below sit at 0.167-0.467, and the room between 0.467 and 0.773 is
// exactly where "same angle, reworded" and "same bike, genuinely new reason" both live.
// ---------------------------------------------------------------------------

const sentJul21 =
  "Seth, the 2026 Road Glide you looked at qualifies for the touring extended-term program — they’re showing payments from $406/month with 10% down for up to 96 months; want me to run exact numbers for that bike?";
const sentAug01 =
  "Seth, the 2026 Road Glide you’re looking at qualifies for the touring extended terms — it can be financed from $406/month with 10% down for 96 months; want me to run numbers for your exact build?";

const repeatScore = cadenceTokenOverlapScore(sentJul21, sentAug01);
assert.ok(
  Math.abs(repeatScore - 0.772727) < 0.0005,
  `the pinned production repeat must score 0.7727 (got ${repeatScore.toFixed(6)}) — a change here means the tokenizer moved`
);
assert.ok(
  repeatScore < CADENCE_NEAR_DUPLICATE_OVERLAP_MIN,
  "documented gap: the pinned production repeat sits BELOW the overlap threshold"
);
assert.equal(
  isCadenceNearDuplicateText(sentJul21, sentAug01),
  false,
  "documented gap: token overlap alone does not catch this reworded repeat — closing it needs a semantic judgement, not a lower threshold"
);

// Legitimate follow-ups to the SAME lead about the SAME bike. A future semantic guard must keep
// every one of these sendable; they are the negative controls that make the gap band safe.
const legitimateFollowUps: Array<[string, string]> = [
  [
    "price drop",
    "Seth, price drop on the 2026 Road Glide you looked at — it just came down to $27,499. Want me to hold it for a look this week?"
  ],
  [
    "new arrival",
    "Seth, a 2026 Road Glide just landed in Vivid Black. Want me to send photos before it goes out on the floor?"
  ],
  [
    "customer cash",
    "Seth, Harley just added $1,500 customer cash on the 2026 Road Glide through the end of the month. Want the details?"
  ],
  [
    "trade appraisal invite",
    "Seth, whenever you're ready I can line up a quick appraisal on your 2018 Street Glide S. What day works?"
  ]
];

for (const [label, text] of legitimateFollowUps) {
  const score = cadenceTokenOverlapScore(sentAug01, text);
  assert.ok(
    score < 0.5,
    `${label} is a genuinely new reason and must stay well clear of the repeat band (scored ${score.toFixed(3)})`
  );
  assert.equal(
    isCadenceNearDuplicateText(sentAug01, text),
    false,
    `${label} must never be suppressed as a repeat`
  );
}

// The extraction is only safe if index.ts consumes the shared module rather than a private copy.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  apiSource,
  /from "\.\/domain\/cadenceRepeatSimilarity\.js"/,
  "index.ts must import the shared cadence similarity math, not redeclare it"
);
assert.doesNotMatch(
  apiSource,
  /const CADENCE_SIMILARITY_STOP_WORDS = new Set\(\[/,
  "the cadence similarity stop-word list must live in exactly one place"
);
assert.match(apiSource, /let followUpsRunning = false;/, "follow-up scheduler needs an overlap lock");
assert.match(
  apiSource,
  /if \(followUpsRunning\) \{[\s\S]*?skipped overlapping run[\s\S]*?return;/,
  "overlapping follow-up runs must be skipped"
);
assert.match(
  apiSource,
  /function isInventoryUnavailableCadenceText\([\s\S]*?check inventory[\s\S]*?choose another bike[\s\S]*?similar options/,
  "inventory unavailable cadence text classifier must remain present"
);
assert.match(
  apiSource,
  /nearDuplicate\?: boolean;/,
  "recent outbound duplicate guard must expose nearDuplicate option"
);
assert.match(
  apiSource,
  /providers: \["draft_ai"\],[\s\S]*?windowMs: 2 \* 60 \* 1000,[\s\S]*?nearDuplicate: true/,
  "suggest-mode follow-up drafts must use near-duplicate suppression"
);
assert.match(
  apiSource,
  /providers: isPostSale \? \["human", "twilio"\] : \["human", "twilio", "draft_ai"\],[\s\S]*?nearDuplicate: true/,
  "SMS fallback follow-up sends must suppress recent near-duplicate drafts"
);

console.log("followup_duplicate_guard_eval passed");
