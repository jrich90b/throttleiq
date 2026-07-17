/**
 * Dealer-identity fallback eval (identity/persona fallback sweep, 2026-07-17).
 *
 * Pins the shared identity accessors in services/api/src/domain/agentVoice.ts so
 * fail paths can never leak a hardcoded AH-era persona or dealership literal into
 * another dealer's messages/pages:
 *   1. resolveDealerAgentName returns the CONFIGURED profile agentName when set.
 *   2. When unset, it returns the neutral generic — never a baked-in persona.
 *   3. buildPersonaSelfIntroPattern builds the "this is {agent}" matcher from the
 *      configured name (metachar-escaped, case-insensitive, multi-word tolerant)
 *      and matches ONLY that name; null when there is no configured name.
 *   4. buildMarketingUnsubscribeFooter (the /public/marketing/unsubscribe footer)
 *      uses the profile dealerName, generic fallback when unset.
 *   5. Source tripwire: no quoted persona-name fallback literal may reappear in
 *      services/api/src outside the dealer seed generator.
 *
 * Fully fixture-driven — no dealer-output fact is asserted (per-dealer gate safe).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  GENERIC_AGENT_DISPLAY_NAME,
  GENERIC_DEALER_DISPLAY_NAME,
  buildMarketingUnsubscribeFooter,
  buildPersonaSelfIntroPattern,
  resolveDealerAgentName
} from "../services/api/src/domain/agentVoice.ts";

// Fictional fixture profile — deliberately NOT any live dealer's config, and the
// agent name is deliberately not a legacy fallback persona.
const fixtureProfile = { agentName: "Danielle Ortiz", dealerName: "Lakeside Cycle Works" };
const legacyPersonaTell = /\b(alexandra|brooke)\b/i;

// ── (a) The accessor returns the configured agentName when set.
assert.equal(resolveDealerAgentName(fixtureProfile), fixtureProfile.agentName);
assert.equal(resolveDealerAgentName({ agentName: "  Sam  " }), "Sam", "accessor trims whitespace");

// ── (b) Generic fallback when unset — and the generic is neutral, never a persona.
for (const missing of [null, undefined, {}, { agentName: "" }, { agentName: "   " }, { agentName: null }]) {
  assert.equal(
    resolveDealerAgentName(missing as any),
    GENERIC_AGENT_DISPLAY_NAME,
    `unset profile ${JSON.stringify(missing)} must resolve to the neutral generic`
  );
}
assert.ok(
  !legacyPersonaTell.test(GENERIC_AGENT_DISPLAY_NAME),
  "the generic agent fallback must not be a legacy persona name"
);
assert.ok(
  !legacyPersonaTell.test(GENERIC_DEALER_DISPLAY_NAME),
  "the generic dealer fallback must not contain a legacy persona name"
);
// An explicit caller-supplied fallback still wins over the generic.
assert.equal(resolveDealerAgentName(null, "the sales desk"), "the sales desk");

// ── (c) Persona self-intro pattern is built from the CONFIGURED name.
const fixturePattern = buildPersonaSelfIntroPattern(fixtureProfile.agentName);
assert.ok(fixturePattern, "a configured agent name must yield a pattern");
assert.ok(
  fixturePattern!.test(`Hi Sam — this is Danielle Ortiz at Lakeside Cycle Works.`),
  "pattern must match the configured agent's self-intro"
);
assert.ok(fixturePattern!.test("THIS IS DANIELLE ORTIZ here"), "pattern must be case-insensitive");
assert.ok(fixturePattern!.test("this is Danielle  Ortiz"), "pattern must tolerate flexible whitespace in multi-word names");
assert.ok(!fixturePattern!.test("this is Danielle Ortizman"), "pattern must respect the trailing word boundary");
assert.ok(!fixturePattern!.test("this is Rachel at Lakeside Cycle Works"), "pattern must NOT match a different name");
assert.ok(
  !fixturePattern!.test("hi, it was great meeting Danielle Ortiz"),
  "pattern must require the self-intro frame, not the bare name"
);
// A pre-sweep persona intro from ANOTHER store's persona must not match this dealer's pattern.
assert.ok(!fixturePattern!.test("this is alexandra at the shop"), "another persona's intro must not match");

// Regex metacharacters in a configured name are escaped, not interpreted.
const trickyPattern = buildPersonaSelfIntroPattern("D.J. (Danny)");
assert.ok(trickyPattern, "a metachar-heavy name must still yield a pattern");
assert.ok(trickyPattern!.test("Hey, this is D.J. (Danny) over here"), "escaped metachars must still match literally");
assert.ok(!trickyPattern!.test("Hey, this is DXJX (Danny) over here"), "an escaped dot must not act as a wildcard");

// No configured name → no pattern (no persona to protect; callers skip the check).
assert.equal(buildPersonaSelfIntroPattern(""), null);
assert.equal(buildPersonaSelfIntroPattern("   "), null);
assert.equal(buildPersonaSelfIntroPattern(null), null);
assert.equal(buildPersonaSelfIntroPattern(undefined), null);

// ── (d) Unsubscribe footer: profile dealerName when set, generic when not.
assert.equal(buildMarketingUnsubscribeFooter(fixtureProfile.dealerName), fixtureProfile.dealerName);
assert.equal(buildMarketingUnsubscribeFooter("  Lakeside Cycle Works  "), "Lakeside Cycle Works");
for (const missing of ["", "   ", null, undefined]) {
  assert.equal(
    buildMarketingUnsubscribeFooter(missing as any),
    GENERIC_DEALER_DISPLAY_NAME,
    "an unset dealerName must fall back to the neutral generic"
  );
}

// ── (5) Source tripwire — quoted persona-fallback literals must not creep back into
// services/api/src. The dealer seed generator is the single allowed mention (it seeds a
// NEW dealer's editable profile value, not a runtime fail-path fallback).
const SRC_ROOT = path.join("services", "api", "src");
const ALLOWED_FILES = new Set<string>([path.join(SRC_ROOT, "domain", "dealerRuntimePackage.ts")]);
const PERSONA_LITERAL = /"(?:Alexandra|Brooke)"/;
const offenders: string[] = [];
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith(".ts") && !ALLOWED_FILES.has(full)) {
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (PERSONA_LITERAL.test(line)) offenders.push(`${full}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
};
walk(SRC_ROOT);
assert.equal(
  offenders.length,
  0,
  `hardcoded persona-name fallback literals must not reappear in services/api/src:\n${offenders.join("\n")}`
);

console.log(
  "PASS dealer identity fallback — accessor honors profile agentName, neutral generics on fail paths, persona-intro pattern is config-driven, unsubscribe footer is profile-driven, 0 persona literals in src"
);
