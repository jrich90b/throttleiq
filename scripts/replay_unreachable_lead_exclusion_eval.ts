/**
 * Replay: a lead we cannot reach is not graded (Joe ruling 2026-07-24, re-stated 2026-08-12).
 *
 * Facebook Marketplace relay leads arrive through AutoDealers.Digital with NO phone and NO email —
 * the customer lives inside the Facebook inbox and a rep answers by hand from a paste-ready task
 * (domain/marketplaceRelay.ts, PR #285). LeadRider never sends them anything: measured on the live
 * store 2026-08-12, 18 of 18 got the relay task and ZERO outbound rows exist.
 *
 * The nightly replay still drafted a reply for them and LLM-judged it, and the judge — correctly —
 * observed that the draft never confirms availability or price. That minted a P1 per lead against
 * text nobody could receive: MEASURED 2026-08-12, 21 of the 41 work orders in the queue were this
 * one class, re-filed every night. This eval pins the exclusion.
 *
 * EXECUTES the predicate and the end-to-end finding path (a source-text assertion could not prove
 * either still runs). Every fixture body below is VERBATIM from the live store — the AutoDealers
 * rows carry no Phone: line and no Email: line at all, which is the fact the filter reads. Writing
 * this against invented ADF wordings would have passed while proving nothing.
 *
 * The filter is on the CONTACT CHANNEL, never the source name: a lead from this same source that
 * ever arrives WITH a phone or an email is reachable and must still be graded.
 *
 * Run: npx tsx scripts/replay_unreachable_lead_exclusion_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  adjustScore,
  buildFindings,
  isUnreachableLeadRow,
  type ReplayRow,
  type TurnScore
} from "./corpus_replay_flywheel.ts";

// --- Fixtures: VERBATIM bodies from /home/ubuntu/leadrider-runtime/americanharley/data (2026-08-12)

/** adf_ref_11763 — a current relay lead. No Phone: line, no Email: line. */
const UNREACHABLE_BODY = [
  "WEB LEAD (ADF)",
  "Source: AutoDealers.Digital - autodealersdigital.com",
  "Ref: 11763",
  "Name: Joshua Hanzlian",
  "Stock: U595-26",
  "VIN: ME3HJN478TK700029",
  "Year: 2026",
  "Vehicle: ROYAL ENFIELD Royal Enfield Super Meteor 650 2026 #650 U595-26 Celestial Blue",
  "",
  "Inquiry:",
  "Lead arrived"
].join("\n");

/** adf_ref_11072 — an OLDER relay lead carrying the DEALERSHIP'S own address, not the customer's. */
const DEALER_EMAIL_BODY = [
  "WEB LEAD (ADF)",
  "Source: AutoDealers.Digital - autodealersdigital.com",
  "Ref: 11072",
  "Name: Brian' Dj'Bizz",
  "Email: gio@americanharley-davidson.com",
  "Stock: T26-26",
  "VIN: 1HD1KH71XTB622446",
  "Year: 2026",
  "Vehicle: Harley-Davidson Road Glide 2026 FLTRX T26-26 Teal Thunder Vivid Black Chrome Trim",
  "",
  "Inquiry:",
  "Lead arrived"
].join("\n");

/** +15136149740 — a REACHABLE web lead: real phone, real customer email. Must stay graded. */
const REACHABLE_BODY = [
  "WEB LEAD (ADF)",
  "Source: Room58 - Book test ride",
  "Ref: 11266",
  "Name: Raysean Mcclinon",
  "Email: raysean88mcclinon@gmail.com",
  "Phone: 5136149740",
  "Year: 2026",
  "Vehicle: Harley-Davidson Road Glide",
  "",
  "Inquiry:",
  "Test ride request for Road Glide. Preferred date: 5/29/2026. Preferred time: Any."
].join("\n");

const row = (over: Partial<ReplayRow>): ReplayRow => ({
  conversationId: "adf_ref_11763",
  body: UNREACHABLE_BODY,
  draft: "Hey Joshua, it's Alexandra over at American Harley-Davidson. Thanks for your inquiry.",
  verdict: "review",
  ...over
});

// --- The predicate itself ---
{
  assert.equal(
    isUnreachableLeadRow(row({})),
    true,
    "a relay lead with no phone and no email is unreachable (adf_ref_11763, live store)"
  );

  // A phone-number conversation id IS an address — reachable, grade it.
  assert.equal(
    isUnreachableLeadRow(row({ conversationId: "+15136149740", body: REACHABLE_BODY })),
    false,
    "a lead with a real phone stays graded"
  );
  assert.equal(
    isUnreachableLeadRow(row({ conversationId: "+17165230421", body: UNREACHABLE_BODY })),
    false,
    "a phone-number conversation id is itself a delivery address, whatever the envelope says"
  );
  assert.equal(
    isUnreachableLeadRow(row({ conversationId: "warreng323@gmail.com", body: UNREACHABLE_BODY })),
    false,
    "an email conversation id is itself a delivery address"
  );

  // Same source, but a contact line present => reachable. This is the whole point of filtering on
  // the CHANNEL rather than the source name.
  assert.equal(
    isUnreachableLeadRow(row({ body: UNREACHABLE_BODY.replace("Stock:", "Phone: 7165551234\nStock:") })),
    false,
    "the SAME relay source with a phone is reachable and must still be graded"
  );
  assert.equal(
    isUnreachableLeadRow(row({ body: UNREACHABLE_BODY.replace("Stock:", "Email: joshua@example.com\nStock:") })),
    false,
    "the same relay source with a customer email is reachable and must still be graded"
  );

  // Placeholder contact values are not contact.
  for (const placeholder of ["n/a", "N/A", "none", "unknown", "-"]) {
    assert.equal(
      isUnreachableLeadRow(row({ body: UNREACHABLE_BODY.replace("Stock:", `Phone: ${placeholder}\nStock:`) })),
      true,
      `a Phone: field of "${placeholder}" is not a delivery address`
    );
  }

  // Narrowness: only an ADF intake envelope declares contact fields. A plain customer turn carries
  // no Phone:/Email: line either, and must NEVER be excluded on that basis.
  assert.equal(
    isUnreachableLeadRow(row({ conversationId: "lead_abc123", body: "I'm just trying to get an average price for this bike" })),
    false,
    "a plain customer message is not an ADF envelope and is always graded"
  );
  assert.equal(
    isUnreachableLeadRow(row({ conversationId: "lead_abc123", body: "" })),
    false,
    "an empty body is never treated as an unreachable lead"
  );
}

// --- adjustScore: the exclusion is named, not silent ---
{
  const failing = (over: Partial<ReplayRow>) => {
    const r = row(over);
    const score: TurnScore = {
      turnKey: `${r.conversationId}::m1`,
      conversationId: r.conversationId,
      pass: false,
      critical: true,
      verdict: "review",
      reviewReasons: ["judge: did not confirm availability or price"],
      judge: { addressed: false, customerAsk: "info about the listed bike", why: "the draft never answers" }
    } as unknown as TurnScore;
    return { r, adjusted: adjustScore(score, r) };
  };

  const unreachable = failing({});
  assert.equal(unreachable.adjusted.excluded, true, "an unreachable lead's turn is excluded from scoring");
  assert.equal(
    unreachable.adjusted.adjustment,
    "excluded_unreachable_lead",
    "the exclusion is NAMED so the summary can count it — nothing is dropped silently"
  );
  assert.equal(unreachable.adjusted.critical, false, "an ungradeable turn cannot be a release-blocking CRITICAL");

  const reachable = failing({ conversationId: "+15136149740", body: REACHABLE_BODY });
  assert.notEqual(
    reachable.adjusted.adjustment,
    "excluded_unreachable_lead",
    "a reachable lead's failing turn is NOT excluded by this rule"
  );

  // The older relay records carry the dealership's own address; the pre-existing test-lead rule
  // already covers those, and it must keep covering them (this fix does not replace it).
  const dealerEmail = failing({ conversationId: "adf_ref_11072", body: DEALER_EMAIL_BODY });
  assert.equal(
    dealerEmail.adjusted.excluded,
    true,
    "an ADF carrying the dealership's OWN address is still excluded (pre-existing test-lead rule)"
  );
}

// --- End to end: the P1 is never minted for an unreachable lead, and still is for a reachable one ---
{
  const mkScore = (conversationId: string, body: string) => {
    const r: ReplayRow = row({ conversationId, body });
    const base: TurnScore = {
      turnKey: `${conversationId}::m1`,
      conversationId,
      pass: false,
      critical: true,
      verdict: "review",
      reviewReasons: ["judge: did not confirm availability or price"],
      judge: { addressed: false, customerAsk: "info about the listed bike", why: "the draft never answers" }
    } as unknown as TurnScore;
    return adjustScore(base, r);
  };

  const unreachableScore = mkScore("adf_ref_11763", UNREACHABLE_BODY);
  const reachableScore = mkScore("+15136149740", REACHABLE_BODY);

  const findings = buildFindings([unreachableScore, reachableScore], [], "2026-08-12T20:00:00.000Z", "abc1234");
  const ids = findings.map(f => f.convId);
  assert.ok(
    !ids.includes("adf_ref_11763"),
    `no work order may be filed against a lead nobody can reach — got ${JSON.stringify(ids)}`
  );
  assert.ok(
    ids.includes("+15136149740"),
    `a reachable lead's failing turn must STILL file its work order — got ${JSON.stringify(ids)}`
  );
  assert.equal(findings.length, 1, "exactly one finding survives: the reachable lead's");
}

// --- The KNOWN BOUNDARY, pinned so it cannot widen unnoticed ---
// A lead that ARRIVED contactless but later picked up a phone (adf_ref_11422, 14 real sends) loses
// only its INTAKE ACK to this rule. Every later turn carries a plain customer body, so it fails the
// envelope test and is graded exactly as before. Measured 2026-08-12: 26 intake turns excluded, 24
// of them leads that never received anything, 2 that did. If this assertion ever fails, the rule has
// started eating real conversation turns and needs the conversation-level reachability lookup.
{
  const laterTurn: ReplayRow = row({
    conversationId: "adf_ref_11422",
    body: "Fair enough. And I need a front tire and probably back. I appreciate the advice.",
    draft: "Thanks for the details — I'll have the team check service records (battery/tires) and follow up."
  });
  assert.equal(
    isUnreachableLeadRow(laterTurn),
    false,
    "a real conversation turn on a lead that became reachable is STILL graded — only the intake ack is excluded"
  );
}

// --- ci:eval wiring ---
{
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.ok(
    String(pkg.scripts?.["ci:eval"] ?? "").includes("replay_unreachable_lead_exclusion:eval"),
    "replay_unreachable_lead_exclusion:eval is wired into ci:eval"
  );
}

console.log(
  "PASS replay unreachable-lead exclusion eval (predicate + channel-not-source + placeholders + narrowness + named exclusion + end-to-end finding path)"
);
