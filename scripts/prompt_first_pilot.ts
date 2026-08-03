/**
 * PROMPT-FIRST PILOT (Joe, 2026-08-03: "Is there any way to see how this system would work
 * relying more on system prompts?") — an A/B on REAL historical turns, blind-judged.
 *
 * THE QUESTION. Today the split is: 66 typed parsers + 72 deterministic route decisions decide
 * what the customer meant and what to DO; the system prompt decides what to SAY. This measures the
 * alternative: ONE system-prompt call, given the same context and no parser scaffolding, emitting
 * both the reply AND the actions it would take.
 *
 * WHY THIS IS NOT ALREADY ANSWERED. The 880-turn turn_understanding backfill measured letting the
 * LLM own MODEL/SCHEDULE resolution (net win 4.1%, ~75% of the extra signal was over-attachment).
 * That is suggestive but narrower than this question — it never tested a prompt DRIVING the turn.
 *
 * ANTI-RIGGING RULES, because the result is only worth having if the design cannot flatter either
 * arm. Each is a deliberate choice, not an accident:
 *   1. BLIND + ORDER-RANDOMISED. The judge sees "Option 1"/"Option 2" with the arm assignment
 *      shuffled per turn, and is never told which architecture produced which. LLM judges have a
 *      documented position bias, so a fixed order would quietly decide the outcome.
 *   2. SAME INFORMATION. Arm B gets the same lead/vehicle/inventory context the pipeline had. If
 *      it were handed less, this would measure information access, not architecture.
 *   3. CRITERIA FIXED UP FRONT (correctness / compliance / actions), agreed before any run.
 *      Picking metrics after seeing results is how you get the answer you wanted.
 *   4. ACTIONS ARE JUDGED SEPARATELY from prose. A fluent reply that books the wrong thing is the
 *      exact failure this architecture risks, and a single blended score would hide it.
 *   5. ARM A IS WHAT SHIPPED. The real draft the pipeline produced for that turn, in that context —
 *      not a re-run, which would measure today's code against yesterday's conversation.
 *
 * ⚠️ READ THIS BEFORE TRUSTING ANY NUMBER THIS PRINTS — first run, 2026-08-03, 50 real turns.
 *
 * The headline came out 43-7 for prompt-first (correctness 1.82 vs 1.06, compliance 94% vs 68%).
 * THAT RESULT IS AN ARTEFACT. Inspecting the rows showed the judge is scoring conversational
 * EAGERNESS, and the two arms are biased in OPPOSITE directions by the same design flaw:
 *
 *   - THE JUDGE CANNOT VERIFY FACTS. It gets the compressed `leadContext` below, not the inventory
 *     feed / event calendar / pending-incoming records the PIPELINE had. So arm A stating a true
 *     fact it actually knew ("we have one on order, shipping mid-month") is scored as INVENTED,
 *     while arm B staying fluent and vague is scored COMPLIANT. 16 of arm A's 50 turns were marked
 *     non-compliant and the sampled ones are this exact phantom.
 *   - CORRECT PIPELINE BEHAVIOUR SCORES AS UNHELPFUL. The pipeline deliberately defers ("let me
 *     check and come back to you", then opens a task). The judge marks that down for not
 *     answering: arm A averages 0.85 on the 13 deferring turns vs 1.14 elsewhere.
 *   - AND IT REWARDS OVER-ATTACHMENT. "I like the 883, that's what I have right now" — an OWNERSHIP
 *     statement — drew a test-ride offer + inventory watch + follow-up from arm B, and the judge
 *     called it "relevant next steps". That is precisely the failure the 880-turn study found.
 *
 * WHAT SURVIVES THE BIAS (these do not depend on the broken prose comparison, and the judge was
 * tilted in arm B's FAVOUR, so they are floors rather than ceilings):
 *   - 10/50 (20%) of the prompt-first agent's ACTIONS were wrong. In 8 of those the judge praised
 *     the reply anyway.
 *   - It proposed a STATE-CHANGING action (book / watch / close / offer times) on 25 of 50 turns,
 *     and chose to do nothing on 2. An agent that wants to change state on half of all turns is a
 *     wrong-state generator in an inbox where most turns warrant no action at all.
 *
 * TO MAKE THE PROSE NUMBERS MEAN ANYTHING, the judge must be given the same ground truth the
 * pipeline had (inventory feed, events, pending-incoming) so "invented" can be separated from
 * "true but unverifiable by the judge". Until then, read ONLY the action columns.
 *
 * READ-ONLY BY CONSTRUCTION: takes a SNAPSHOT copy of the store, never the live path; no sends, no
 * store writes, no state mutation. Analysis tool — deliberately NOT wired into ci:eval (same
 * standing as turn_understanding_shadow_backfill).
 *
 * Usage:
 *   npx tsx scripts/prompt_first_pilot.ts --self-test          # scaffolding only, no network
 *   OPENAI_API_KEY=... npx tsx scripts/prompt_first_pilot.ts \
 *     --conversations /tmp/snapshot.json [--max 50] [--out-dir reports/prompt_first_pilot]
 */
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

const CUSTOMER_INBOUND = new Set(["twilio", "web_widget", "sendgrid"]);
const AGENT_OUTBOUND = new Set(["draft_ai", "twilio", "sendgrid"]);

function arg(name: string, fb = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fb;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

type Turn = {
  convId: string;
  leadKey: string;
  atIso: string;
  customerText: string;
  history: { who: "customer" | "agent"; text: string; at: string }[];
  leadContext: string;
  armA: string; // what the pipeline actually produced
  /**
   * WHICH KIND of arm A this is, because they are two different comparisons and blending them
   * would quietly bias the result:
   *   "draft_ai" = the agent's RAW output, never touched by a human — the clean architecture A/B.
   *   "sent"     = what actually went to the customer, which in suggest mode may be a STAFF-EDITED
   *                version of that draft. That makes arm A "pipeline + human review", a higher bar.
   * Prod runs in suggest mode so "sent" is the honest real-world baseline, but only "draft_ai"
   * isolates the architectures. Reported separately.
   */
  armASource: "draft_ai" | "sent";
};

// -------------------------------------------------------------------------------------------------
// SAMPLING. A turn qualifies only if the pipeline actually replied to it, because otherwise there
// is no arm A to compare against. Deterministic ordering + an explicit --seed-free stride keeps the
// sample reproducible: cherry-picking turns is the easiest way to rig an A/B without noticing.
// -------------------------------------------------------------------------------------------------
export function selectTurns(conversations: any[], max: number): Turn[] {
  const out: Turn[] = [];
  for (const conv of conversations ?? []) {
    const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
    for (let i = 0; i < msgs.length - 1; i++) {
      const m = msgs[i];
      if (m?.direction !== "in") continue;
      if (!CUSTOMER_INBOUND.has(String(m?.provider ?? "").toLowerCase())) continue;
      const text = String(m?.text ?? m?.body ?? "").trim();
      if (text.length < 8) continue; // bare "ok"/tapbacks carry no decision to compare

      // The agent's response to THIS turn = the next outbound before any further customer message.
      // provider "human" is EXCLUDED: a staff member's own message is not the pipeline's output,
      // and scoring the prompt-first agent against a human would be a different experiment.
      let reply = "";
      let armASource: "draft_ai" | "sent" | "" = "";
      for (let j = i + 1; j < msgs.length; j++) {
        const n = msgs[j];
        if (n?.direction === "in") break;
        if (n?.direction !== "out") continue;
        const provider = String(n?.provider ?? "").toLowerCase();
        if (!AGENT_OUTBOUND.has(provider)) continue;
        reply = String(n?.text ?? n?.body ?? "").trim();
        armASource = provider === "draft_ai" ? "draft_ai" : "sent";
        break;
      }
      if (!reply || !armASource) continue;

      const history = msgs.slice(Math.max(0, i - 10), i).map((h: any) => ({
        who: h?.direction === "in" ? ("customer" as const) : ("agent" as const),
        text: String(h?.text ?? h?.body ?? "").slice(0, 400),
        at: String(h?.at ?? "")
      }));

      const lead = conv?.lead ?? {};
      const v = lead?.vehicle ?? {};
      const leadContext = JSON.stringify({
        name: lead?.firstName ?? lead?.name ?? null,
        vehicleOfInterest: [v?.year, v?.make, v?.model].filter(Boolean).join(" ") || null,
        source: lead?.source ?? null,
        inventoryContext: conv?.inventoryContext ?? null,
        watches: (conv?.inventoryWatches ?? []).map((w: any) => `${w?.year ?? ""} ${w?.model ?? ""}`.trim()),
        appointment: conv?.appointment ?? null,
        status: conv?.status ?? null
      });

      out.push({
        convId: String(conv?.id ?? conv?.leadKey ?? ""),
        leadKey: String(conv?.leadKey ?? ""),
        atIso: String(m?.at ?? ""),
        customerText: text.slice(0, 1200),
        history,
        leadContext,
        armA: reply.slice(0, 1600),
        armASource
      });
    }
  }
  // Even stride across the whole corpus rather than the newest N — recency would over-sample
  // whatever shipped most recently, which is exactly the code arm A is made of.
  if (out.length <= max) return out;
  const stride = out.length / max;
  return Array.from({ length: max }, (_, k) => out[Math.floor(k * stride)]);
}

// -------------------------------------------------------------------------------------------------
// ARM B — the prompt-first agent. ONE call. It must decide what to say AND what to do, because
// "what to do" is where this architecture actually carries risk; a prose-only comparison would
// flatter it by hiding the side-effect decisions behind a human.
// -------------------------------------------------------------------------------------------------
export const PROMPT_FIRST_SYSTEM = `You are the sales agent for American Harley-Davidson, replying to a customer by SMS.

You are the WHOLE system: read what the customer means, decide what to say, and decide what actions the dealership should take. There is no separate parser or router behind you.

Rules you must honour:
- Never claim a unit is in stock, held, sold, or arriving unless the context you were given says so.
- Never invent an event that did not happen (a demo ride taken, a visit made, a call had).
- Never quote a price, payment or rate unless the customer raised money first.
- If someone has opted out or asked to stop, do not message them.
- Service, parts and apparel questions are handed to that department, not answered as sales.
- Keep it short and human, the way a real salesperson texts. No corporate filler.

Return STRICT JSON:
{
  "reply": "the SMS to send, or empty string to stay silent",
  "actions": ["zero or more of: book_appointment, offer_times, start_inventory_watch, hand_to_service, hand_to_parts, close_lead, schedule_followup, notify_staff, none"],
  "reasoning": "one sentence"
}`;

export function buildArmBPrompt(turn: Turn): string {
  const hist = turn.history.map(h => `${h.who === "customer" ? "CUSTOMER" : "AGENT"}: ${h.text}`).join("\n");
  return `LEAD CONTEXT (the only facts you have — anything not here is unknown):
${turn.leadContext}

CONVERSATION SO FAR:
${hist || "(no prior messages)"}

THE CUSTOMER JUST SAID:
${turn.customerText}

Reply as the dealership, and declare the actions you would take.`;
}

// -------------------------------------------------------------------------------------------------
// JUDGING. Blind, order-randomised, criteria fixed in the schema so the judge cannot drift into
// scoring on taste. Actions are scored on arm B ALONE (arm A's actions are not in the transcript),
// which is stated plainly rather than papered over.
// -------------------------------------------------------------------------------------------------
const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["correctness_1", "correctness_2", "compliance_1", "compliance_2", "better", "why", "armB_actions_ok"],
  properties: {
    correctness_1: { type: "integer", minimum: 0, maximum: 2 },
    correctness_2: { type: "integer", minimum: 0, maximum: 2 },
    compliance_1: { type: "boolean" },
    compliance_2: { type: "boolean" },
    better: { type: "string", enum: ["option_1", "option_2", "tie"] },
    armB_actions_ok: { type: "string", enum: ["right", "wrong", "unclear"] },
    why: { type: "string" }
  }
} as const;

export const JUDGE_SYSTEM = `You grade two candidate SMS replies from a Harley-Davidson dealership to a real customer.

Score each option independently, then say which is better overall.

correctness (0-2): 2 = answers what the customer actually asked, no invented facts. 1 = partially answers, or vague. 0 = wrong, evasive, or states something not supported by the context.
compliance (true/false): TRUE only if it invents NO stock/availability/price it was not given, invents NO past event, quotes NO money unprompted, and does not answer a service/parts question as if it were sales.
armB_actions_ok: judge ONLY the declared actions shown for Option B-ACTIONS against what the conversation warranted. "right" = the actions match what should happen. "wrong" = it would book/close/watch something it should not, or miss an obvious one. "unclear" = cannot tell.

Be strict about invented facts. A fluent reply that states something unsupported is WORSE than a plain one that does not.`;

async function judge(client: OpenAI, model: string, turn: Turn, opt1: string, opt2: string, armBActions: string[]) {
  const prompt = `CONVERSATION SO FAR:
${turn.history.map(h => `${h.who === "customer" ? "CUSTOMER" : "AGENT"}: ${h.text}`).join("\n") || "(none)"}

CONTEXT AVAILABLE: ${turn.leadContext}

CUSTOMER SAID: ${turn.customerText}

OPTION 1:
${opt1 || "(stayed silent)"}

OPTION 2:
${opt2 || "(stayed silent)"}

Option B-ACTIONS (declared by whichever option came from the prompt-first agent): ${JSON.stringify(armBActions)}`;

  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: prompt }
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "pilot_judgement", strict: true, schema: JUDGE_SCHEMA as any }
    }
  });
  return JSON.parse(res.choices[0]?.message?.content ?? "{}");
}

// -------------------------------------------------------------------------------------------------
// Deterministic order assignment: arm B lands in slot 1 on even indices, slot 2 on odd. Balanced by
// construction and reproducible, which a random shuffle would not be.
// -------------------------------------------------------------------------------------------------
export function assignSlots(index: number): { armBSlot: 1 | 2 } {
  return { armBSlot: index % 2 === 0 ? 1 : 2 };
}

export function summarise(rows: any[]) {
  const n = rows.length || 1;
  const armA = { correct: 0, compliant: 0, wins: 0 };
  const armB = { correct: 0, compliant: 0, wins: 0 };
  let ties = 0;
  const actions = { right: 0, wrong: 0, unclear: 0 } as Record<string, number>;
  for (const r of rows) {
    const aC = r.armBSlot === 1 ? r.correctness_2 : r.correctness_1;
    const bC = r.armBSlot === 1 ? r.correctness_1 : r.correctness_2;
    const aOk = r.armBSlot === 1 ? r.compliance_2 : r.compliance_1;
    const bOk = r.armBSlot === 1 ? r.compliance_1 : r.compliance_2;
    armA.correct += aC;
    armB.correct += bC;
    armA.compliant += aOk ? 1 : 0;
    armB.compliant += bOk ? 1 : 0;
    const betterSlot = r.better === "option_1" ? 1 : r.better === "option_2" ? 2 : 0;
    if (betterSlot === 0) ties++;
    else if (betterSlot === r.armBSlot) armB.wins++;
    else armA.wins++;
    actions[r.armB_actions_ok] = (actions[r.armB_actions_ok] ?? 0) + 1;
  }
  return {
    turns: rows.length,
    current_pipeline: {
      meanCorrectness: +(armA.correct / n).toFixed(2),
      compliantPct: +((100 * armA.compliant) / n).toFixed(1),
      wins: armA.wins
    },
    prompt_first: {
      meanCorrectness: +(armB.correct / n).toFixed(2),
      compliantPct: +((100 * armB.compliant) / n).toFixed(1),
      wins: armB.wins
    },
    ties,
    prompt_first_actions: actions,
    // Split out because these are two different baselines: raw agent output vs output that a
    // human may already have corrected. Blending them would flatter or punish arm B by accident.
    by_arm_a_source: ["draft_ai", "sent"].reduce((acc: any, src) => {
      const sub = rows.filter(r => r.armASource === src);
      acc[src] = sub.length ? { ...summariseCore(sub), turns: sub.length } : { turns: 0 };
      return acc;
    }, {})
  };
}

/** Core tallies without the recursive split — used for the per-source breakdown. */
function summariseCore(rows: any[]) {
  const n = rows.length || 1;
  let aC = 0, bC = 0, aOk = 0, bOk = 0, aW = 0, bW = 0, ties = 0;
  for (const r of rows) {
    aC += r.armBSlot === 1 ? r.correctness_2 : r.correctness_1;
    bC += r.armBSlot === 1 ? r.correctness_1 : r.correctness_2;
    aOk += (r.armBSlot === 1 ? r.compliance_2 : r.compliance_1) ? 1 : 0;
    bOk += (r.armBSlot === 1 ? r.compliance_1 : r.compliance_2) ? 1 : 0;
    const betterSlot = r.better === "option_1" ? 1 : r.better === "option_2" ? 2 : 0;
    if (betterSlot === 0) ties++;
    else if (betterSlot === r.armBSlot) bW++;
    else aW++;
  }
  return {
    current_pipeline: { meanCorrectness: +(aC / n).toFixed(2), compliantPct: +((100 * aOk) / n).toFixed(1), wins: aW },
    prompt_first: { meanCorrectness: +(bC / n).toFixed(2), compliantPct: +((100 * bOk) / n).toFixed(1), wins: bW },
    ties
  };
}

// -------------------------------------------------------------------------------------------------
if (flag("self-test")) {
  const convs = [
    {
      id: "c1",
      leadKey: "+15550001111",
      lead: { firstName: "Sam", vehicle: { year: 2025, make: "Harley-Davidson", model: "Breakout" } },
      messages: [
        { direction: "in", provider: "twilio", at: "2026-07-01T10:00:00Z", text: "Do you have the breakout in stock still?" },
        { direction: "out", provider: "draft_ai", at: "2026-07-01T10:01:00Z", text: "Let me check and get right back to you." },
        { direction: "in", provider: "twilio", at: "2026-07-02T10:00:00Z", text: "any update on that bike" },
        { direction: "out", provider: "twilio", at: "2026-07-02T10:05:00Z", text: "Still here — want to come see it?" }
      ]
    }
  ];
  const turns = selectTurns(convs, 10);
  console.assert(turns.length === 2, `expected 2 turns, got ${turns.length}`);
  console.assert(turns[0].armA.includes("Let me check"), "arm A must be what the pipeline actually said");
  console.assert(turns[1].history.length === 2, "history must carry the prior exchange");
  console.assert(buildArmBPrompt(turns[0]).includes("Breakout"), "lead context must reach arm B");
  // Slot assignment is balanced, so position bias cannot favour either arm.
  const slots = Array.from({ length: 10 }, (_, i) => assignSlots(i).armBSlot);
  console.assert(slots.filter(s => s === 1).length === 5, "arm B must take slot 1 exactly half the time");
  // Summary must un-blind correctly: arm B in slot 1 winning option_1 counts as an arm B win.
  const s = summarise([
    { armBSlot: 1, correctness_1: 2, correctness_2: 1, compliance_1: true, compliance_2: true, better: "option_1", armB_actions_ok: "right" },
    { armBSlot: 2, correctness_1: 2, correctness_2: 0, compliance_1: true, compliance_2: false, better: "option_1", armB_actions_ok: "wrong" }
  ]);
  console.assert(s.prompt_first.wins === 1 && s.current_pipeline.wins === 1, `un-blinding is wrong: ${JSON.stringify(s)}`);
  console.assert(s.prompt_first.compliantPct === 50, `arm B compliance should be 50%, got ${s.prompt_first.compliantPct}`);
  console.assert(s.current_pipeline.meanCorrectness === 1.5, "arm A correctness un-blinded wrong");
  console.log("PASS prompt_first_pilot self-test — sampling, blinding, un-blinding all check out");
  process.exit(0);
}

(async () => {
  const convPath = arg("conversations");
  if (!convPath) {
    console.error("prompt_first_pilot: --conversations <snapshot.json> is required.\n" +
      "  Pass a COPY of the store, never the live path. Read-only: no sends, no writes.");
    process.exit(2);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("prompt_first_pilot: OPENAI_API_KEY is required (load it from .env).");
    process.exit(2);
  }
  const max = Number(arg("max", "50")) || 50;
  const genModel = process.env.PILOT_GEN_MODEL || "gpt-5-mini";
  const judgeModel = process.env.PILOT_JUDGE_MODEL || "gpt-5";
  const outDir = arg("out-dir", "reports/prompt_first_pilot");

  const raw = JSON.parse(fs.readFileSync(convPath, "utf8"));
  const conversations: any[] = Array.isArray(raw) ? raw : (raw?.conversations ?? []);
  const turns = selectTurns(conversations, max);
  console.log(`prompt_first_pilot: ${conversations.length} conversations -> ${turns.length} comparable turns`);
  console.log(`  arm A = what the pipeline actually sent · arm B = ${genModel} single prompt-first call`);
  console.log(`  judge = ${judgeModel}, blind + order-randomised\n`);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const rows: any[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    try {
      const gen = await client.chat.completions.create({
        model: genModel,
        messages: [
          { role: "system", content: PROMPT_FIRST_SYSTEM },
          { role: "user", content: buildArmBPrompt(turn) }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "prompt_first_reply",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["reply", "actions", "reasoning"],
              properties: {
                reply: { type: "string" },
                actions: { type: "array", items: { type: "string" } },
                reasoning: { type: "string" }
              }
            } as any
          }
        }
      });
      const armB = JSON.parse(gen.choices[0]?.message?.content ?? "{}");
      const { armBSlot } = assignSlots(i);
      const opt1 = armBSlot === 1 ? String(armB.reply ?? "") : turn.armA;
      const opt2 = armBSlot === 1 ? turn.armA : String(armB.reply ?? "");
      const j = await judge(client, judgeModel, turn, opt1, opt2, armB.actions ?? []);
      rows.push({
        convId: turn.convId, leadKey: turn.leadKey, at: turn.atIso,
        customerText: turn.customerText.slice(0, 200),
        armA: turn.armA.slice(0, 300), armB: String(armB.reply ?? "").slice(0, 300),
        armBActions: armB.actions ?? [], armBSlot, armASource: turn.armASource, ...j
      });
      process.stdout.write(`  [${i + 1}/${turns.length}] ${j.better} · armB actions ${j.armB_actions_ok}\n`);
    } catch (e: any) {
      console.error(`  [${i + 1}/${turns.length}] SKIPPED: ${e?.message ?? e}`);
    }
  }

  const summary = summarise(rows);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = String(rows[0]?.at ?? "run").replace(/[^0-9]/g, "").slice(0, 12);
  const outPath = path.join(outDir, `pilot-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2));

  console.log(`\n===== PROMPT-FIRST PILOT (${summary.turns} turns) =====`);
  console.log(`  current pipeline : correctness ${summary.current_pipeline.meanCorrectness}/2 · compliant ${summary.current_pipeline.compliantPct}% · judged better on ${summary.current_pipeline.wins}`);
  console.log(`  prompt-first     : correctness ${summary.prompt_first.meanCorrectness}/2 · compliant ${summary.prompt_first.compliantPct}% · judged better on ${summary.prompt_first.wins}`);
  console.log(`  ties: ${summary.ties}`);
  console.log(`  prompt-first ACTIONS: ${JSON.stringify(summary.prompt_first_actions)}`);
  console.log(`\n  -> ${outPath}`);
  console.log("  NOTE: one judge, one run. Judge self-agreement here is 55-74% (judge-verdicts-are-not-reproducible),");
  console.log("        so treat a margin under ~10 points as noise, not a result.");
})();
