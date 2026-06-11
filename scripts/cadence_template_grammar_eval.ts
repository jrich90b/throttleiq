import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

// Local copies of the cadence template helpers in services/api/src/index.ts.
// Source-shape assertions below pin the real implementations to these semantics.

function repairFollowUpClauseGrammar(text: string): string {
  return String(text ?? "")
    .replace(/\b(?:on|for) about\b/g, "about")
    .replace(/\s(?:on|for)\s+(and|so)\s/g, " $1 ")
    .replace(/\s(?:on|for)([?.!,])/g, "$1");
}

function renderFollowUpTemplate(template: string, ctx: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(ctx)) {
    out = out.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return repairFollowUpClauseGrammar(out.replace(/\s+/g, " ")).trim();
}

function appendCadenceOffersLine(message: string, offersLine: string): string {
  const base = String(message ?? "").trim();
  const line = String(offersLine ?? "").trim();
  if (!line) return base;
  if (base.includes("{offersLine}")) return base;
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ");
  const url = line.match(/https?:\/\/\S+/i)?.[0]?.replace(/[),.]+$/g, "") ?? "";
  if (url && normalize(base).includes(url.toLowerCase())) return base;
  if (normalize(base).includes(normalize(line))) return base;
  return `${base} ${line}`.trim();
}

const incentivesTemplate =
  "I can also check current incentives{onLabelClause} and send only what applies.{offersLine}";

// No vehicle label: clause renders empty without a dangling preposition
// (production bug: "check current incentives on and send only what applies").
assert.equal(
  renderFollowUpTemplate(incentivesTemplate, { onLabelClause: "", offersLine: "" }),
  "I can also check current incentives and send only what applies."
);

// With a vehicle label: natural "on the <unit>" phrasing
// (production bug: "current incentives on about the Street Glide Limited").
const filled = renderFollowUpTemplate(incentivesTemplate, {
  onLabelClause: " on the 2026 Street Glide Limited",
  offersLine: " Current offers: https://example.com/offers"
});
assert.equal(
  filled,
  "I can also check current incentives on the 2026 Street Glide Limited and send only what applies. Current offers: https://example.com/offers"
);

// Repair pass fixes the legacy broken renders verbatim from production.
assert.equal(
  repairFollowUpClauseGrammar(
    "Hey Mustafa i can check current incentives on and send only what applies."
  ),
  "Hey Mustafa i can check current incentives and send only what applies."
);
assert.equal(
  repairFollowUpClauseGrammar(
    "I can also check current incentives on about the Street Glide Limited and send only what applies."
  ),
  "I can also check current incentives about the Street Glide Limited and send only what applies."
);
assert.equal(
  repairFollowUpClauseGrammar("Want me to keep you posted on?"),
  "Want me to keep you posted?"
);
assert.equal(
  repairFollowUpClauseGrammar("Want a simple side-by-side on so it is easier to compare?"),
  "Want a simple side-by-side so it is easier to compare?"
);

// Repair pass must not touch legitimate prepositions.
for (const untouched of [
  "Want me to keep an eye on similar bikes too?",
  "Hey Sam, any questions on pricing?",
  "If you want to go over the trade on the Street Glide, just let me know.",
  "I can hold one for you and send photos."
]) {
  assert.equal(repairFollowUpClauseGrammar(untouched), untouched);
}

// Offers line never doubles: unrendered placeholder defers to the render pass
// (production bug: "... Current offers: <url> Current offers: <url>").
const offersLine = "Current offers: https://example.com/offers";
assert.equal(
  appendCadenceOffersLine(`${incentivesTemplate}`, offersLine),
  incentivesTemplate.trim()
);
assert.equal(
  appendCadenceOffersLine(
    "Quick check-in. Current offers:  https://example.com/offers",
    offersLine
  ),
  "Quick check-in. Current offers:  https://example.com/offers"
);
assert.equal(
  appendCadenceOffersLine("Quick check-in.", offersLine),
  `Quick check-in. ${offersLine}`
);

// Pin the real implementations.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.doesNotMatch(
  apiSource,
  /\b(?:on|for)\{labelClause\}/,
  "cadence templates must not glue a preposition onto {labelClause} (renders ' about <label>' or empty)"
);
assert.ok(
  (apiSource.match(/const onLabelClause = followUpLabel \? ` on \$\{followUpLabel\}` : "";/g) ?? [])
    .length >= 2,
  "both cadence paths must build onLabelClause"
);
assert.ok(
  (apiSource.match(/const forLabelClause = followUpLabel \? ` for \$\{followUpLabel\}` : "";/g) ?? [])
    .length >= 2,
  "both cadence paths must build forLabelClause"
);
assert.ok(
  (apiSource.match(/onLabelClause,/g) ?? []).length >= 3,
  "every cadence render ctx must carry onLabelClause"
);
assert.match(
  apiSource,
  /function repairFollowUpClauseGrammar\(/,
  "render-time clause grammar repair must exist"
);
assert.match(
  apiSource,
  /return repairFollowUpClauseGrammar\(out\.replace\(\/\\s\+\/g, " "\)\)\.trim\(\);/,
  "renderFollowUpTemplate must apply the clause grammar repair"
);
assert.match(
  apiSource,
  /if \(base\.includes\("\{offersLine\}"\)\) return base;/,
  "appendCadenceOffersLine must defer when the template still has an unrendered {offersLine}"
);
assert.match(
  apiSource,
  /function selectNonRepeatingCadenceMessage\([\s\S]{0,900}?draftStatus !== "stale"/,
  "cadence no-repeat guard must ignore stale drafts when building the recency window"
);
assert.match(
  apiSource,
  /exactRecentNorms\.has\(normalizedCandidate\)/,
  "cadence no-repeat guard must block exact repeats within the wider window"
);

console.log("cadence_template_grammar_eval passed");
