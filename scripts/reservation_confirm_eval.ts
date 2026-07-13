/**
 * Reservation second-look verifier eval (2026-07-13).
 *
 * Production miss (Kody Erhard +17163975098): the primary inbound_reply_action parser
 * intermittently over-read a DEFERRED purchase ("I'll pull the trigger by the end of next
 * week... I'll be getting back ahold of you then") as customer_reservation_request, firing the
 * reservation handoff's expensive side effect (committal draft + owner call task). The narrow
 * verifier (`parseReservationConfirmWithLLM`) re-asks the one question before the handoff fires:
 * did the customer explicitly ask to hold / put aside / deposit on a unit NOW?
 *
 * This eval pins the verifier's coverage in both directions:
 *   - deferred/future purchases, watch asks, and excitement → not_reserve_now (veto)
 *   - explicit reserve/hold/deposit-now asks → reserve_now (handoff proceeds)
 *
 * Run: LLM_ENABLED=1 npx tsx scripts/reservation_confirm_eval.ts
 */
import assert from "node:assert/strict";

import { parseReservationConfirmWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Case = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  expected: "reserve_now" | "not_reserve_now";
};

const LIMITED_RUN_HISTORY: Case["history"] = [
  { direction: "out", body: "The 2026 Street Bob is a limited solo trim run — they move fast." },
  { direction: "out", body: "Hey Kody - just following up with you about the 2026 Street Bob. What are your thoughts?" }
];

const CASES: Case[] = [
  {
    // THE production turn (pinned verbatim).
    id: "deferred_pull_the_trigger_next_week_is_not_reserve_now",
    text: "I'm definitely interested. I should have the money and be in the position to pull the trigger on it by the end of next week. I appreciate your guys time and working with me. I'll be getting back ahold of you then, if you still have one available.",
    history: LIMITED_RUN_HISTORY,
    expected: "not_reserve_now"
  },
  {
    id: "future_money_hope_still_there_is_not_reserve_now",
    text: "Love that bike. Hopefully it's still there when my tax return hits",
    history: LIMITED_RUN_HISTORY,
    expected: "not_reserve_now"
  },
  {
    id: "notify_when_arrives_is_not_reserve_now",
    text: "Can you let me know if one comes in?",
    history: [{ direction: "out", body: "We don't have that one in stock right now." }],
    expected: "not_reserve_now"
  },
  {
    id: "explicit_reserve_ask_is_reserve_now",
    text: "What do I have to do to reserve one",
    history: [
      { direction: "in", body: "I know it's a limited run and I would like to reserve one" },
      { direction: "out", body: "sorry, we don't have the 2026 Superglide in stock right now." }
    ],
    expected: "reserve_now"
  },
  {
    id: "deposit_to_hold_is_reserve_now",
    text: "Can I put a deposit down to hold it?",
    history: LIMITED_RUN_HISTORY,
    expected: "reserve_now"
  },
  {
    id: "hold_one_for_me_is_reserve_now",
    text: "Can you hold one for me until Saturday? I'll come put money down",
    history: LIMITED_RUN_HISTORY,
    expected: "reserve_now"
  }
];

async function main(): Promise<void> {
  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
    console.log("SKIP reservation_confirm eval (LLM disabled or no OPENAI_API_KEY)");
    return;
  }
  const failures: string[] = [];
  for (const c of CASES) {
    const parsed = await parseReservationConfirmWithLLM({ text: c.text, history: c.history });
    if (!parsed) {
      failures.push(`[${c.id}] parser returned null`);
      continue;
    }
    if (parsed.verdict !== c.expected) {
      failures.push(`[${c.id}] expected=${c.expected} got=${parsed.verdict}@${parsed.confidence ?? "?"}`);
      continue;
    }
    console.log(`PASS [${c.id}] verdict=${parsed.verdict}@${parsed.confidence ?? "?"}`);
  }
  assert.deepEqual(failures, [], `reservation_confirm failures:\n${failures.join("\n")}`);
  console.log(`All ${CASES.length} reservation_confirm checks passed.`);
}

await main();
