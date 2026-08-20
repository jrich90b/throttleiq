/**
 * The customer names a clock time; the DAY is two turns back — comprehension half.
 *
 * Sibling of manual_outbound_appointment:eval's staff_confirms_time_day_from_context_* fixtures.
 * That one taught the STAFF parser to carry a day the thread already settled (#676, 2026-08-12);
 * this one is the CUSTOMER half, for Paul Harrigan +17169467451 (2026-08-17, operator-reported
 * "This did not seem to book an appointment at 11 today"). "would 11 o'clock be OK?" parsed with
 * day="" — so the todo we minted read `Appointment requested. Requested: 11 o'clock.`, and
 * `parseRequestedDayTime` returns null without a day token. The staff confirm 90 seconds later had
 * nothing to book.
 *
 * WHAT IS ASSERTED, AND WHY IT IS THE DECISION, NOT A LABEL. Only a day that makes the phrase
 * RESOLVE changes anything downstream, and for a same-day visit "today" is the only value that
 * does: `parseRequestedDayTime` sends a bare weekday equal to the current day forward a full week
 * (`if (offset === 0) offset = 7`), and an empty day returns null. So day_contains is the branch
 * the system actually takes, not one spelling among several.
 *
 * FAIL DIRECTION. Three of the six fixtures assert the day stays EMPTY or stays the weekday the
 * thread named. Carrying a day nobody settled would book a wrong day, which is worse than the lost
 * booking this fixes — and the deterministic half (pending_appointment_request_day:eval) pins the
 * past-slot guard that catches a stale carry.
 *
 * Sample size: 6 fixtures, every one an all-or-nothing assertion (any mismatch exits 1). Measured
 * before wiring: 4 consecutive runs, 6/6 each.
 *
 * ⚠️ THAT 4-RUN MEASUREMENT WAS LUCKY, AND THIS GATE WAS A COIN FLIP FOR A DAY (2026-08-20).
 * `weekday_settled_by_the_thread_not_today` — WE propose a weekday, the customer accepts with only a
 * clock time — passed **4 of 8** runs against an untouched origin/main `9afeed2e`. With the retry
 * wrapper that is a red ci:eval for every routine and every human roughly ONE RUN IN FOUR, and it was
 * worse than a flaky test: the LIVE parser was dropping the day half the time on the most common
 * booking shape we have (we offer a day, they answer with a time), which is lost bookings on the
 * metric that binds. Fixed by naming the outbound side explicitly in BOOKING_INTENT_PROMPT_RULES —
 * 8 of 8 after, on the re-cut fixture below.
 *
 * ⚠️ THE FIXTURE IS DELIBERATELY NOT THE FEW-SHOT, AND MUST STAY THAT WAY. The first attempt at the
 * fix added a few-shot of this fixture verbatim. That would have gone green while proving nothing, so
 * the fixture was re-cut to a different instance of the same shape (Wednesday / "yep 4:30 is good" /
 * Fat Bob, against the rule's own Saturday / "yeah 10 works" wording). Measured against the re-cut
 * fixture, that few-shot alone scored **2 of 8** — it had not generalised at all, and the identical
 * fixture would have hidden exactly that. Keep them different or this eval measures recitation.
 *
 * ⚠️ THE PROMPT PROSE AND THE FEW-SHOTS ARE BOTH LOAD-BEARING — do not delete either as "duplicate
 * of the other". Measured 2026-08-19 against this exact fixture set:
 *   rule + few-shots (shipped) .... 6/6
 *   rule only, few-shots removed .. 4/6
 *   few-shots only, rule removed .. 5/6
 *   neither ....................... 3/6   (both production cases fail)
 * So the fixtures genuinely discriminate rule-present from rule-absent, and each half of the prompt
 * carries cases the other misses. This is the opposite of the past-purchase-complaint parser, where
 * either half alone sufficed — the finding does not generalise between parsers, so measure it again
 * before trimming any prompt this eval guards.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Example = {
  id: string;
  note?: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  expected: {
    intent: string;
    explicit_request: boolean;
    day_contains?: string | null;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "booking_intent_day_from_context_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}
if (process.env.LLM_ENABLED !== "1" || process.env.LLM_BOOKING_PARSER_ENABLED !== "1") {
  console.error("LLM_ENABLED=1 and LLM_BOOKING_PARSER_ENABLED=1 are required for this eval.");
  process.exit(1);
}

const examples = JSON.parse(await fs.readFile(dataPath, "utf8")) as Example[];
const { parseBookingIntentWithLLM } = await import("../services/api/src/domain/llmDraft.ts");

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

let total = 0;
let ok = 0;
const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseBookingIntentWithLLM({ text: ex.text, history: ex.history });
  if (!result) {
    mismatches.push(`[${ex.id}] parser returned null`);
    continue;
  }

  const intentMatch = result.intent === ex.expected.intent;
  const explicitMatch = result.explicitRequest === ex.expected.explicit_request;
  const day = norm(result.requested?.day);
  const normalized = norm(result.normalizedText);
  const dayMatch =
    ex.expected.day_contains == null
      ? // The bounded half: no day settled means no day carried, in the field OR smuggled into
        // normalized_text (which is what index.ts falls back to parsing).
        !day && !/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(normalized)
      : day.includes(norm(ex.expected.day_contains)) ||
        normalized.includes(norm(ex.expected.day_contains));

  if (intentMatch && explicitMatch && dayMatch) {
    ok += 1;
    continue;
  }
  mismatches.push(
    [
      `[${ex.id}]`,
      `text="${ex.text}"`,
      `expected=${JSON.stringify(ex.expected)}`,
      `got intent=${result.intent} explicit=${result.explicitRequest}`,
      `got requested=${JSON.stringify(result.requested ?? null)}`,
      `got normalized=${JSON.stringify(result.normalizedText ?? null)}`
    ].join(" | ")
  );
}

console.log(`Booking-intent day-from-context: ${ok}/${total}`);
if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
  process.exit(1);
}
console.log("All checks passed.");
