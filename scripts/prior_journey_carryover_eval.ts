/**
 * prior_journey_carryover:eval — a returning customer's NEW thread remembers the sale it grew out of.
 *
 * Joe, 2026-08-18: *"how are we going to handle leads that are closed that may re-engage to buy
 * another bike or trade theirs in… without starting a double thread? That may get a little
 * confusing."*
 *
 * THE ROUTING WAS ALREADY RIGHT AND IS NOT UNDER TEST HERE. A sold/held thread that receives an
 * explicit buying signal opens a NEW journey thread, gated by the typed `parseJourneyIntentWithLLM`
 * (explicitRequest + confidence >= 0.68). Audited on the live store 2026-08-18: it has fired **4
 * times and was correct 4 times** — three triggered by a fresh lead form, one by *"Do u by chance
 * have any used street glides?"*. Two threads is the right model: a finished sale and a new
 * shopping trip run on different clocks, and merging them risks overwriting the completed sale
 * record (a second sold signal has already wiped `conv.sale` once and replayed post_sale from day 1).
 *
 * WHAT WAS BROKEN IS AMNESIA. Christopher Szczesny's new thread `+17169400722::2` carried his
 * salesperson and nothing else — no record he bought a 2021 Road Glide Special from Scott four days
 * earlier, no link to the 209-message thread beside it. An operator filed exactly that confusion.
 *
 * AND THE TWO CREATION PATHS HAD DRIFTED: SMS carried `leadOwner` AND the lead profile; the ADF
 * path — which produced THREE of the four splits — carried `leadOwner` alone. Both now go through
 * one helper, which is the half of this an eval must hold, because a second copy is how they got
 * out of sync in the first place.
 *
 * Deterministic: pure functions executed over realistic shapes, no LLM, no clock, no network.
 *
 * Run: npx tsx scripts/prior_journey_carryover_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import {
  buildPriorJourneyRecord,
  applyPriorJourneyCarryOver,
  buildPriorJourneyDraftFact
} from "../services/api/src/domain/priorJourney.js";
const { priorJourneyPillLabel, priorJourneyDetail, formatSoldOn } = await import(
  "../apps/web/src/app/lib/priorJourneyLabel.ts"
);

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

/** Christopher's real shape, from the live store. */
const SOLD_THREAD = {
  id: "+17169400722",
  status: "closed",
  closedReason: "sold",
  messages: new Array(209).fill({ direction: "in", body: "x" }),
  leadOwner: { id: "479f56d0", name: "Scott Hartrich" },
  lead: { name: "Christopher Szczesny", email: "c@example.com", walkInComment: "came in Saturday" },
  sale: {
    soldAt: "2026-08-14T17:00:48.352Z",
    soldByName: "Scott Hartrich",
    stockId: "U900-21",
    vin: "1HD1KTP17MB658115",
    label: "2021 Harley-Davidson FLTRXS Road Glide Special"
  }
};

// ---------------------------------------------------------------------------
// 1. THE RECORD — what the new thread remembers.
// ---------------------------------------------------------------------------
const rec = buildPriorJourneyRecord(SOLD_THREAD);
ok(rec !== null, "a sold thread must produce a prior-journey record");
ok(rec?.conversationId === "+17169400722", "it must link back to the thread the sale lives on");
ok(rec?.label === "2021 Harley-Davidson FLTRXS Road Glide Special", "and name the bike they bought");
ok(rec?.soldByName === "Scott Hartrich", "and who sold it — the person they already know");
ok(rec?.messageCount === 209, "and how much conversation is on the other thread");
ok(rec?.vin === "1HD1KTP17MB658115", "the VIN rides along — it is the trade-in's identity");

// A sale with no pre-built label still names the bike rather than saying nothing.
ok(
  buildPriorJourneyRecord({
    id: "+1555", closedReason: "sold",
    sale: { soldAt: "2026-01-01T00:00:00Z", year: "2019", make: "Harley-Davidson", model: "Street Glide" }
  })?.label === "2019 Harley-Davidson Street Glide",
  "a sale without a stored label assembles one from its parts"
);

// ---------------------------------------------------------------------------
// 2. FAIL DIRECTION — say nothing rather than claim a purchase that did not happen. Everything here
//    is shown to staff and (next slice) handed to the drafter as FACT.
// ---------------------------------------------------------------------------
ok(
  buildPriorJourneyRecord({ id: "+1555", status: "closed", closedReason: "not_interested" }) === null,
  "a thread closed NOT INTERESTED is not a previous purchase and must yield nothing"
);
ok(
  buildPriorJourneyRecord({ id: "+1555", status: "open" }) === null,
  "an open thread with no sale yields nothing"
);
ok(buildPriorJourneyRecord(null) === null, "no prior thread yields nothing rather than throwing");
ok(buildPriorJourneyRecord({ closedReason: "sold" }) === null, "no conversation id ⇒ nothing to link to ⇒ nothing");

// ---------------------------------------------------------------------------
// 3. THE CARRY-OVER — what a new journey inherits, and what it must NOT.
// ---------------------------------------------------------------------------
const created: any = { status: "closed", closedAt: "2026-08-14T17:00:48.352Z", closedReason: "sold" };
applyPriorJourneyCarryOver(created, SOLD_THREAD as any);
ok(created.priorJourney?.label?.includes("Road Glide"), "the new thread remembers the purchase");
ok(created.leadOwner?.name === "Scott Hartrich", "and keeps the salesperson they already know");
ok(created.lead?.name === "Christopher Szczesny", "and the lead profile — the ADF path was missing this");
ok(created.status === "open", "the new journey is OPEN");
ok(created.closedAt === undefined && created.closedReason === undefined, "and carries none of the old close state");
// The walk-in comment describes a showroom visit about the bike they ALREADY OWN. Carrying it would
// have the agent reference a conversation that belongs to the finished deal.
ok(created.lead?.walkInComment === undefined, "the previous deal's walk-in comment must NOT ride along");
// The sale itself belongs to the completed deal. Copying it is how a second sold signal overwrote
// conv.sale and replayed the owner sequence from day one.
ok(created.sale === undefined, "the SALE record must not be copied onto the new journey");
ok(created.messages === undefined, "nor the old messages — the new thread starts clean and merely REMEMBERS");

// ---------------------------------------------------------------------------
// 4. THE WORDS a human reads. Fail direction: say less, never guess.
// ---------------------------------------------------------------------------
ok(
  priorJourneyPillLabel(rec) === "Bought 2021 Harley-Davidson FLTRXS Road Glide Special",
  `the pill names the bike (got ${JSON.stringify(priorJourneyPillLabel(rec))})`
);
ok(
  priorJourneyPillLabel({ conversationId: "+1555" }) === "Returning customer",
  "with no bike on record it says Returning customer rather than inventing one"
);
ok(priorJourneyPillLabel(null) === null, "and with no prior journey the row shows no pill at all");
const detail = priorJourneyDetail(rec) ?? "";
for (const fragment of ["Road Glide Special", "from Scott Hartrich", "209 earlier messages"]) {
  ok(detail.includes(fragment), `the tooltip must carry "${fragment}" — got ${JSON.stringify(detail)}`);
}
ok(formatSoldOn("not-a-date") === "", "an unusable sale date renders nothing rather than Invalid Date");
ok(formatSoldOn(null) === "", "and so does a missing one");
ok(
  (priorJourneyDetail({ conversationId: "+1555", messageCount: 1 }) ?? "").includes("1 earlier message"),
  "one message is singular"
);

// ---------------------------------------------------------------------------
// 5. WIRING — BOTH creation paths, or the two drift again. This is the assertion that matters most:
//    the ADF path produced three of the four real splits and had the thinner copy.
// ---------------------------------------------------------------------------
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
ok(
  index.includes("applyPriorJourneyCarryOver(created, latest);"),
  "the SMS re-engagement path must use the shared carry-over"
);
ok(
  sendgrid.includes("applyPriorJourneyCarryOver(conv, latestByLead);"),
  "and so must the ADF path — three of the four live splits came through it"
);
// The hand-written copies must be GONE, not merely joined by the helper.
ok(
  !/created\.leadOwner = latest\.leadOwner \? \{ \.\.\.latest\.leadOwner \} : undefined;/.test(index),
  "the SMS path's hand-written carry-over must be replaced, not duplicated"
);
ok(
  !/conv\.leadOwner = latestByLead\.leadOwner \? \{ \.\.\.latestByLead\.leadOwner \} : undefined;/.test(sendgrid),
  "and the ADF path's too"
);
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
ok(store.includes("priorJourney: c.priorJourney ?? null,"), "the listing must expose it or the console cannot show it");
const inbox = fs.readFileSync("apps/web/src/app/components/InboxSection.tsx", "utf8");
ok(inbox.includes("c.priorJourney ?"), "the inbox row must render the returning-customer pill");
ok(
  inbox.includes("priorJourneyDetail(c.priorJourney)"),
  "and hang the full detail off it, from the pinned formatter"
);

// ---------------------------------------------------------------------------
// 6. THE FACT HANDED TO THE DRAFTER. Without this the agent greets a customer with 209 messages
//    and a bike in his garage as a stranger — the prompt's only signal is "First outbound message:
//    yes", which is true of every re-engagement thread by construction.
// ---------------------------------------------------------------------------
const fact = buildPriorJourneyDraftFact(rec);
ok(fact.includes("ALREADY BOUGHT"), "the drafter must be told this customer already bought");
ok(fact.includes("2021 Harley-Davidson FLTRXS Road Glide Special"), "and which bike — it is the likely trade-in");
ok(fact.includes("Scott Hartrich"), "and who sold it, so the reply can reference the person they know");
ok(/do not introduce yourself/i.test(fact), "and must be told NOT to introduce itself again");
ok(/do not ask what they currently ride/i.test(fact), "and NOT to ask what they ride — it is on the invoice");

// FAIL DIRECTION: everything above is asserted to a customer as TRUE, so no bike name ⇒ say nothing.
ok(buildPriorJourneyDraftFact(null) === "none", "no prior journey ⇒ the prompt block reads none");
ok(
  buildPriorJourneyDraftFact({ conversationId: "+1555" }) === "none",
  "a record with no bike NAME must not claim a purchase we cannot name"
);
ok(
  buildPriorJourneyDraftFact({ conversationId: "+1555", soldByName: "Scott" }) === "none",
  "a salesperson alone is not a purchase"
);

// WIRING: the block must be in the prompt and fed from the context, at every draft site.
const draft = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
ok(
  draft.includes("${buildPriorJourneyDraftFact(ctx.priorJourney)}"),
  "the prompt must render the fact from the context, not a hand-built string"
);
ok(
  /Returning customer \(TRUE, from our own sale record/.test(draft),
  "and label it as fact so the composer states it rather than hedging"
);
const orch = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");
ok(
  orch.includes("priorJourney: ctx?.priorJourney ?? null,"),
  "the draft context must carry it or the prompt block is always none (the #723 inert-fix class)"
);
ok(
  index.includes("priorJourney: conv.priorJourney ?? null,"),
  "and the orchestrator context must be fed from the conversation"
);

console.log(`prior_journey_carryover:eval OK (${checks} assertion(s))`);
