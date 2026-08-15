/**
 * Accessory/parts department route — decision table + the catalog corroboration + the wiring.
 *
 * PRODUCTION MISS (+17169400722, replay-judge fails 2026-08-10 saddlebag and 2026-08-13 seat).
 * A customer asked about a narrower Saddlemen SEAT and was answered "I'm not seeing new 2026 Full
 * Line in stock right now" — a line about the motorcycles on the floor. Same lead, three days
 * earlier, a saddlebag question got a reschedule link. Measured 2026-08-14: 17 parts-intent turns
 * across 10 conversations in 30 days.
 *
 * MECHANISM. `conversation_state_parser` returned `departmentIntent: "parts"` correctly, and the
 * live path then re-validated it through a keyword rule (`PARTS_DEPARTMENT_RE`, index.ts) that
 * matches only the literal word "part" — no accessory noun in it at all. The keyword rule vetoed
 * the parser on every real accessory question. Third confirmed instance of the documented
 * anti-pattern; same shape #701 fixed for soft-visit.
 *
 * MEASURED 2026-08-15 — `parseConversationStateWithLLM` EXECUTED on the real turns (real prompt,
 * live model), which is why the table below uses these exact verdicts:
 *   "I would like a backrest if you guys have one"          -> parts   explicitRequest=true
 *   "Do you have the mustache engine guard #49000140 ..."   -> parts   explicitRequest=true
 *   "I need a front brake lever switch"                     -> parts   explicitRequest=true
 *   "did u order that seat yet?"                            -> parts   explicitRequest=true
 *   "Do you have any saddlebags that would fit ..."         -> parts   explicitRequest=true
 *   "And that has stock exhaust and bars?"                  -> none    (bike-shopping lookalike)
 *   "the black one with the speakers"                       -> none    (bike-shopping lookalike)
 *   "Can you install a new headlight bulb ...?"             -> service
 * The two lookalikes are the reason the PARSER is the authority and the catalog lexicon only
 * corroborates: the lexicon matches "exhaust", "bars" AND "speakers", so a lexicon-first rule
 * would have mis-routed both into a manual handoff and killed a live sales conversation.
 *
 * WHAT THIS PINS — the DECISION (does this turn belong to the parts counter), never a label
 * spelling, and it EXECUTES both the referee and `matchPartsCatalogLexicon` on the real customer
 * wording rather than asserting how either is written.
 *
 * NO LLM: the referee and the lexicon are both pure, so this is deterministic and cannot red-line
 * the gate on a model re-roll.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { decideDepartmentRequestTurn } from "../services/api/src/domain/routeStateReducer.ts";
import { matchPartsCatalogLexicon } from "../services/api/src/domain/partsCatalogLexicon.ts";

const failures: string[] = [];
function check(label: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
  }
}

/**
 * The live keyword gate, copied verbatim from `PARTS_DEPARTMENT_RE` (index.ts). It is reproduced
 * here so the eval can feed the referee the SAME corroboration signal production feeds it; the
 * source-pin block at the bottom is what keeps the two from drifting apart.
 */
const PARTS_DEPARTMENT_RE =
  /\b(parts? department|parts? counter|parts? desk|order (a )?part|need (a )?part|part number|oem parts?|aftermarket parts?|parts? for my|do you (have|carry|stock)\b.{0,28}\bparts?)\b/i;

type Case = {
  text: string;
  /** The parser's measured verdict for this turn. */
  parserDepartmentIntent: "parts" | "service" | "apparel" | "none";
  parserExplicitRequest: boolean;
  /** Does the parts counter own this turn? */
  expectParts: boolean;
  why: string;
};

const CASES: Case[] = [
  // --- the reported miss and its siblings: the parser is right, the keyword rule missed them ---
  {
    text: "I would like a backrest if you guys have one",
    parserDepartmentIntent: "parts",
    parserExplicitRequest: true,
    expectParts: true,
    why: "accessory acquisition ask; no literal 'part' anywhere in it"
  },
  {
    text: "Do you have the mustache engine guard #49000140 in stock?",
    parserDepartmentIntent: "parts",
    parserExplicitRequest: true,
    expectParts: true,
    why: "a literal PART NUMBER that the word-'part' rule still missed"
  },
  {
    text: "I need a front brake lever switch",
    parserDepartmentIntent: "parts",
    parserExplicitRequest: true,
    expectParts: true,
    why: "named component, no 'part' wording"
  },
  {
    text: "did u order that seat yet?",
    parserDepartmentIntent: "parts",
    parserExplicitRequest: true,
    expectParts: true,
    why: "order-status on an accessory already requested"
  },
  {
    text: "Do you have any saddlebags that would fit my Street Glide?",
    parserDepartmentIntent: "parts",
    parserExplicitRequest: true,
    expectParts: true,
    why: "fitment question — naming a bike does not make it a bike inquiry"
  },

  // --- the bike-shopping lookalikes: the catalog matches, the PARSER says no, and it wins ---
  {
    text: "And that has stock exhaust and bars?",
    parserDepartmentIntent: "none",
    parserExplicitRequest: true,
    expectParts: false,
    why: "a feature question about a bike we are showing them; lexicon matches exhaust+bars"
  },
  {
    text: "the black one with the speakers",
    parserDepartmentIntent: "none",
    parserExplicitRequest: false,
    expectParts: false,
    why: "identifying which BIKE, not asking for speakers; lexicon matches speakers"
  },

  // --- behaviour preserved: the legacy keyword path and the other two departments ---
  {
    text: "Can I talk to someone at the parts counter?",
    parserDepartmentIntent: "parts",
    parserExplicitRequest: true,
    expectParts: true,
    why: "the legacy wording still routes exactly as it did"
  },
  {
    text: "Can you install a new headlight bulb for me next week?",
    parserDepartmentIntent: "service",
    parserExplicitRequest: true,
    expectParts: false,
    why: "service keeps its own gate; this referee must not claim it"
  }
];

function decide(c: Case) {
  return decideDepartmentRequestTurn({
    parserDepartmentIntent: c.parserDepartmentIntent,
    parserExplicitRequest: c.parserExplicitRequest,
    keywordDepartmentRequest:
      c.parserDepartmentIntent === "parts" ? PARTS_DEPARTMENT_RE.test(c.text) : c.parserExplicitRequest,
    catalogPartsTerm: matchPartsCatalogLexicon(c.text).departmentIntent === "parts"
  });
}

for (const c of CASES) {
  check(`decision | ${c.text}`, () => {
    const got = decide(c);
    assert.equal(
      got.department === "parts",
      c.expectParts,
      `expected parts=${c.expectParts} (${c.why}); got department=${got.department} reason=${got.reason}`
    );
  });
}

// The whole point of the change: five real accessory asks that the keyword rule alone rejects are
// carried by the catalog corroboration. If this ever reads 0, the fix is inert.
check("the catalog is what carries the reported miss", () => {
  const carried = CASES.filter(c => c.expectParts && !PARTS_DEPARTMENT_RE.test(c.text));
  assert.ok(
    carried.length >= 5,
    `expected >= 5 accessory asks the keyword rule cannot carry, got ${carried.length}`
  );
  for (const c of carried) {
    assert.equal(
      decide(c).reason,
      "catalog_corroborated",
      `${c.text} must be carried by the catalog, not by the keyword rule`
    );
  }
});

// The invariant guard: a parser verdict with NO accessory noun and no legacy wording must not put
// a thread into a manual handoff. Acceptance stops the cadence and hands the lead to a person, so
// this is the fail-direction rail, not a stylistic preference.
check("no accessory noun anywhere => the turn stays on the normal path", () => {
  const got = decideDepartmentRequestTurn({
    parserDepartmentIntent: "parts",
    parserExplicitRequest: true,
    keywordDepartmentRequest: false,
    catalogPartsTerm: false
  });
  assert.equal(got.department, null);
  assert.equal(got.reason, "no_accessory_noun");
});

check("explicitRequest=false is never a department request", () => {
  const got = decideDepartmentRequestTurn({
    parserDepartmentIntent: "parts",
    parserExplicitRequest: false,
    keywordDepartmentRequest: true,
    catalogPartsTerm: true
  });
  assert.equal(got.department, null);
  assert.equal(got.reason, "not_explicit_request");
});

check("no parser verdict => nothing changes", () => {
  for (const v of [null, "none"] as const) {
    const got = decideDepartmentRequestTurn({
      parserDepartmentIntent: v,
      parserExplicitRequest: true,
      keywordDepartmentRequest: true,
      catalogPartsTerm: true
    });
    assert.equal(got.department, null, `parserDepartmentIntent=${v} must not route`);
    assert.equal(got.reason, "no_parser_verdict");
  }
});

// Service and apparel are deliberately untouched — their keyword rules carry real vocabulary and
// neither was the reported miss. A catalog noun must not smuggle them past their own gate.
check("service/apparel keep the keyword rule as a hard gate", () => {
  for (const role of ["service", "apparel"] as const) {
    const got = decideDepartmentRequestTurn({
      parserDepartmentIntent: role,
      parserExplicitRequest: true,
      keywordDepartmentRequest: false,
      catalogPartsTerm: true
    });
    assert.equal(got.department, null, `${role} must still require its own keyword corroboration`);
  }
});

// --- wiring: the live/regen/manual paths all reduce through this one site -------------------
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");

check("index.ts asks the referee instead of re-validating the parser itself", () => {
  assert.ok(
    indexSrc.includes("decideDepartmentRequestTurn({"),
    "applyConversationStateReducer must call decideDepartmentRequestTurn"
  );
  assert.ok(
    indexSrc.includes("catalogPartsTerm: matchPartsCatalogLexicon(normalizedText).departmentIntent === "),
    "the catalog corroboration must be fed to the referee from the live reducer"
  );
  assert.ok(
    !indexSrc.includes("parserDepartmentExplicitRequest"),
    "the old keyword-veto local must be gone, or the parser can still be overruled"
  );
});

check("the keyword rule copied into this eval still matches production", () => {
  const live = indexSrc.match(/const PARTS_DEPARTMENT_RE\s*=\s*\n?\s*(\/[\s\S]*?\/i);/);
  assert.ok(live, "PARTS_DEPARTMENT_RE not found in index.ts");
  assert.equal(
    live![1].replace(/\s+/g, ""),
    PARTS_DEPARTMENT_RE.toString().replace(/\s+/g, ""),
    "index.ts changed PARTS_DEPARTMENT_RE — update the copy in this eval and re-measure the table"
  );
});

check("one referee, both paths: the reducer is the only acceptance site", () => {
  const calls = indexSrc.match(/decideDepartmentRequestTurn\(/g) ?? [];
  assert.equal(calls.length, 1, `expected exactly 1 acceptance site, found ${calls.length}`);
});

if (failures.length) {
  console.error("accessory_parts_route:eval FAILED");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`accessory_parts_route:eval PASS (${CASES.length} turns + 7 rails)`);
