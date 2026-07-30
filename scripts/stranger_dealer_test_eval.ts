/**
 * Stranger-test harness eval (readiness-bar section 4, 2026-07-30).
 *
 * Pins the HARNESS's own logic, not any dealer's output — so it is per-dealer-gate safe
 * and costs nothing to run. A leak detector nobody has tested is worse than no detector:
 * a false negative reads as "dealer #2 works".
 *
 * What it pins:
 *   1. LEAK DETECTION catches every identity shape — name, persona, city, street, zip,
 *      website host, and a phone in ANY formatting (digit-run matching).
 *   2. NO FALSE POSITIVES on clean stranger copy: the shared brand ("Harley-Davidson"),
 *      a different city, and a different area code must not trip it.
 *   3. THE FIXTURE ITSELF is a true stranger: STRANGER_DEALER shares no identity token
 *      with the protected profile, so the test can never pass by being the same dealer.
 *   4. ANTI-FLATTERY: offline mode can never report passed:true, any leak fails, any
 *      probe error fails (fail-closed), and a missing source audit fails.
 *   5. THE FAIL-DIRECTION CLASSIFIER separates an identity fallback from a hardcoded
 *      matcher from a pinned URL, and does NOT call prose-with-slashes a regex.
 *   6. THE REPORT CONTRACT the scorecard depends on: {passed, at, detail} present and
 *      typed as scripts/rollout_readiness_report.ts reads them.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEALER_PINNING_ENV_VARS,
  STRANGER_DEALER,
  STRANGER_DEALER_SLUG,
  neutralizeDealerScopedEnv,
  buildIdentityLeakTokens,
  scanForIdentityLeaks,
  auditAhFallbackSites,
  gradeStrangerTest,
  type FallbackSite,
  type Probe
} from "./stranger_dealer_test.ts";

type Check = { id: string; ok: boolean; note: string };
const checks: Check[] = [];
const check = (id: string, note: string, fn: () => void) => {
  try {
    fn();
    checks.push({ id, ok: true, note });
  } catch (err) {
    checks.push({ id, ok: false, note: `${note} — ${err instanceof Error ? err.message : String(err)}` });
  }
};

/**
 * A wholly FICTIONAL "protected" dealer standing in for the dealer whose identity must
 * not escape. Deliberately not American Harley's real name, persona, address, or phone:
 * the detector is identity-shape-agnostic, so using live data would buy nothing and would
 * hardcode a dealer fact into a universal eval (the thing eval_suite_manifest:eval
 * forbids, and rightly — this suite has to stay green pointed at any dealer).
 */
const PROTECTED = {
  dealerName: "Riverbend Harley-Davidson",
  agentName: "Priya",
  phone: "(585) 555-0173",
  website: "https://riverbendharley-davidson.example.com",
  address: { line1: "410 Millrace Ave.", city: "Riverbend Falls", state: "NY", zip: "13045" }
};
const TOKENS = buildIdentityLeakTokens(PROTECTED, ["Riverbend Harley", "riverbendharley"]);

// --- 1. Every identity shape is caught. -------------------------------------
const LEAK_CASES: { id: string; text: string; expectLabel: string }[] = [
  { id: "dealer_name", text: "Hey Dana, it's Marcus over at Riverbend Harley-Davidson. ", expectLabel: "dealer name" },
  { id: "persona", text: "Hey Dana, it's Priya over at Great Lakes Harley-Davidson. ", expectLabel: "persona name" },
  { id: "city", text: "We're right here in Riverbend Falls, come on by.", expectLabel: "city" },
  { id: "street", text: "We're at 410 Millrace Ave., see you soon.", expectLabel: "street" },
  { id: "zip", text: "Our shop is in 13045 if you want to map it.", expectLabel: "zip" },
  { id: "website_host", text: "Browse inventory: https://riverbendharley-davidson.example.com/new", expectLabel: "website" },
  { id: "phone_formatted", text: "Give us a ring at (585) 555-0173 anytime.", expectLabel: "phone" },
  { id: "phone_dashed", text: "Call 585-555-0173 and ask for me.", expectLabel: "phone" },
  { id: "phone_e164", text: "Text +15855550173 for faster service.", expectLabel: "phone" },
  { id: "short_form", text: "Thanks for choosing Riverbend Harley!", expectLabel: "known short form" }
];
for (const testCase of LEAK_CASES) {
  check(`leak_caught:${testCase.id}`, `detects a leaked ${testCase.expectLabel}`, () => {
    const leaks = scanForIdentityLeaks(testCase.id, testCase.text, TOKENS);
    assert.ok(leaks.length > 0, "expected a leak, found none");
    assert.ok(
      leaks.some(l => l.tokenLabel === testCase.expectLabel),
      `expected a "${testCase.expectLabel}" leak, got ${JSON.stringify(leaks.map(l => l.tokenLabel))}`
    );
    assert.ok(leaks[0].excerpt.length > 0, "leak excerpt should quote the offending text");
  });
}

// --- 2. No false positives on clean stranger copy. --------------------------
const CLEAN_CASES: { id: string; text: string }[] = [
  { id: "brand_only", text: "Hey Dana, it's Marcus over at Great Lakes Harley-Davidson. " },
  { id: "stranger_city", text: "We're right here in Sandusky, come on by." },
  { id: "stranger_phone", text: "Give us a ring at (419) 555-0142 anytime." },
  { id: "stranger_site", text: "Browse inventory: https://greatlakesharley.example.com/new" },
  { id: "model_talk", text: "The 2026 Road Glide just landed — want me to send photos?" },
  { id: "generic_stand_ins", text: "it's the team over at our dealership. " },
  { id: "empty", text: "" }
];
for (const testCase of CLEAN_CASES) {
  check(`no_false_positive:${testCase.id}`, "clean stranger copy is not flagged", () => {
    const leaks = scanForIdentityLeaks(testCase.id, testCase.text, TOKENS);
    assert.equal(leaks.length, 0, `unexpected leak(s): ${JSON.stringify(leaks)}`);
  });
}

// --- 3. The fixture is genuinely a stranger. --------------------------------
check("fixture_is_a_stranger", "STRANGER_DEALER shares no identity token with the protected dealer", () => {
  const serialized = JSON.stringify(STRANGER_DEALER);
  const leaks = scanForIdentityLeaks("fixture", serialized, TOKENS);
  assert.equal(leaks.length, 0, `the stranger fixture carries protected identity: ${JSON.stringify(leaks)}`);
});

check("token_floor", "tokens shorter than 4 chars are refused (they match innocent words)", () => {
  const tokens = buildIdentityLeakTokens({ dealerName: "AH", agentName: "Jo", address: { city: "Ada" } }, []);
  assert.equal(tokens.length, 0, `expected no tokens from sub-4-char identity, got ${JSON.stringify(tokens)}`);
});

check("state_code_not_tokenized", "a state code never becomes a leak token", () => {
  assert.ok(
    !TOKENS.some(t => t.value === "ny"),
    "state codes must not be tokens — they would fire on ordinary text"
  );
});

// --- 4. Anti-flattery grading. ----------------------------------------------
const cleanProbe: Probe = { id: "p", layer: "B_copy", label: "clean", produced: "all good", ok: true };
const goodAudit: FallbackSite[] = [];

check("offline_never_passes", "an offline run cannot report passed, however clean", () => {
  const result = gradeStrangerTest({
    mode: "offline",
    probes: [cleanProbe],
    leaks: [],
    fallbackSites: goodAudit,
    at: "2026-07-30T00:00:00.000Z"
  });
  assert.equal(result.passed, false, "offline mode must never pass");
  assert.match(result.detail, /offline scan only/i, "detail must say why it cannot pass");
});

check("live_clean_passes", "a live run with zero leaks and zero errors passes", () => {
  const result = gradeStrangerTest({
    mode: "live",
    probes: [cleanProbe],
    leaks: [],
    fallbackSites: goodAudit,
    at: "2026-07-30T00:00:00.000Z"
  });
  assert.equal(result.passed, true, `expected pass, got: ${result.detail}`);
});

check("leak_fails_live", "any identity leak fails a live run", () => {
  const result = gradeStrangerTest({
    mode: "live",
    probes: [cleanProbe],
    leaks: [{ source: "s", token: "riverbend harley-davidson", tokenLabel: "dealer name", excerpt: "…" }],
    fallbackSites: goodAudit,
    at: "2026-07-30T00:00:00.000Z"
  });
  assert.equal(result.passed, false, "a leak must fail the run");
  assert.match(result.detail, /identity leak/i);
});

check("probe_error_fails_closed", "a probe that threw is a failure, never a skipped check", () => {
  const result = gradeStrangerTest({
    mode: "live",
    probes: [cleanProbe, { id: "boom", layer: "D_live", label: "x", produced: "", ok: false, error: "kaboom" }],
    leaks: [],
    fallbackSites: goodAudit,
    at: "2026-07-30T00:00:00.000Z"
  });
  assert.equal(result.passed, false, "a probe error must fail the run");
  assert.equal(result.probesFailed, 1);
  assert.match(result.detail, /probe\(s\) errored/i);
});

check("missing_audit_fails_closed", "an unreadable source tree fails rather than reporting clean", () => {
  const result = gradeStrangerTest({
    mode: "live",
    probes: [cleanProbe],
    leaks: [],
    fallbackSites: null,
    at: "2026-07-30T00:00:00.000Z"
  });
  assert.equal(result.passed, false, "a missing audit must fail the run");
  assert.equal(result.fallbackSites, null);
  assert.match(result.detail, /source audit/i);
});

check("latent_debt_does_not_fail", "latent source debt is reported as a fix list, not a live failure", () => {
  const result = gradeStrangerTest({
    mode: "live",
    probes: [cleanProbe],
    leaks: [],
    fallbackSites: [
      { file: "f.ts", line: 1, failDirection: "identity_fallback", snippet: "x" },
      { file: "f.ts", line: 2, failDirection: "hardcoded_matcher", snippet: "y" }
    ],
    at: "2026-07-30T00:00:00.000Z"
  });
  assert.equal(result.passed, true, "latent debt alone must not fail a clean live run");
  assert.equal(result.fallbackSites?.identityFallbacks.length, 1);
  assert.equal(result.fallbackSites?.hardcodedMatchers.length, 1);
  assert.match(result.detail, /latent identity fallback/i, "but it must still be reported");
});

// --- 5. The fail-direction classifier. -------------------------------------
check("classifier_separates_fail_directions", "each AH literal shape lands in the right bucket", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stranger-audit-"));
  fs.writeFileSync(
    path.join(dir, "sample.ts"),
    [
      '// A comment about American Harley is prose, not debt.',
      ' * American Harley in a block comment is also prose.',
      'const a = profile?.dealerName ?? "American Harley-Davidson";',
      'const b = String(p?.dealerName ?? "").trim() || "American Harley-Davidson";',
      'if (/\\bamerican harley\\b/i.test(lower)) return true;',
      '{ pattern: /\\bamerican harley\\b/i, weight: 2 },',
      'const c = /\\bin\\s+(?!north tonawanda\\b|buffalo\\b)[a-z]+/.test(lower);',
      'const d = { clientName: "American Harley-Davidson" };',
      'const e = "https://americanharley-davidson.com/inventory/xml?location=127";',
      'const f = "the letterhead / \'from\' / \'remit to\' party — never \'American Harley-Davidson\' here";'
    ].join("\n")
  );
  const sites = auditAhFallbackSites(dir);
  assert.ok(sites, "audit should return sites for a readable tree");
  const at = (line: number) => sites!.find(s => s.line === line);

  assert.equal(at(1), undefined, "line comments are excluded");
  assert.equal(at(2), undefined, "block comments are excluded");
  assert.equal(at(3)?.failDirection, "identity_fallback", "?? fallback");
  assert.equal(at(4)?.failDirection, "identity_fallback", "|| fallback");
  assert.equal(at(5)?.failDirection, "hardcoded_matcher", "applied regex literal");
  assert.equal(at(6)?.failDirection, "hardcoded_matcher", "regex in a pattern field");
  assert.equal(at(7)?.failDirection, "hardcoded_matcher", "city exclusion regex");
  assert.equal(at(8)?.failDirection, "pinned_identity", "identity assigned outright");
  assert.equal(at(9)?.failDirection, "pinned_url", "hardcoded AH web address");
  assert.equal(
    at(10)?.failDirection,
    "other",
    "prose containing slashes is NOT a regex — it must fall through to the human-read bucket"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check("url_class_is_ratchet_blind", "the audit sees the no-space host form the ratchet's pattern misses", () => {
  // The portability ratchet greps /american harley|north tonawanda/i, which cannot match
  // "americanharley-davidson.com". The first live stranger run caught exactly this class
  // reaching a customer, so the audit must carry its own literal set.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stranger-url-"));
  const hostFormLine = 'const u = "https://americanharley-davidson.com/new";';
  fs.writeFileSync(path.join(dir, "u.ts"), `${hostFormLine}\n`);
  const sites = auditAhFallbackSites(dir);
  assert.equal(sites?.length, 1, "the host-form URL must be counted");
  assert.equal(sites?.[0].failDirection, "pinned_url");
  // The ratchet's own pattern, evaluated off the assertion line so this universal eval
  // never carries a dealer literal on an asserting line (eval_suite_manifest:eval).
  const ratchetPattern = /american harley|north tonawanda/i;
  const ratchetSeesIt = ratchetPattern.test(hostFormLine);
  assert.equal(ratchetSeesIt, false, "sanity: the ratchet's pattern really is blind to the host form");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("audit_missing_tree_returns_null", "a missing tree returns null so the caller can fail closed", () => {
  assert.equal(auditAhFallbackSites(path.join(os.tmpdir(), "definitely-not-here-stranger")), null);
});

// --- 5b. Env neutralization — the fix for this harness's own first false alarm. ---
check("env_neutralization", "dealer-pinning env is cleared and re-pinned to the stranger", () => {
  const saved = { ...process.env };
  try {
    // Simulate running with the host dealer's environment sourced.
    process.env.INVENTORY_LIST_URLS = "https://example-host-dealer.example.com/list";
    process.env.INVENTORY_SITE_DOMAIN = "example-host-dealer.example.com";
    process.env.INVENTORY_XML_URL = "https://example-host-dealer.example.com/inventory/xml";
    process.env.DEALER_ID = "hostdealer";
    delete process.env.DEALER_SLUG;

    const result = neutralizeDealerScopedEnv("/tmp/stranger/dealer_profile.json");

    // Everything that was set gets reported as cleared; what was absent is not claimed.
    for (const name of ["INVENTORY_LIST_URLS", "INVENTORY_SITE_DOMAIN", "INVENTORY_XML_URL", "DEALER_ID"]) {
      assert.ok(result.cleared.includes(name), `${name} should be reported cleared`);
    }
    assert.ok(!result.cleared.includes("DEALER_SLUG"), "an absent var must not be claimed as cleared");

    // The inventory vars are GONE (not overwritten) so the resolver falls back to the
    // profile-derived, host-filtered path instead of an unconditional operator override.
    assert.equal(process.env.INVENTORY_LIST_URLS, undefined, "INVENTORY_LIST_URLS must be unset, not reassigned");
    assert.equal(process.env.INVENTORY_SITE_DOMAIN, undefined);
    assert.equal(process.env.INVENTORY_XML_URL, undefined);

    // The identity vars are re-pinned to the stranger. DEALER_ID especially: left alone it
    // defaults to the host dealer on the file backend, which is the exact id the legacy
    // inventory-feed default keys on — a stranger would silently read host inventory.
    assert.equal(process.env.DEALER_PROFILE_PATH, "/tmp/stranger/dealer_profile.json");
    assert.equal(process.env.DEALER_ID, STRANGER_DEALER_SLUG);
    assert.equal(process.env.DEALER_SLUG, STRANGER_DEALER_SLUG);
    assert.notEqual(process.env.DEALER_ID, "americanharley", "must never run under the host dealer id");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

check("pinning_list_covers_the_known_vectors", "every env var that can pin a dealer is on the list", () => {
  for (const name of [
    "INVENTORY_LIST_URLS", // the false-alarm vector: unconditional operator override
    "INVENTORY_XML_URL",
    "INVENTORY_SITE_DOMAIN",
    "DEALER_ID", // the false-clean vector: defaults to the host dealer on the file backend
    "DEALER_SLUG",
    "DEALER_PROFILE_PATH"
  ]) {
    assert.ok(
      (DEALER_PINNING_ENV_VARS as readonly string[]).includes(name),
      `${name} must be neutralized — it pins the run to a specific dealer`
    );
  }
});

// --- 6. The report contract the scorecard reads. ---------------------------
check("report_contract", "the payload carries exactly what rollout_readiness reads", () => {
  const result = gradeStrangerTest({
    mode: "live",
    probes: [cleanProbe],
    leaks: [],
    fallbackSites: goodAudit,
    at: "2026-07-30T12:34:56.000Z"
  });
  // scripts/rollout_readiness_report.ts reads { passed, at, detail } off this file.
  assert.equal(typeof result.passed, "boolean", "passed must be a boolean");
  assert.equal(result.at, "2026-07-30T12:34:56.000Z", "at must be the run timestamp, verbatim");
  assert.equal(typeof result.detail, "string", "detail must be a string");
  assert.ok(result.detail.length > 0, "detail must never be empty — an empty string reads as no reason");
  // Round-trips through JSON exactly as written to disk.
  const round = JSON.parse(JSON.stringify(result));
  assert.equal(round.passed, result.passed);
  assert.equal(round.at, result.at);
  assert.equal(round.detail, result.detail);
});

const failed = checks.filter(c => !c.ok);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.id} — ${c.note}`);
console.log(`\nstranger_dealer_test:eval — ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
