/**
 * rider_experience_persist:eval — we now REMEMBER whether a lead can ride yet, and the memory is
 * one-way.
 *
 * WHY (Joe, 2026-08-07, asking for a list of customers who are not licensed). `resolveRiderExperienceLevel`
 * already worked this out on every relevant turn and threw it away, so the audience could not be
 * queried. Measured on the live americanharley store, 822 conversations: we raised an endorsement in
 * 19 outbound messages, a customer answered in 4, and 4 leads carry the riding school's structured
 * enrollment record. Persisting the reads we ALREADY make is what turns that into a list that grows.
 *
 * THE ONE-WAY RULE IS THE POINT. `none_or_little` -> `experienced` is allowed (people get licensed,
 * and a stale beginner label would put a newly-endorsed rider on a learn-to-ride list).
 * `experienced` -> `none_or_little` is REFUSED. The failure this whole lane has always guarded
 * against is calling a thirty-year rider a beginner; a marketing list makes that failure durable and
 * public instead of one awkward sentence. A missed invite costs an opportunity, a wrong one insults
 * a customer.
 *
 * And `unknown` never writes: a stored "unknown" is indistinguishable from a real read, and the list
 * filter must treat never-read as "not on the beginner list" rather than "probably a beginner".
 *
 * Deterministic throughout — no LLM call, no clock dependence (every timestamp is passed in).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { decideRiderExperiencePersist, resolveRiderExperienceLevel } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { buildMarketingList } = await import("../services/api/src/domain/marketingLists.ts");

const NOW = "2026-08-07T18:00:00.000Z";
const EARLIER = "2026-07-01T10:00:00.000Z";
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

console.log("rider_experience_persist:eval");

// ── 1) The referee's decision table. ──
check("an UNKNOWN read never writes — absence of evidence is not evidence", () => {
  for (const current of [null, { level: "none_or_little" }, { level: "experienced" }]) {
    const d = decideRiderExperiencePersist({ current, observed: "unknown", source: "parser", nowIso: NOW });
    assert.equal(d.write, false, `unknown must not write over ${JSON.stringify(current)}`);
    assert.equal(d.reason, "observed_unknown");
  }
});

check("the first explicit read is stored, with its level, source and timestamp", () => {
  const d: any = decideRiderExperiencePersist({ current: null, observed: "none_or_little", source: "enrollment", nowIso: NOW });
  assert.equal(d.write, true);
  assert.equal(d.reason, "first_observation");
  assert.deepEqual(d.next, { level: "none_or_little", source: "enrollment", at: NOW });
});

check("UPGRADE allowed: a beginner who turns up endorsed becomes experienced", () => {
  const d: any = decideRiderExperiencePersist({
    current: { level: "none_or_little" },
    observed: "experienced",
    source: "parser",
    nowIso: NOW
  });
  assert.equal(d.write, true);
  assert.equal(d.reason, "upgrade_to_experienced");
  assert.equal(d.next.level, "experienced");
});

check("DEMOTION REFUSED: an experienced rider is never re-labelled a beginner", () => {
  const d = decideRiderExperiencePersist({
    current: { level: "experienced" },
    observed: "none_or_little",
    source: "parser",
    nowIso: NOW
  });
  assert.equal(d.write, false, "this is the insult failure — it must not write");
  assert.equal(d.reason, "never_demote_experienced");
});

check("an unchanged read does not churn the record", () => {
  for (const level of ["none_or_little", "experienced"] as const) {
    const d = decideRiderExperiencePersist({ current: { level, at: EARLIER } as any, observed: level, source: "parser", nowIso: NOW });
    assert.equal(d.write, false, `${level} re-read must not rewrite`);
    assert.equal(d.reason, "unchanged");
  }
});

check("a junk or empty stored level is treated as no read at all, not as a block", () => {
  for (const current of [{ level: "" }, { level: "   " }, { level: null }, {} as any]) {
    const d: any = decideRiderExperiencePersist({ current, observed: "none_or_little", source: "parser", nowIso: NOW });
    assert.equal(d.write, true, `junk current ${JSON.stringify(current)} must not wedge the field`);
    assert.equal(d.reason, "first_observation");
  }
});

// ── 2) The reads that feed it, on the REAL shapes from the live store. ──
check("the live enrollment records resolve the way the list needs", () => {
  // Verbatim values measured in the americanharley store 2026-08-07.
  assert.equal(
    resolveRiderExperienceLevel({ ridingHistory: "I have never been on a motorcycle (even as a passenger)" }),
    "none_or_little"
  );
  assert.equal(resolveRiderExperienceLevel({ ridingHistory: "I have ridden only as a passenger" }), "none_or_little");
  assert.equal(
    resolveRiderExperienceLevel({ ridingHistory: "I have operated an on-road motorcycle within the last 12 months" }),
    "experienced",
    "the common enrollee IS a rider — this is why enrolment alone cannot mean beginner"
  );
  // An endorsement in hand outranks a beginner-sounding intent.
  assert.equal(resolveRiderExperienceLevel({ riderIntent: "first_time_rider", hasEndorsement: true }), "experienced");
  // The parser saying no-endorsement is an explicit beginner read.
  assert.equal(resolveRiderExperienceLevel({ riderIntent: "no_motorcycle_endorsement" }), "none_or_little");
  // Nothing to go on stays unknown, which the referee then refuses to store.
  assert.equal(resolveRiderExperienceLevel({}), "unknown");
});

// ── 3) The marketing-list filter. ──
const nowMs = Date.parse("2026-08-07T18:00:00.000Z");
let seq = 0;
function lead(riderExperience: any): any {
  seq++;
  const phone = `+1555010${String(seq).padStart(4, "0")}`;
  return {
    id: `c-${seq}`,
    leadKey: phone,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    messages: [{ id: `m-${seq}`, direction: "in", from: "x", to: "y", body: "hi", at: "2026-08-06T00:00:00.000Z", provider: "twilio" }],
    lead: { firstName: `Lead${seq}`, phone, email: `l${seq}@example.com`, source: "Riding Academy - Enrolled" },
    riderExperience
  };
}
const NO_SUPPRESSION = () => false;

check("filtering for beginners returns ONLY leads read as beginners", () => {
  const beginner = lead({ level: "none_or_little", source: "enrollment", at: NOW });
  const rider = lead({ level: "experienced", source: "parser", at: NOW });
  const neverRead = lead(undefined);
  const list = buildMarketingList([beginner, rider, neverRead], {
    filters: { channel: "sms", riderExperience: "none_or_little" } as any,
    isPhoneSuppressed: NO_SUPPRESSION,
    nowMs
  });
  assert.deepEqual(list.rows.map(r => r.leadKey), [beginner.leadKey], "only the beginner is on the beginner list");
});

check("NEVER-READ is not a beginner — the ignorance case, and the reason the list stays small", () => {
  const neverRead = lead(undefined);
  const emptyLevel = lead({ level: "", source: "parser", at: NOW });
  const list = buildMarketingList([neverRead, emptyLevel], {
    filters: { channel: "sms", riderExperience: "none_or_little" } as any,
    isPhoneSuppressed: NO_SUPPRESSION,
    nowMs
  });
  assert.equal(list.rows.length, 0, "a lead we have never read must never join the beginner list");
});

check("the experienced filter is the mirror image, and no filter still returns everyone", () => {
  const beginner = lead({ level: "none_or_little", source: "enrollment", at: NOW });
  const rider = lead({ level: "experienced", source: "parser", at: NOW });
  const neverRead = lead(undefined);
  const all = [beginner, rider, neverRead];
  const experienced = buildMarketingList(all, {
    filters: { channel: "sms", riderExperience: "experienced" } as any,
    isPhoneSuppressed: NO_SUPPRESSION,
    nowMs
  });
  assert.deepEqual(experienced.rows.map(r => r.leadKey), [rider.leadKey]);
  const unfiltered = buildMarketingList(all, {
    filters: { channel: "sms" } as any,
    isPhoneSuppressed: NO_SUPPRESSION,
    nowMs
  });
  assert.equal(unfiltered.rows.length, 3, "omitting the filter must not silently narrow the audience");
});

check("the filter does not bypass compliance — an opted-out beginner is still excluded", () => {
  const optedOut = lead({ level: "none_or_little", source: "enrollment", at: NOW });
  optedOut.lead.smsOptIn = false;
  const list = buildMarketingList([optedOut], {
    filters: { channel: "sms", riderExperience: "none_or_little" } as any,
    isPhoneSuppressed: NO_SUPPRESSION,
    nowMs
  });
  assert.equal(list.rows.length, 0);
  assert.equal(list.excluded.optedOut, 1, "compliance still counts it, and still wins");
});

// ── 4) WIRING — the ratchet cannot prove this, so count the call sites with an EXPECTED COUNT. ──
check("the writer is called from BOTH paths, via the one existing state applier", () => {
  const idx = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
  const policy = fs.readFileSync(path.resolve("services/api/src/domain/firstTimeRiderPolicy.ts"), "utf8");

  // The persist step lives in the DOMAIN module (index.ts sits at its size ceiling), and is invoked
  // from applyFirstTimeRiderGuidanceState so it inherits that function's call sites rather than
  // becoming a fourth writer someone must keep in sync.
  assert.ok(policy.includes("export function applyRiderExperienceState"), "the persist step lives in domain/");
  const applierBody = idx.slice(
    idx.indexOf("function applyFirstTimeRiderGuidanceState"),
    idx.indexOf("function buildAffordabilityRideConfidenceObjectionReply")
  );
  assert.ok(applierBody.length > 0, "the state applier still exists");
  assert.ok(applierBody.includes("applyRiderExperienceState"), "the applier invokes the persist step");
  // Read the import STATEMENT, then look inside it. The older form matched the literal
  // `applyRiderExperienceState } from "..."`, which also asserted the symbol was LAST in the list —
  // so on 2026-08-12 an unrelated slice adding a sibling import to the same module red-lined a full
  // 6.7-minute gate for a name ordering nobody had ever decided. Same guarantee, no tripwire.
  const policyImport = idx.match(/import \{([^}]*)\} from "\.\/domain\/firstTimeRiderPolicy\.js";/);
  assert.ok(policyImport, "index.ts imports from domain/firstTimeRiderPolicy");
  assert.ok(/\bapplyRiderExperienceState\b/.test(policyImport![1]), "and imports the persist step");

  // THREE call sites, and they are the live twilio turn plus BOTH regenerate turns. An expected
  // COUNT, because unwiring one of three leaves every other guard in this file green.
  const callSites = idx.split("applyFirstTimeRiderGuidanceState(conv,").length - 1;
  assert.equal(callSites, 3, `expected 3 call sites (live + regen + initial-ADF regen), found ${callSites}`);

  // The persist step must ask the REFEREE, never write the field inline, and be the ONLY writer.
  const persistBody = policy.slice(policy.indexOf("export function applyRiderExperienceState"));
  assert.ok(persistBody.includes("decideRiderExperiencePersist"), "the referee decides");
  assert.ok(persistBody.includes("decision.write"), "and the write is gated on its verdict");
  const inlineWrites = (idx + policy).split("conv.riderExperience =").length - 1;
  assert.equal(inlineWrites, 1, `riderExperience must have exactly ONE writer, found ${inlineWrites}`);
});

if (failures) {
  console.error(`\nrider_experience_persist:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("rider_experience_persist:eval passed");
