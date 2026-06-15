/**
 * Turn Understanding parser eval (Phase 0 of the comprehension-consolidation
 * plan). Live LLM eval pinning every production miss this approach is meant to
 * make robust: Chuck (multi-model + typo), Todd (owned vs requested bike),
 * Dominik (event-day commitment), Al Davis (day-part carries the day), and the
 * "around 10am" approximate time. Run with a real OPENAI key.
 */
const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim().length < 20 || apiKey.trim() === "...") {
  console.error("OPENAI_API_KEY missing or placeholder; set a real key and re-run.");
  process.exit(1);
}
process.env.LLM_ENABLED = "1";
process.env.LLM_TURN_UNDERSTANDING_PARSER_ENABLED = "1";

const { parseTurnUnderstandingWithLLM } = await import("../services/api/src/domain/llmDraft.ts");

type Case = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  check: (p: any) => string | null; // returns a failure message, or null when ok
};

const families = (p: any): string[] =>
  (p?.requestedModels ?? []).map((m: any) => String(m.family ?? "").toLowerCase());

const cases: Case[] = [
  {
    id: "chuck_multi_model_typo",
    text: "I am mostly interested in a Street Glide, but would also like to ride a Street Gide Limited, if that would be possible",
    check: p => {
      const fams = families(p);
      const sgCount = fams.filter(f => f.includes("street glide")).length;
      if (sgCount < 2 && !(p.requestedModels ?? []).some((m: any) => /limited/i.test(m.trim ?? "")))
        return `expected two Street Glide requests (one Limited), got ${JSON.stringify(p.requestedModels)}`;
      if (p.primaryIntent !== "test_ride") return `intent should be test_ride, got ${p.primaryIntent}`;
      return null;
    }
  },
  {
    id: "todd_owned_vs_requested",
    text: "I picked one but you didn't have what I really wanted. As long as it's a roadglide though at least I can see how they handle compared to my current ultra limited",
    check: p => {
      const fams = families(p);
      if (!fams.some(f => f.includes("road glide")))
        return `requested model should be Road Glide, got ${JSON.stringify(p.requestedModels)}`;
      if (fams.some(f => f.includes("ultra limited")))
        return "Ultra Limited (owned) must NOT be a requested model";
      if (!p.ownedOrTradeModel || !/ultra limited/i.test(p.ownedOrTradeModel.family ?? ""))
        return `owned bike should be Ultra Limited, got ${JSON.stringify(p.ownedOrTradeModel)}`;
      return null;
    }
  },
  {
    id: "dominik_event_day",
    text: "I signed up online for the June 20th event so it'll be that day",
    check: p => {
      if (!p.requestedSchedule) return "expected a requested schedule";
      if (!/june\s*20/i.test(p.requestedSchedule.dayLabel ?? "")) return `day should be June 20, got ${p.requestedSchedule.dayLabel}`;
      if (!p.requestedSchedule.isCommitment) return "should be a commitment";
      return null;
    }
  },
  {
    id: "al_davis_daypart_carry",
    text: "Afternoon would be great",
    history: [
      { direction: "out", body: "I can have our sales team meet you Saturday. Do mornings or afternoons work better for you?" }
    ],
    check: p => {
      if (!p.requestedSchedule) return "expected a requested schedule";
      if (!/saturday/i.test(p.requestedSchedule.dayLabel ?? ""))
        return `day must carry from prior turn (Saturday), got ${p.requestedSchedule.dayLabel}`;
      if (!/afternoon/i.test(p.requestedSchedule.timeText ?? "")) return `time should be afternoon, got ${p.requestedSchedule.timeText}`;
      return null;
    }
  },
  {
    id: "approximate_round_hour",
    text: "Monday, 15 June around 10am",
    history: [{ direction: "out", body: "I can line up the test ride. What day and time works best?" }],
    check: p => {
      if (!p.requestedSchedule) return "expected a requested schedule";
      if (!/(june\s*15|15 june|monday)/i.test(p.requestedSchedule.dayLabel ?? "")) return `day should be June 15, got ${p.requestedSchedule.dayLabel}`;
      if (!/10/.test(p.requestedSchedule.timeText ?? "")) return `time should mention 10, got ${p.requestedSchedule.timeText}`;
      return null;
    }
  },
  {
    id: "opt_out",
    text: "stop texting me please",
    check: p => (p.flags?.isOptOut ? null : "is_opt_out should be true")
  },
  {
    id: "single_availability",
    text: "do you have any road glide specials in stock?",
    check: p => {
      const fams = families(p);
      if (!fams.some(f => f.includes("road glide"))) return `should request Road Glide, got ${JSON.stringify(p.requestedModels)}`;
      if (p.ownedOrTradeModel) return "no owned bike here";
      return null;
    }
  },
  {
    // Relevance guard: a bare thank-you after a model was offered must NOT carry it in.
    id: "relevance_bare_thanks_no_model",
    text: "Thanks Joe",
    history: [{ direction: "out", body: "That Breakout just came in, want to take a look?" }],
    check: p =>
      (p.requestedModels ?? []).length
        ? `bare thanks must not carry the thread model, got ${JSON.stringify(p.requestedModels)}`
        : null
  },
  {
    // Slang/shorthand the deterministic layer misses: "23 lrs" = 2023 Low Rider S.
    id: "slang_lrs_low_rider_s",
    text: "Can you lmk when you get the 23 lrs?",
    check: p =>
      families(p).some(f => f.includes("low rider s"))
        ? null
        : `'23 lrs' should map to Low Rider S, got ${JSON.stringify(p.requestedModels)}`
  },
  {
    // Owned bike stated, nothing requested — owned, not a request.
    id: "owned_883_not_requested",
    text: "I like the 883 that's what I have right now",
    check: p => {
      if ((p.requestedModels ?? []).length) return `owned 883 must not be a request, got ${JSON.stringify(p.requestedModels)}`;
      if (!p.ownedOrTradeModel || !/883/.test(p.ownedOrTradeModel.family ?? "")) return "883 should be owned/trade model";
      return null;
    }
  },
  {
    // Schedule relevance: an en-route ETA is logistics, not a new schedule request.
    // Metric (and Phase-2 booking) key on a DAY-anchored commitment; a lone time
    // with no day is not a bookable request, so we pin no dayLabel + no commitment.
    id: "arrival_eta_no_schedule",
    text: "Heading out, should be there a little after 11:30",
    check: p => {
      const s = p.requestedSchedule;
      if (s && (s.dayLabel ?? "").trim()) return `en-route ETA must not carry a day, got ${JSON.stringify(s)}`;
      if (s && s.isCommitment) return `en-route ETA must not be a scheduling commitment, got ${JSON.stringify(s)}`;
      return null;
    }
  },
  {
    // Schedule relevance: a sign-off after a time is set is not a new schedule request.
    id: "signoff_no_schedule",
    text: "Perfect. See you then.",
    history: [{ direction: "out", body: "Great, you're all set for Saturday at 2." }],
    check: p => {
      const s = p.requestedSchedule;
      const hasSched = s && ((s.dayLabel ?? "").trim() || (s.timeText ?? "").trim());
      return hasSched ? `sign-off must not be a requested_schedule, got ${JSON.stringify(s)}` : null;
    }
  }
];

let pass = 0;
const failures: string[] = [];
for (const c of cases) {
  const parsed = await parseTurnUnderstandingWithLLM({ text: c.text, history: c.history, lead: c.lead });
  if (!parsed) {
    failures.push(`${c.id}: parser returned null`);
    console.log(`FAIL ${c.id}: null parse`);
    continue;
  }
  const msg = c.check(parsed);
  if (msg) {
    failures.push(`${c.id}: ${msg}`);
    console.log(`FAIL ${c.id}: ${msg}`);
  } else {
    pass += 1;
    console.log(`PASS ${c.id}`);
  }
}

console.log(`\nTurn understanding: ${pass}/${cases.length} passed`);
if (failures.length) {
  console.error(`\n${failures.length} failures`);
  process.exit(1);
}
console.log("PASS turn understanding eval");
