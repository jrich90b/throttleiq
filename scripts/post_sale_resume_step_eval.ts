/**
 * post_sale_resume_step:eval — a post-sale cadence rebuilt long after the sale must RESUME,
 * not replay the day-1 note the customer already got.
 *
 * THE PRODUCTION SEND. Ken Hardy (+17166795683), lead ref 11108, bought a 2025 Harley-Davidson
 * Tri Glide Ultra on 2026-06-15T14:54:46.102Z. He got the day-1 owner note on 2026-06-16, and
 * then this went out AGAIN on 2026-08-12T14:30:22.724Z, verbatim, 57 days after the sale:
 *
 *   "Hi Ken — this is Scott at American Harley-Davidson. Thanks again for coming to see us for
 *    your Tri Glide Ultra. If you need anything, just let me know."
 *
 * It is the release gate's `repeats 1 > 0` failure for 2026-08-13, and the voice charter's single
 * `verbatim_repeat` violation for that window.
 *
 * WHY IT FIRED, and why "the date is in the past" is the wrong thing to check. The two
 * sold -> post_sale reconciles in the cadence maintenance tick rebuild the record at
 * `stepIndex: 0` anchored to `sale.soldAt`. `computePostSaleDueAt` NEVER hands back a past
 * date — it walks an elapsed offset forward a day at a time until it clears "now" — so the
 * elapsed day-1 touch does not get skipped, it comes due TODAY and the same tick sends it.
 * The rebuilt record still read `deliveredTouches: 1` after that send, because the object was
 * brand new and carried no memory of June's. A guard written as "don't send if nextDueAt is in
 * the past" would therefore never have fired. The position has to be derived from DAYS ELAPSED
 * since the anchor, which is what `resolvePostSaleResumeStep` does.
 *
 * Deterministic — the clock is injected, no network, no LLM.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  POST_SALE_DAY_OFFSETS,
  buildPostSaleReconcileCadence,
  computePostSaleDueAt,
  resolvePostSaleResumeStep
} from "../services/api/src/domain/conversationStore.ts";

const TZ = "America/New_York";

/** Verbatim from the live store, conversation +17166795683. */
const KEN_SOLD_AT = "2026-06-15T14:54:46.102Z";
/** The moment the rebuilt cadence sent the duplicate. */
const KEN_REPEAT_AT = Date.parse("2026-08-12T14:30:22.724Z");

// ---------------------------------------------------------------------------
// 1) The ladder this rides on. If these offsets change, every expectation below
//    is measuring something else and must be re-derived from the new ladder.
// ---------------------------------------------------------------------------
assert.deepEqual(
  [...POST_SALE_DAY_OFFSETS],
  [1, 60, 365, 690],
  "post-sale ladder is day 1 / 60 / 365 / 690"
);

// ---------------------------------------------------------------------------
// 2) KEN'S EXACT RECORD. 57 days elapsed, so day 1 is behind him and day 60 is
//    not: resume at step 1, due 2026-08-14 — precisely the state his cadence
//    held before it was rebuilt. Step 0 here is the duplicate text.
// ---------------------------------------------------------------------------
const ken = resolvePostSaleResumeStep(KEN_SOLD_AT, KEN_REPEAT_AT, TZ);
assert.ok(ken, "Ken's sale still has an owner touch ahead of it");
assert.equal(ken.stepIndex, 1, "Ken resumes at the day-60 step, not the day-1 step he already got");
assert.equal(
  ken.nextDueAt.slice(0, 10),
  "2026-08-14",
  "Ken's next owner touch is the day-60 one on 2026-08-14"
);
assert.notEqual(
  ken.stepIndex,
  0,
  "step 0 on a 57-day-old sale IS the duplicate send — this is the whole bug"
);

// ---------------------------------------------------------------------------
// 3) A SALE THAT JUST CLOSED IS UNCHANGED. The fix must not disturb the normal
//    path: 0 days elapsed, day 1 still ahead, step 0 due tomorrow.
// ---------------------------------------------------------------------------
const freshNow = Date.parse("2026-08-13T15:00:00.000Z");
const fresh = resolvePostSaleResumeStep("2026-08-13T14:00:00.000Z", freshNow, TZ);
assert.ok(fresh, "a sale closed today arms the sequence");
assert.equal(fresh.stepIndex, 0, "a fresh sale still starts at the day-1 step");
assert.equal(
  fresh.nextDueAt,
  computePostSaleDueAt("2026-08-13T14:00:00.000Z", POST_SALE_DAY_OFFSETS[0], TZ),
  "a fresh sale's due date is unchanged from the pre-fix computation"
);

// ---------------------------------------------------------------------------
// 4) BOUNDARIES. Exactly on the offset day the touch is spent (it fired that
//    morning); the day before, it is still ahead.
// ---------------------------------------------------------------------------
const dayMs = 86_400_000;
const anchorMs = Date.parse(KEN_SOLD_AT);
assert.equal(
  resolvePostSaleResumeStep(KEN_SOLD_AT, anchorMs + 59 * dayMs, TZ)?.stepIndex,
  1,
  "59 days out, the day-60 touch is still ahead"
);
assert.equal(
  resolvePostSaleResumeStep(KEN_SOLD_AT, anchorMs + 60 * dayMs, TZ)?.stepIndex,
  2,
  "on day 60 the day-60 touch is spent — resume at day 365, never replay it"
);
assert.equal(
  resolvePostSaleResumeStep(KEN_SOLD_AT, anchorMs + 400 * dayMs, TZ)?.stepIndex,
  3,
  "400 days out, only the day-690 touch is left"
);

// ---------------------------------------------------------------------------
// 5) SEQUENCE FULLY ELAPSED => null. There is no touch left, and inventing one
//    is the same defect one step later.
// ---------------------------------------------------------------------------
assert.equal(
  resolvePostSaleResumeStep(KEN_SOLD_AT, anchorMs + 700 * dayMs, TZ),
  null,
  "past the last offset there is nothing left to schedule"
);

// ---------------------------------------------------------------------------
// 6) FAIL DIRECTION. Unusable input returns null (silence), never step 0.
// ---------------------------------------------------------------------------
assert.equal(resolvePostSaleResumeStep("", KEN_REPEAT_AT, TZ), null, "no anchor => no touch");
assert.equal(
  resolvePostSaleResumeStep("not-a-date", KEN_REPEAT_AT, TZ),
  null,
  "an unparseable anchor => no touch"
);
assert.equal(
  resolvePostSaleResumeStep(KEN_SOLD_AT, Number.NaN, TZ),
  null,
  "no usable clock => no touch"
);

// ---------------------------------------------------------------------------
// 7) THE RESOLVER IS ACTUALLY WIRED INTO BOTH RECONCILES. Source-text pins only,
//    but they are the trap this file exists to catch: the resolver can be perfect
//    and the tick can still rebuild at `stepIndex: 0` beside it, and every
//    behavioural assertion above would stay green while Ken gets a third text.
// ---------------------------------------------------------------------------
const indexSrc = readFileSync(
  new URL("../services/api/src/index.ts", import.meta.url),
  "utf8"
);
const reconcileCalls =
  indexSrc.match(/buildPostSaleReconcileCadence\(anchor, Date\.now\(\), cfg\.timezone, (?:true|false)\)/g) ?? [];
assert.equal(
  reconcileCalls.length,
  2,
  "both sold -> post_sale reconciles ask the resolver (found " + reconcileCalls.length + ")"
);

// The builder both reconciles now call must itself go through the resolver — otherwise the
// indirection above is satisfied by a function that still hardcodes step 0.
const storeSrc = readFileSync(
  new URL("../services/api/src/domain/conversationStore.ts", import.meta.url),
  "utf8"
);
assert.equal(
  /export function buildPostSaleReconcileCadence[\s\S]{0,700}?resolvePostSaleResumeStep\(/.test(storeSrc),
  true,
  "buildPostSaleReconcileCadence derives its step from resolvePostSaleResumeStep"
);

// And the builder actually returns Ken's resumed position, not step 0, on his real record.
const kenRebuilt = buildPostSaleReconcileCadence(KEN_SOLD_AT, KEN_REPEAT_AT, TZ, true);
assert.equal(kenRebuilt?.stepIndex, 1, "the rebuilt record puts Ken at the day-60 step");
assert.equal(kenRebuilt?.scheduleInviteCount, 0, "the first reconcile still seeds the invite counters");
assert.equal(
  buildPostSaleReconcileCadence(KEN_SOLD_AT, KEN_REPEAT_AT, TZ, false)?.scheduleInviteCount,
  undefined,
  "the second reconcile still omits them"
);
assert.equal(
  buildPostSaleReconcileCadence(KEN_SOLD_AT, anchorMs + 700 * dayMs, TZ, true),
  null,
  "a fully elapsed sequence rebuilds nothing"
);
assert.equal(
  /nextDueAt: computePostSaleDueAt\(anchor, POST_SALE_DAY_OFFSETS\[0\], cfg\.timezone\)/.test(indexSrc),
  false,
  "no reconcile rebuilds the post-sale cadence at the day-1 offset any more"
);

console.log("post_sale_resume_step:eval PASS");
