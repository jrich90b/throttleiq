/**
 * Dept-widget bike-vs-department clarify eval (Joe ruling 2026-07-26 #4).
 *
 * A web-text-widget lead can arrive tagged to a NON-SALES department (Motor Clothes / Parts /
 * Service) yet actually be asking about a MOTORCYCLE — James Brown (+15415147201) came through the
 * "Motor Clothes" widget with "Checking out Pan America HD". The old first-touch gave the pure
 * apparel handoff ack (staying apparel-only) and a later draft pivoted straight to sales. Joe ruled:
 * CLARIFY (bike vs department) and let staff route.
 *
 * Pins: the pure decision (parser verdict → clarify or plain-ack), the approved clarify template
 * (offers BOTH sides, no fabricated price, no reply-time promise), the cost hint, the parser kill
 * switch + LLM-off fail-safe (deterministic), the index.ts wiring in ALL THREE sites (widget arrival
 * + live-twilio dept block + regen dept block, two-path parity), the ci:eval wiring, and — when a
 * key is present — LLM coverage on James's exact case plus the apparel-gear negative.
 *
 * Run: npx tsx scripts/dept_widget_bike_clarify_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  classifyDeptWidgetBikeInterestWithLLM,
  parseCustomerDispositionWithLLM
} from "../services/api/src/domain/llmDraft.ts";
import {
  hasDeptWidgetBikeHint,
  buildDeptBikeClarifyReply,
  buildDeptWidgetAcquisitionReply,
  decideDeptWidgetBikeClarify,
  DEPT_WIDGET_BIKE_CLARIFY_CONFIDENCE_MIN
} from "../services/api/src/domain/webWidgetDeptBikeClarify.ts";
import {
  decideDeptWidgetIntakeTurn,
  type DeptWidgetIntakeTurnKind
} from "../services/api/src/domain/routeStateReducer.ts";

// A reply-time promise is unsafe (widget forms arrive after hours / holidays) — the clarify must
// never make one, same rule the dept-handoff ack lives under.
const IMMEDIATE_REPLY_PROMISE_RE =
  /right (?:back|away)|straight back|momentarily|immediately|within (?:the hour|minutes|a few minutes)|shortly|very soon|asap|right now/i;

// --- Cost hint (cheap gate; parser owns the verdict) ---
assert.equal(
  hasDeptWidgetBikeHint("Checking out Pan America HD"),
  true,
  "hint fires on a named bike (James Brown's exact message)"
);
assert.equal(hasDeptWidgetBikeHint("Do you have XL riding gloves in stock"), true, "hint fires on 'in stock'");
assert.equal(hasDeptWidgetBikeHint("Looking for a black hoodie size L"), false, "hint quiet on a pure apparel ask");
assert.equal(hasDeptWidgetBikeHint("   "), false, "hint quiet on empty");

// --- Approved clarify template: offers BOTH sides, no fabricated price, no reply-time promise ---
{
  const withRef = buildDeptBikeClarifyReply({
    firstName: "James",
    deptLabel: "Motor Clothes",
    motorcycleReference: "Pan America"
  });
  assert.match(withRef, /James/, "clarify greets by first name");
  assert.match(withRef, /Pan America/, "clarify names the bike the customer referenced");
  assert.match(withRef, /sales team/i, "clarify offers the bike/sales side");
  assert.match(withRef, /Motor Clothes/i, "clarify offers the department side");
  assert.doesNotMatch(withRef, /\$\s?\d/, "clarify contains no fabricated price");
  assert.doesNotMatch(withRef, IMMEDIATE_REPLY_PROMISE_RE, `clarify promises no reply time: ${withRef}`);

  const noRef = buildDeptBikeClarifyReply({ firstName: "", deptLabel: "", motorcycleReference: null });
  assert.match(noRef, /Hi there/, "clarify degrades gracefully with no name");
  assert.match(noRef, /a motorcycle/, "clarify degrades gracefully with no bike reference");
}

// --- Pure decision: verdict in → clarify or null (deterministic) ---
{
  // asksAboutMotorcycle + confident => clarify.
  const yes = decideDeptWidgetBikeClarify({
    parse: { asksAboutMotorcycle: true, motorcycleReference: "Pan America", confidence: 0.9 },
    firstName: "James",
    deptLabel: "Motor Clothes"
  });
  assert.ok(yes && /Pan America/.test(yes), "confident motorcycle verdict yields a clarify reply");

  // asksAboutMotorcycle=false => keep the plain ack (null).
  assert.equal(
    decideDeptWidgetBikeClarify({
      parse: { asksAboutMotorcycle: false, motorcycleReference: null, confidence: 0.95 },
      deptLabel: "Motor Clothes"
    }),
    null,
    "a non-motorcycle verdict keeps the plain dept ack"
  );

  // Low confidence => keep the plain ack (null).
  assert.equal(
    decideDeptWidgetBikeClarify({
      parse: { asksAboutMotorcycle: true, motorcycleReference: "bike", confidence: DEPT_WIDGET_BIKE_CLARIFY_CONFIDENCE_MIN - 0.01 },
      deptLabel: "Parts"
    }),
    null,
    "below-threshold confidence keeps the plain dept ack"
  );

  // Null parse (LLM off / failed) => keep the plain ack (null). Fail-safe direction.
  assert.equal(decideDeptWidgetBikeClarify({ parse: null, deptLabel: "Parts" }), null, "null parse keeps the plain ack");
}

// --- Approved ACQUISITION template (Lynn Kraus +17164785613, corpus sweep 2026-07-28) ---
{
  const acq = buildDeptWidgetAcquisitionReply({
    firstName: "Lynn",
    motorcycleReference: "'17 Harley Road King Special (Olive Gold)"
  });
  assert.match(acq, /Lynn/, "acquisition reply greets by first name");
  assert.match(acq, /we do buy bikes/i, "acquisition reply ANSWERS the question she actually asked");
  assert.match(acq, /apprais/i, "acquisition reply moves to the in-person appraisal (the real next step)");
  assert.doesNotMatch(acq, /\$\s?\d/, "acquisition reply quotes no number — we have not appraised the bike");
  assert.doesNotMatch(
    acq,
    /\b(?:we(?:'|’)?ll|we will|we can) (?:buy|take) (?:it|your|the)\b/i,
    `acquisition reply never promises we WILL buy this bike (inventory levels are a human call): ${acq}`
  );
  assert.doesNotMatch(acq, IMMEDIATE_REPLY_PROMISE_RE, `acquisition reply promises no reply time: ${acq}`);
  assert.doesNotMatch(
    acq,
    /right person|gear\/support|which (?:team|department)/i,
    `acquisition reply must NOT ask which department she meant — that was the bug: ${acq}`
  );

  const noName = buildDeptWidgetAcquisitionReply({ firstName: "", motorcycleReference: null });
  assert.match(noName, /Hi there/, "acquisition reply degrades gracefully with no name");
  assert.match(noName, /your bike/, "acquisition reply degrades gracefully with no bike reference");
}

// --- Decision table: acquisition > clarify > plain ack (pure, no key needed) ---
{
  type Row = {
    id: string;
    asksAboutMotorcycle: boolean;
    bikeConfidence: number;
    sellToDealerInterest: boolean;
    disposition: string | null;
    dispositionConfidence: number | null;
    conversationClosed?: boolean;
    kind: DeptWidgetIntakeTurnKind;
  };
  const rows: Row[] = [
    // THE production turn (Lynn Kraus +17164785613, Motor Clothes widget, corpus sweep 2026-07-28):
    // "Do you guys buy motorcycles? I have a '17 Road King Special … looking to sell."
    {
      id: "lynn_kraus_acquisition_beats_clarify",
      asksAboutMotorcycle: true,
      bikeConfidence: 0.85,
      sellToDealerInterest: true,
      disposition: "none",
      dispositionConfidence: 0.98,
      kind: "sell_to_dealer_appraisal"
    },
    // REGRESSION GUARD — Joe ruling 2026-07-26 #4 (James Brown +15415147201) still clarifies.
    {
      id: "james_brown_bare_model_still_clarifies",
      asksAboutMotorcycle: true,
      bikeConfidence: 0.9,
      sellToDealerInterest: false,
      disposition: null,
      dispositionConfidence: null,
      kind: "bike_clarify"
    },
    // Below the acquisition floor → fail toward the status quo (clarify), never the new arm.
    {
      id: "low_confidence_acquisition_falls_back_to_clarify",
      asksAboutMotorcycle: true,
      bikeConfidence: 0.9,
      sellToDealerInterest: true,
      disposition: "none",
      dispositionConfidence: 0.6,
      kind: "bike_clarify"
    },
    // Conflict guard inherited from decideSellToDealerTurn: sell_on_own is the OPPOSITE intent.
    {
      id: "sell_on_own_never_takes_the_acquisition_arm",
      asksAboutMotorcycle: true,
      bikeConfidence: 0.9,
      sellToDealerInterest: true,
      disposition: "sell_on_own",
      dispositionConfidence: 0.95,
      kind: "bike_clarify"
    },
    // A closed/sold conversation never gets a new appraisal side effect.
    {
      id: "closed_conversation_never_takes_the_acquisition_arm",
      asksAboutMotorcycle: true,
      bikeConfidence: 0.9,
      sellToDealerInterest: true,
      disposition: "none",
      dispositionConfidence: 0.98,
      conversationClosed: true,
      kind: "bike_clarify"
    },
    // CONTAINMENT: the acquisition arm is a strict SUBSET of the clarify cohort — a pure gear ask
    // (asksAboutMotorcycle=false) can never reach it, no matter what the disposition parser says.
    {
      id: "gear_ask_never_reaches_the_acquisition_arm",
      asksAboutMotorcycle: false,
      bikeConfidence: 0.95,
      sellToDealerInterest: true,
      disposition: "none",
      dispositionConfidence: 0.99,
      kind: "plain_dept_ack"
    },
    // Below the clarify floor keeps the plain ack (unchanged pre-existing behavior).
    {
      id: "low_bike_confidence_keeps_plain_ack",
      asksAboutMotorcycle: true,
      bikeConfidence: DEPT_WIDGET_BIKE_CLARIFY_CONFIDENCE_MIN - 0.01,
      sellToDealerInterest: true,
      disposition: "none",
      dispositionConfidence: 0.99,
      kind: "plain_dept_ack"
    }
  ];
  for (const row of rows) {
    const got = decideDeptWidgetIntakeTurn({
      asksAboutMotorcycle: row.asksAboutMotorcycle,
      bikeConfidence: row.bikeConfidence,
      sellToDealerInterest: row.sellToDealerInterest,
      disposition: row.disposition,
      dispositionConfidence: row.dispositionConfidence,
      conversationClosed: row.conversationClosed
    });
    assert.equal(got.kind, row.kind, `dept-widget intake precedence [${row.id}]: expected ${row.kind}, got ${got.kind}`);
  }
}

// --- Parser kill switch + LLM-off fail-safe (deterministic, no key needed) ---
{
  const prev = process.env.LLM_DEPT_WIDGET_BIKE_INTEREST_ENABLED;
  process.env.LLM_DEPT_WIDGET_BIKE_INTEREST_ENABLED = "0";
  assert.equal(
    await classifyDeptWidgetBikeInterestWithLLM({ message: "Checking out Pan America HD", deptLabel: "Motor Clothes" }),
    null,
    "kill switch returns null (caller keeps plain ack)"
  );
  if (prev === undefined) delete process.env.LLM_DEPT_WIDGET_BIKE_INTEREST_ENABLED;
  else process.env.LLM_DEPT_WIDGET_BIKE_INTEREST_ENABLED = prev;
}
{
  const prev = process.env.LLM_ENABLED;
  process.env.LLM_ENABLED = "0";
  assert.equal(
    await classifyDeptWidgetBikeInterestWithLLM({ message: "Checking out Pan America HD", deptLabel: "Motor Clothes" }),
    null,
    "LLM off => null (fail-safe to plain ack)"
  );
  if (prev === undefined) delete process.env.LLM_ENABLED;
  else process.env.LLM_ENABLED = prev;
}

// --- Source guards: index.ts wires the clarify in all three sites (two-path parity) ---
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  indexSrc,
  /classifyDeptWidgetBikeInterestWithLLM/,
  "index.ts calls the bike-interest classifier"
);
assert.match(
  indexSrc,
  /web_text_widget_\$\{todoReason\}_bike_clarify_draft_created/,
  "the widget-arrival dept path emits the bike-clarify route outcome"
);
// The decision is CENTRALIZED in one shared helper (route-parity: no hand-mirrored per-path
// locals) that both paths call — 1 definition + 3 call sites (widget arrival + live-twilio + regen).
assert.match(
  indexSrc,
  /async function resolveDeptWidgetIntakeDecision\(/,
  "the dept-widget intake decision lives in one shared helper both paths call"
);
assert.ok(
  (indexSrc.match(/resolveDeptWidgetIntakeDecision\(/g) ?? []).length >= 4,
  "the shared intake helper is defined once and called from all three dept sites"
);
// Two-path parity: the shared helper is invoked from the department blocks on the inbound body.
assert.ok(
  (indexSrc.match(/resolveDeptWidgetIntakeDecision\(\{\s*\n?\s*message: event\.body/g) ?? []).length >= 2,
  "both the regen and live-twilio dept blocks call the shared intake helper on the inbound body (parity)"
);
// The precedence itself is centralized in the reducer (CLAUDE.md #4) — never inline in index.ts.
assert.match(
  indexSrc,
  /decideDeptWidgetIntakeTurn\(/,
  "the intake precedence comes from the reducer, not an inline per-path gate"
);
// The widget-arrival lane never runs the sales orchestration, so it must apply the acquisition side
// effects itself (trade_cash + the staff appraisal task) — the twilio/regen lanes already do upstream.
assert.match(
  indexSrc,
  /if \(deptIntake\.kind === "sell_to_dealer_appraisal"\) \{\s*\n\s*applySellToDealerAppraisalFromDispositionParse\(/,
  "the widget-arrival dept path applies the sell-to-dealer appraisal side effects"
);
assert.match(
  indexSrc,
  /web_text_widget_\$\{todoReason\}_sell_to_dealer_draft_created/,
  "the widget-arrival dept path emits the sell-to-dealer route outcome"
);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(
  String(pkg.scripts?.["ci:eval"] ?? "").includes("dept_widget_bike_clarify:eval"),
  "dept_widget_bike_clarify:eval is wired into ci:eval"
);

// --- LLM coverage (skipped when no key) ---
if (process.env.OPENAI_API_KEY) {
  process.env.LLM_ENABLED = "1";
  // James Brown's exact case: Motor Clothes widget, message is a bike.
  const james = await classifyDeptWidgetBikeInterestWithLLM({
    message: "Checking out Pan America HD",
    deptLabel: "Motor Clothes"
  });
  assert.ok(james, "LLM returns a verdict for James's message");
  assert.equal(james!.asksAboutMotorcycle, true, "James's 'Checking out Pan America HD' reads as motorcycle interest");
  const clarify = decideDeptWidgetBikeClarify({ parse: james, firstName: "James", deptLabel: "Motor Clothes" });
  assert.ok(clarify && /sales team/i.test(clarify) && /Motor Clothes/i.test(clarify), "James gets a bike-vs-dept clarify");
  console.log(`  LLM coverage (James): ${clarify}`);

  // Pure apparel ask must NOT trip the clarify.
  const gloves = await classifyDeptWidgetBikeInterestWithLLM({
    message: "Do you carry XL leather riding gloves?",
    deptLabel: "Motor Clothes"
  });
  assert.ok(gloves, "LLM returns a verdict for the gloves message");
  assert.equal(gloves!.asksAboutMotorcycle, false, "a pure apparel ask is not motorcycle interest");

  // Gear FOR a bike (bike named only as context) must NOT trip the clarify.
  const gearForBike = await classifyDeptWidgetBikeInterestWithLLM({
    message: "Looking for a windshield bag for my Street Glide",
    deptLabel: "Motor Clothes"
  });
  assert.ok(gearForBike, "LLM returns a verdict for the gear-for-a-bike message");
  assert.equal(gearForBike!.asksAboutMotorcycle, false, "gear for a named bike is a department ask, not motorcycle interest");

  // Lynn Kraus's exact production turn (+17164785613, Motor Clothes widget, corpus sweep
  // 2026-07-28): a clear sell-to-dealer ask must be ANSWERED, never clarified.
  const LYNN =
    "Do you guys buy motorcycles? I have a '17 Harley Road King Special (Olive Gold) with just under 11k miles I'm looking to sell.";
  const lynnDisposition = await parseCustomerDispositionWithLLM({ text: LYNN });
  assert.ok(lynnDisposition, "LLM returns a disposition parse for Lynn's message");
  assert.equal(
    lynnDisposition!.sellToDealerInterest,
    true,
    "an acquisition ask arriving through the Motor Clothes widget reads as sell_to_dealer_interest"
  );
  const lynnBike = await classifyDeptWidgetBikeInterestWithLLM({ message: LYNN, deptLabel: "Motor Clothes" });
  assert.ok(lynnBike, "LLM returns a bike verdict for Lynn's message");
  const lynnDecision = decideDeptWidgetIntakeTurn({
    asksAboutMotorcycle: !!lynnBike!.asksAboutMotorcycle,
    bikeConfidence: lynnBike!.confidence ?? null,
    sellToDealerInterest: !!lynnDisposition!.sellToDealerInterest,
    disposition: lynnDisposition!.disposition ?? null,
    dispositionConfidence: lynnDisposition!.confidence ?? null
  });
  assert.equal(
    lynnDecision.kind,
    "sell_to_dealer_appraisal",
    "a clear sell-to-dealer ask must NOT get the apparel-vs-bike clarify (corpus sweep 2026-07-28)"
  );
  const lynnReply = buildDeptWidgetAcquisitionReply({
    firstName: "Lynn",
    motorcycleReference: lynnBike!.motorcycleReference
  });
  assert.doesNotMatch(lynnReply, /right person|gear\/support/i, `Lynn must not be asked which department: ${lynnReply}`);
  console.log(`  LLM coverage (Lynn, acquisition): ${lynnReply}`);
} else {
  console.log("  (LLM coverage skipped — no OPENAI_API_KEY)");
}

console.log(
  "PASS dept-widget bike-clarify eval (hint + templates + pure decision + intake precedence table + kill switch/LLM-off fail-safe + 3-site wiring + ci:eval)"
);
