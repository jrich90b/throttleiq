/**
 * cadence_advance:eval — ONE referee for "the chase just took a rung; what does that write, and does
 * the ladder end here?"
 *
 * WHAT WAS UNOWNED. `advanceFollowUpCadence` (conversationStore) was the last unrefereed writer of
 * `followUpCadence` carrying real logic, and every rule it applied lived only inside its own body:
 * which of six ladders this chase climbs, whether this rung counts as a touch, and whether the
 * ladder ends here by either of two completely different routes.
 *
 * THE PRE-INCREMENT RULE IS THE LOAD-BEARING ONE, and until now it lived in a comment. The
 * disengagement taper is judged on the touch count BEFORE this one — the same number
 * `shouldSendDisengagedCloseout` is asked — so the rung that SENDS the goodbye is exactly the rung
 * that ends the ladder. Compare the post-increment count instead and the sequence ends one touch
 * early: the lead is retired without ever being said goodbye to. Section 3 is that rule as an
 * executable table.
 *
 * SILENT RUNGS. Four gates advance the schedule while sending nothing (cadence-quality suppress, the
 * value gate and its repeat backstop, the past-dated-event guard). A silent rung still BURNS — we
 * tried it and had nothing worth saying — but it must not stamp `lastSentAt`/`lastSentStep` as
 * though a customer heard from us, and it must not spend a touch against the taper. The one
 * exception is `endSequence`: when the rung being held IS the close-out, the decision to stop
 * chasing was already taken on the delivered count and only the goodbye got withheld.
 *
 * FAIL DIRECTION. Ending a ladder sends FEWER messages, so it is the safe direction — except for the
 * close-out itself, which is the message that ends things politely. Hence only a delivered touch (or
 * an explicit `endSequence`) may trip the taper. An unrecognized kind falls back to the STANDARD
 * ramp rather than completing, because completing on a shape we did not recognise would silently
 * drop the chase.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/cadence_advance_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `cadence-advance-eval-${Date.now()}.json`);

const { decideCadenceAdvance } = await import("../services/api/src/domain/routeStateReducer.ts");
const store = await import("../services/api/src/domain/conversationStore.ts");
const { buildDecisionRegistry } = await import(
  "../services/api/src/domain/decisionFingerprint.ts"
);

const {
  advanceFollowUpCadence,
  DISENGAGED_TAPER_AFTER_TOUCHES,
  CADENCE_LADDER_DAY_OFFSETS,
  FOLLOW_UP_DAY_OFFSETS,
  POST_SALE_DAY_OFFSETS,
  LONG_TERM_DAY_OFFSETS,
  FINANCE_DECLINED_DAY_OFFSETS,
  PRIVATE_PARTY_SELL_DAY_OFFSETS,
  ENGAGED_DAY_OFFSETS
} = store as any;

let checks = 0;
const ok = (condition: boolean, message: string) => {
  checks += 1;
  assert.ok(condition, message);
};
const eq = (actual: unknown, expected: unknown, message: string) => {
  checks += 1;
  assert.deepEqual(actual, expected, message);
};

const TAPER = DISENGAGED_TAPER_AFTER_TOUCHES;
const base = (over: Record<string, unknown> = {}) => ({
  kind: "standard",
  stepIndex: 0,
  deliveredTouchesBefore: 0,
  taperAfterTouches: TAPER,
  ...over
});

// ---------------------------------------------------------------------------------------------
// 1. THE LADDER TABLE — six shapes behind four `kind` values, because two of them are picked off
//    the follow-up REASON and a context tag rather than the kind. This is the original inline
//    ternary chain re-encoded, so a later edit that collapses two ladders together fails here.
// ---------------------------------------------------------------------------------------------
const LADDER_RULES: Array<{ input: Record<string, unknown>; ladder: string; postSaleDueAt: boolean }> = [
  { input: { kind: "post_sale" }, ladder: "post_sale", postSaleDueAt: true },
  { input: { kind: "engaged" }, ladder: "engaged", postSaleDueAt: false },
  {
    input: { kind: "long_term", followUpReason: "financing_declined" },
    ladder: "finance_declined_long_term",
    postSaleDueAt: false
  },
  {
    input: { kind: "long_term", followUpReason: "private_party_seller" },
    ladder: "private_party_sell_long_term",
    postSaleDueAt: false
  },
  {
    // the SECOND way that ladder identifies itself — a context tag, not the reason
    input: { kind: "long_term", contextTag: "private_party_seller" },
    ladder: "private_party_sell_long_term",
    postSaleDueAt: false
  },
  { input: { kind: "long_term" }, ladder: "long_term", postSaleDueAt: false },
  { input: { kind: "long_term", followUpReason: "some_other_reason" }, ladder: "long_term", postSaleDueAt: false },
  { input: {}, ladder: "standard", postSaleDueAt: false },
  // FAIL DIRECTION: a kind nobody recognises climbs the standard ramp rather than completing.
  { input: { kind: "not_a_kind" }, ladder: "standard", postSaleDueAt: false },
  { input: { kind: null }, ladder: "standard", postSaleDueAt: false }
];

for (const rule of LADDER_RULES) {
  const d = decideCadenceAdvance(base(rule.input) as any);
  eq(d.ladder, rule.ladder, `${JSON.stringify(rule.input)}: climbs the ${rule.ladder} ladder`);
  eq(
    d.usesPostSaleDueAt,
    rule.postSaleDueAt,
    `${JSON.stringify(rule.input)}: post-sale due dates use their own clock maths`
  );
  eq(d.endNow, null, `${JSON.stringify(rule.input)}: an ordinary rung does not end the ladder`);
}

// The referee's ladder keys and the store's day-offset tables must line up exactly — a key with no
// table is a crash on a live chase, and a table nobody names is a ladder nothing can climb.
{
  const keys = Object.keys(CADENCE_LADDER_DAY_OFFSETS).sort();
  eq(
    keys,
    [
      "engaged",
      "finance_declined_long_term",
      "long_term",
      "post_sale",
      "private_party_sell_long_term",
      "standard"
    ],
    "every ladder the referee can name has a day-offset table behind it"
  );
  eq(CADENCE_LADDER_DAY_OFFSETS.standard, FOLLOW_UP_DAY_OFFSETS, "standard ramp table unchanged");
  eq(CADENCE_LADDER_DAY_OFFSETS.engaged, ENGAGED_DAY_OFFSETS, "engaged table unchanged");
  eq(CADENCE_LADDER_DAY_OFFSETS.post_sale, POST_SALE_DAY_OFFSETS, "post-sale table unchanged");
  eq(CADENCE_LADDER_DAY_OFFSETS.long_term, LONG_TERM_DAY_OFFSETS, "long-term table unchanged");
  eq(
    CADENCE_LADDER_DAY_OFFSETS.finance_declined_long_term,
    FINANCE_DECLINED_DAY_OFFSETS,
    "finance-declined table unchanged"
  );
  eq(
    CADENCE_LADDER_DAY_OFFSETS.private_party_sell_long_term,
    PRIVATE_PARTY_SELL_DAY_OFFSETS,
    "private-party-sell table unchanged"
  );
}

// ---------------------------------------------------------------------------------------------
// 2. SILENT RUNGS BURN BUT DO NOT COUNT. The rung always moves; the delivery stamps do not.
// ---------------------------------------------------------------------------------------------
for (const stepIndex of [0, 3, 8]) {
  const loud = decideCadenceAdvance(base({ stepIndex, delivered: true }) as any);
  const silent = decideCadenceAdvance(base({ stepIndex, delivered: false }) as any);
  eq(loud.nextStepIndex, stepIndex + 1, `a delivered rung moves ${stepIndex} -> ${stepIndex + 1}`);
  eq(
    silent.nextStepIndex,
    stepIndex + 1,
    `a SILENT rung still burns: ${stepIndex} -> ${stepIndex + 1}`
  );
  ok(loud.stampDelivered === true, "a delivered rung stamps the send marks");
  ok(silent.stampDelivered === false, "a silent rung must not claim a customer heard from us");
}
{
  // `delivered` defaults TRUE — every send path keeps its behaviour without passing the flag.
  const d = decideCadenceAdvance(base() as any);
  ok(d.stampDelivered === true, "delivered defaults to true, so no send path changed behaviour");
}

// ---------------------------------------------------------------------------------------------
// 3. THE PRE-INCREMENT TAPER RULE, as a table. The boundary is the whole point: at exactly the
//    threshold the ladder ENDS, and the rung that ends it is the one that sent the goodbye.
// ---------------------------------------------------------------------------------------------
const TAPER_RULES: Array<{
  deliveredBefore: number;
  kind: string;
  delivered: boolean;
  endSequence?: boolean;
  customerEngaged?: boolean;
  ends: boolean;
  note: string;
}> = [
  { deliveredBefore: TAPER - 1, kind: "standard", delivered: true, ends: false, note: "one touch short of the threshold keeps climbing" },
  { deliveredBefore: TAPER, kind: "standard", delivered: true, ends: true, note: "AT the threshold the ladder ends — this rung carried the close-out" },
  { deliveredBefore: TAPER + 3, kind: "standard", delivered: true, ends: true, note: "past the threshold ends too" },
  { deliveredBefore: TAPER, kind: "engaged", delivered: true, ends: true, note: "an `engaged`-KIND chase is still a sales chase and still tapers" },
  { deliveredBefore: TAPER, kind: "standard", delivered: true, customerEngaged: true, ends: false, note: "a lead who REPLIED is never tapered away" },
  { deliveredBefore: TAPER, kind: "post_sale", delivered: true, ends: false, note: "a post-sale chase is a dated check-back, not a chase to give up on" },
  { deliveredBefore: TAPER, kind: "long_term", delivered: true, ends: false, note: "nor is a long-term one" },
  { deliveredBefore: TAPER, kind: "standard", delivered: false, ends: false, note: "a SILENT rung must not end the ladder — that retires a lead with no goodbye" },
  { deliveredBefore: TAPER, kind: "standard", delivered: false, endSequence: true, ends: true, note: "...unless the caller says the close-out itself was withheld" }
];

for (const rule of TAPER_RULES) {
  const d = decideCadenceAdvance(
    base({
      kind: rule.kind,
      stepIndex: 4,
      deliveredTouchesBefore: rule.deliveredBefore,
      delivered: rule.delivered,
      endSequence: rule.endSequence,
      customerEngaged: rule.customerEngaged
    }) as any
  );
  eq(Boolean(d.endNow), rule.ends, rule.note);
  if (rule.ends) {
    eq(d.endNow?.cause, "disengaged_taper", `${rule.note} — and it ends for the taper reason`);
    eq(d.endNow?.stopReason, "disengaged_taper", `${rule.note} — recording why we gave up`);
  }
}

// ---------------------------------------------------------------------------------------------
// 4. THE RIDE-CHALLENGE ONE-SHOT ends the chase and deliberately records NO stopReason: nothing
//    gave up on this lead, the message simply had one job. Long-term only, and the taper wins if
//    both somehow apply — the original ordering, preserved.
// ---------------------------------------------------------------------------------------------
{
  const d = decideCadenceAdvance(
    base({ kind: "long_term", deferredMessage: "ride_challenge_final_mileage" }) as any
  );
  eq(d.endNow?.cause, "ride_challenge_final_mileage", "the one-shot completes as soon as it fires");
  eq(d.endNow?.stopReason, null, "and records no stopReason — nobody gave up on this lead");
}
{
  const notLongTerm = decideCadenceAdvance(
    base({ kind: "standard", deferredMessage: "ride_challenge_final_mileage" }) as any
  );
  eq(notLongTerm.endNow, null, "the one-shot rule is long-term only — other kinds climb on");
}
{
  // Both apply: the taper is checked FIRST, so the stopReason survives. Preserving the original
  // ordering matters — the other way round loses the record of why the chase stopped.
  const both = decideCadenceAdvance(
    base({
      kind: "standard",
      deliveredTouchesBefore: TAPER,
      delivered: true,
      deferredMessage: "ride_challenge_final_mileage"
    }) as any
  );
  eq(both.endNow?.cause, "disengaged_taper", "the taper is judged first, exactly as it always was");
}

// ---------------------------------------------------------------------------------------------
// 5. SHAPE, not just rules — the junk-input pass. A referee's shape is where a fresh one actually
//    goes wrong. A missing or nonsense touch count must read as ZERO touches, never as "past the
//    threshold", or a brand-new lead is tapered away on its first rung.
// ---------------------------------------------------------------------------------------------
for (const junk of [undefined, null, NaN, -4, "", "seven", {}] as any[]) {
  const d = decideCadenceAdvance(
    base({ deliveredTouchesBefore: junk, delivered: true, stepIndex: 0 }) as any
  );
  eq(
    d.endNow,
    null,
    `a touch count of ${String(junk)} must read as zero — a junk value may never taper a lead away`
  );
  eq(d.deliveredTouchesAfter, 1, `...and the first delivered touch counts as one`);
}
for (const junk of [undefined, null, NaN, "", "three"] as any[]) {
  const d = decideCadenceAdvance(base({ stepIndex: junk }) as any);
  eq(d.nextStepIndex, 1, `a step index of ${String(junk)} reads as rung 0, so the chase moves to 1`);
}

// ---------------------------------------------------------------------------------------------
// 6. PURITY — same inputs, same decision. The equivalence harness that lets this ship without a
//    human reading the diff is measuring nothing otherwise.
// ---------------------------------------------------------------------------------------------
for (const kind of ["standard", "engaged", "post_sale", "long_term"]) {
  for (const delivered of [true, false]) {
    const a = decideCadenceAdvance(base({ kind, delivered, stepIndex: 2 }) as any);
    const b = decideCadenceAdvance(base({ kind, delivered, stepIndex: 2 }) as any);
    eq(a, b, `${kind}/${delivered}: the referee is pure`);
    ok(typeof a.why === "string" && a.why.length > 0, `${kind}/${delivered}: it explains itself`);
  }
}

// ---------------------------------------------------------------------------------------------
// 7. THE STORE ACTUALLY APPLIES WHAT THE REFEREE DECIDED — against real conversation objects,
//    which is the only thing that catches `advanceFollowUpCadence` being unwired from it.
// ---------------------------------------------------------------------------------------------
const TZ = "America/New_York";
const lead = (cadence: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({
    id: "conv_adv",
    leadKey: "+15550000009",
    messages: [],
    followUpCadence: { status: "active", anchorAt: "2026-08-01T12:00:00.000Z", ...cadence },
    ...over
  }) as any;

{
  // An ordinary delivered rung: the marks land, the rung moves, a due date is computed.
  const conv = lead({ kind: "standard", stepIndex: 0, deliveredTouches: 0 });
  advanceFollowUpCadence(conv, TZ);
  eq(conv.followUpCadence.stepIndex, 1, "store: the rung moved");
  eq(conv.followUpCadence.lastSentStep, 0, "store: lastSentStep records the rung we just sent");
  eq(conv.followUpCadence.deliveredTouches, 1, "store: the touch is counted");
  ok(!!conv.followUpCadence.lastSentAt, "store: the send is timestamped");
  ok(!!conv.followUpCadence.nextDueAt, "store: the next touch is scheduled");
  eq(conv.followUpCadence.status, "active", "store: the chase is still running");
}
{
  // A SILENT rung: the schedule moves, the send marks do not.
  const conv = lead({ kind: "standard", stepIndex: 2, deliveredTouches: 2, lastSentStep: 1 });
  advanceFollowUpCadence(conv, TZ, { delivered: false });
  eq(conv.followUpCadence.stepIndex, 3, "store: a silent rung still burns");
  eq(conv.followUpCadence.lastSentStep, 1, "store: ...but lastSentStep is untouched");
  eq(conv.followUpCadence.deliveredTouches, 2, "store: ...and the touch count is unspent");
}
{
  // The taper: at the threshold the chase completes and records why.
  const conv = lead({ kind: "standard", stepIndex: 5, deliveredTouches: TAPER });
  advanceFollowUpCadence(conv, TZ);
  eq(conv.followUpCadence.status, "completed", "store: the ladder ends at the give-up threshold");
  eq(conv.followUpCadence.stopReason, "disengaged_taper", "store: and records why");
  eq(conv.followUpCadence.nextDueAt, undefined, "store: nothing further is scheduled");
}
{
  // LEGACY RECORDS: written before `deliveredTouches` existed, they fall back to lastSentStep + 1 —
  // exactly the number the taper used to read — so an in-flight chase keeps its position and this
  // can never RE-open a ladder into extra messaging.
  const conv = lead({ kind: "standard", stepIndex: 9, lastSentStep: TAPER - 1 });
  advanceFollowUpCadence(conv, TZ);
  eq(
    conv.followUpCadence.status,
    "completed",
    "store: a legacy record with no deliveredTouches still tapers on lastSentStep + 1"
  );
}
{
  // The ride-challenge one-shot: completed, and no stopReason invented.
  const conv = lead({
    kind: "long_term",
    stepIndex: 0,
    deliveredTouches: 0,
    deferredMessage: "ride_challenge_final_mileage"
  });
  advanceFollowUpCadence(conv, TZ);
  eq(conv.followUpCadence.status, "completed", "store: the one-shot completes");
  eq(conv.followUpCadence.stopReason, undefined, "store: and invents no stopReason");
}
{
  // Running off the end of a ladder completes without a taper reason.
  const conv = lead({
    kind: "long_term",
    stepIndex: LONG_TERM_DAY_OFFSETS.length - 1,
    deliveredTouches: 0
  });
  advanceFollowUpCadence(conv, TZ);
  eq(conv.followUpCadence.status, "completed", "store: the last rung of a ladder completes it");
  eq(conv.followUpCadence.stopReason, undefined, "store: reaching the end is not giving up");
}
{
  // A chase that is not active is not advanced at all.
  const conv = lead({ kind: "standard", stepIndex: 1, status: "stopped" });
  advanceFollowUpCadence(conv, TZ);
  eq(conv.followUpCadence.stepIndex, 1, "store: a stopped chase does not move");
}

// ---------------------------------------------------------------------------------------------
// 8. REGISTERED WITH THE EQUIVALENCE HARNESS — a referee nobody fingerprints ships with no
//    evidence behind its "IDENTICAL" verdict.
// ---------------------------------------------------------------------------------------------
{
  const registry = buildDecisionRegistry();
  const entries = Array.isArray(registry) ? registry : Object.values(registry ?? {});
  const names = new Set(entries.map((entry: any) => String(entry?.name ?? entry?.key ?? entry)));
  for (const suffix of ["delivered", "silent"]) {
    ok(
      names.has(`cadenceAdvance:${suffix}`),
      `the registry samples cadenceAdvance:${suffix} — both halves, because the delivered flag is ` +
        "the input that decides whether a rung counts against the taper"
    );
  }
  ok(
    entries.some((entry: any) => (entry.covers ?? []).includes("decideCadenceAdvance")),
    "the registry declares that it covers decideCadenceAdvance"
  );
}

// ---------------------------------------------------------------------------------------------
// 9. NOBODY BURNS A RUNG BEHIND THE REFEREE'S BACK.
//
// Asked of the contention analyzer directly rather than through the ratchet total, which can cancel
// a +1 against a -1 (measured three times on this program). `followUpCadence` must carry no
// unrefereed writer inside conversationStore at all: every one of them now sits downstream of a
// referee.
// ---------------------------------------------------------------------------------------------
{
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const { rankContention } = await import(
    "../services/api/src/domain/stateWriterContention.ts"
  );
  const root = nodePath.resolve("services/api/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: nodePath.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  const cadence: any = rankContention(files as any, { minRawWrites: 1 }).find(
    (entry: any) => entry.field === "followUpCadence"
  );
  // Assert the analyzer can still SEE the field first, or this section is vacuous while green.
  ok(
    (cadence?.writeSites ?? []).length > 0,
    "the contention analyzer must still see raw writes of `followUpCadence`"
  );
  const storeSites = (cadence?.unrefereedWriterSites ?? []).filter((site: any) =>
    String(site.file ?? "").endsWith("conversationStore.ts")
  );
  ok(
    storeSites.length === 0,
    "a place inside conversationStore writes the follow-up chase without asking a referee — route " +
      "it through one. Offending site(s): " +
      storeSites.map((site: any) => `${site.file}:${site.line}`).join(", ")
  );
}

console.log(
  `PASS cadence advance — one referee for burning a rung of the chase ` +
    `(${checks} checks; six ladders, the silent-rung rule and the PRE-increment taper pinned)`
);
