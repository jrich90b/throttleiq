/**
 * First-time-rider precedence eval (pure, no LLM).
 *
 * THE PARSER COULD NEVER SAY NO. Measured over four live days (2026-08-02..05):
 *   48 calls to `first_time_rider_guidance_parser`, **0 accepted, 48 overruled** by the keyword scan.
 * It is only CALLED when `hasFirstTimeRiderGuidanceParserHint` already matched, and only ACCEPTED
 * when `explicitRequest` is true — which it never was on those turns. So its verdict was structurally
 * unusable and the route ran on keywords alone, while we paid for 48 LLM reads and discarded each one.
 *
 * 26 of the 48 were the parser answering `none` at 0.85–0.90 and being overruled anyway. The one that
 * matters: an ADF record reading `Bike Owner: Current, not first motorcycle` — an existing owner,
 * explicitly not a beginner — pulled into the first-time-rider lane because the hint matched the words
 * "first motorcycle". That lane carries the Jumpstart invite, so the customer-facing failure is
 * offering an experienced rider a beginner session.
 *
 * The fix is deliberately NARROW: only `none` blocks the scan. Loosening the acceptance gate instead
 * would make this route fire MORE, and over-offering a beginner session is the costlier direction.
 *
 * Run: npx tsx scripts/first_time_rider_precedence_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveFirstTimeRiderGuidanceSource } from "../services/api/src/domain/inboundPipeline.ts";

type Row = {
  id: string;
  parserAccepted: boolean;
  parsedIntent: string | null;
  hasParse: boolean;
  want: "parser" | "none" | "fallback";
  why: string;
};

const table: Row[] = [
  {
    id: "accepted_parser_wins",
    parserAccepted: true,
    parsedIntent: "first_time_rider",
    hasParse: true,
    want: "parser",
    why: "an accepted parser reading is the answer — unchanged"
  },
  {
    id: "THE_FIX_existing_owner_not_dragged_into_the_beginner_lane",
    parserAccepted: false,
    parsedIntent: "none",
    hasParse: true,
    want: "none",
    why: '"Bike Owner: Current, not first motorcycle" — parser said none at 0.90 and was overruled'
  },
  {
    id: "rider_course_info_unchanged",
    parserAccepted: false,
    parsedIntent: "rider_course_info",
    hasParse: true,
    want: "fallback",
    why: "18 of the 48 — the parser DID see a course topic; behaviour must not change"
  },
  {
    id: "first_time_rider_topic_unchanged",
    parserAccepted: false,
    parsedIntent: "first_time_rider",
    hasParse: true,
    want: "fallback",
    why: "3 of the 48 — hedged but real; narrowing this would silence genuine beginners"
  },
  {
    id: "beginner_bike_advice_unchanged",
    parserAccepted: false,
    parsedIntent: "beginner_bike_advice",
    hasParse: true,
    want: "fallback",
    why: "1 of the 48 — unchanged"
  },
  {
    id: "no_parse_at_all_still_falls_back",
    parserAccepted: false,
    parsedIntent: null,
    hasParse: false,
    want: "fallback",
    why: "parser disabled, keyless or errored — the scan is the only reader left"
  }
];

for (const row of table) {
  const got = resolveFirstTimeRiderGuidanceSource({
    parserAccepted: row.parserAccepted,
    parsedIntent: row.parsedIntent,
    hasParse: row.hasParse
  });
  assert.equal(got, row.want, `${row.id}: expected ${row.want}, got ${got} — ${row.why}`);
}

// The customer-facing halves, stated as behaviour rather than as table rows.
assert.equal(
  resolveFirstTimeRiderGuidanceSource({ parserAccepted: false, parsedIntent: "none", hasParse: true }),
  "none",
  "an experienced owner must not be offered a beginner session because a keyword matched"
);
assert.notEqual(
  resolveFirstTimeRiderGuidanceSource({ parserAccepted: false, parsedIntent: "rider_course_info", hasParse: true }),
  "none",
  "a real riding-course question must still be answered — the easy over-correction is silencing these"
);

// BOTH LANES. The SMS handler and the SendGrid/ADF route each carried their own copy of this
// resolver; a fix in one would have left the other overruling its parser forever.
for (const file of ["services/api/src/index.ts", "services/api/src/routes/sendgridInbound.ts"]) {
  const src = fs.readFileSync(file, "utf8");
  assert.ok(
    src.includes("resolveFirstTimeRiderGuidanceSource"),
    `${file} must resolve precedence through the shared referee, not inline`
  );
  assert.ok(
    !/if \(isFirstTimeRiderGuidanceParserAccepted\(parsed\)\) return parsed;\s*\n\s*return parseFirstTimeRiderGuidanceFallback/.test(src),
    `${file} still has the old shape where a parser "none" falls straight through to the keyword scan`
  );
}

console.log(
  `PASS first-time-rider precedence eval — ${table.length} decision-table rows + beginner-lane protection + both lanes wired`
);
