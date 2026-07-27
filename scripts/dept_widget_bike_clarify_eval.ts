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
import { classifyDeptWidgetBikeInterestWithLLM } from "../services/api/src/domain/llmDraft.ts";
import {
  hasDeptWidgetBikeHint,
  buildDeptBikeClarifyReply,
  decideDeptWidgetBikeClarify,
  DEPT_WIDGET_BIKE_CLARIFY_CONFIDENCE_MIN
} from "../services/api/src/domain/webWidgetDeptBikeClarify.ts";

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
  /async function resolveDeptWidgetBikeClarify\(/,
  "the clarify decision lives in one shared helper both paths call"
);
assert.ok(
  (indexSrc.match(/resolveDeptWidgetBikeClarify\(/g) ?? []).length >= 4,
  "the shared clarify helper is defined once and called from all three dept sites"
);
// Two-path parity: the shared helper is invoked from the department blocks on the inbound body.
assert.ok(
  (indexSrc.match(/resolveDeptWidgetBikeClarify\(\{\s*\n?\s*message: event\.body/g) ?? []).length >= 2,
  "both the regen and live-twilio dept blocks call the shared clarify helper on the inbound body (parity)"
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
} else {
  console.log("  (LLM coverage skipped — no OPENAI_API_KEY)");
}

console.log(
  "PASS dept-widget bike-clarify eval (hint + template + pure decision + kill switch/LLM-off fail-safe + 3-site wiring + ci:eval)"
);
