/**
 * Reply-anchor: price answers talk about the bike under DISCUSSION, never the stale ADF
 * lead record (Joe ruling 2026-07-23, +17166021492 Brian Serena — open_critic finding).
 *
 * Production evidence pinned here: Brian's June ADF lead record said "2026 Street Glide
 * Trike". By late July the live thread was about a used 2019 Tri Glide Ultra the dealer
 * had quoted at $29,995. Brian objected ("no buddy that's too much money. That's way too
 * much money for a 2019.") and the pricing arm replied with a fresh mid-thread
 * self-introduction plus the 2026 Street Glide Trike MSRP range from the stale lead
 * record — the wrong bike, re-quoted, to a customer who just said it was too expensive.
 *
 * Joe ruled the whole family:
 *  1. MSRP/price answers anchor to the bike under discussion THIS TURN (turn > thread >
 *     lead record; ask when nothing resolves) — decidePriceAnswerAnchor.
 *  2. The customer-sourced-color rule extends to ALL sold/hold disclosure branches —
 *     applyCustomerSourcedColorToUnitLabel.
 *  3. Staleness cap on "just sold" announcements — isStaleSoldAnnouncement.
 *  4. A price objection gets an ack + cheaper-unit watch offer, never a sticker re-quote —
 *     decidePriceObjectionTurn + buildPriceObjectionCheaperWatchReply (parser-first via
 *     parsePriceQuoteObjectionWithLLM; this eval pins the pure decision + copy).
 *  Plus: no mid-thread agent re-introduction from the pricing branches.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

process.env.OPENAI_API_KEY ||= "test";
process.env.DEALER_PROFILE_PATH ||= "services/api/data/dealer_profile.json";
delete process.env.LLM_ENABLED; // deterministic run — no LLM arms
const evalDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "throttleiq-reply-anchor-eval-"));
await fs.cp("services/api/data", evalDataDir, { recursive: true });
process.env.DATA_DIR = evalDataDir;

const {
  decidePriceAnswerAnchor,
  decidePriceObjectionTurn,
  isStaleSoldAnnouncement
} = await import("../services/api/src/domain/routeStateReducer.ts");
const { applyCustomerSourcedColorToUnitLabel } = await import(
  "../services/api/src/domain/cadenceAvailabilityDisclosure.ts"
);
const { buildPriceObjectionCheaperWatchReply } = await import(
  "../services/api/src/domain/agentVoice.ts"
);
const { draftAlreadyAcknowledgesHardship } = await import(
  "../services/api/src/domain/hardshipEmpathyAck.ts"
);
const { orchestrateInbound } = await import("../services/api/src/domain/orchestrator.ts");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`FAIL ${name}: ${err?.message ?? err}`);
  }
};

// ── 1. decidePriceAnswerAnchor decision table ─────────────────────────────────────────────
check("anchor: Brian shape — thread contradicts lead, no turn model => thread", () => {
  const d = decidePriceAnswerAnchor({
    turnModel: null,
    threadModel: "Tri Glide Ultra",
    leadModel: "Street Glide Trike",
    threadMatchesLead: false
  });
  assert.equal(d.source, "thread");
});
check("anchor: thread contradicts lead, turn names a model => turn wins", () => {
  const d = decidePriceAnswerAnchor({
    turnModel: "Road Glide",
    threadModel: "Tri Glide Ultra",
    leadModel: "Street Glide Trike",
    threadMatchesLead: false
  });
  assert.equal(d.source, "turn");
});
check("anchor: thread matches lead (shorthand) => lead record keeps existing precedence", () => {
  const d = decidePriceAnswerAnchor({
    turnModel: null,
    threadModel: "Street Glide",
    leadModel: "Street Glide Trike",
    threadMatchesLead: true
  });
  assert.equal(d.source, "lead_record");
});
check("anchor: first-touch ADF (no thread) => lead record unchanged", () => {
  const d = decidePriceAnswerAnchor({
    turnModel: null,
    threadModel: null,
    leadModel: "Road Glide",
    threadMatchesLead: false
  });
  assert.equal(d.source, "lead_record");
});
check("anchor: nothing resolves => ask (fail toward asking, never a wrong quote)", () => {
  const d = decidePriceAnswerAnchor({
    turnModel: null,
    threadModel: null,
    leadModel: null,
    threadMatchesLead: false
  });
  assert.equal(d.source, "ask");
});
check("anchor: no lead record, thread discussed a model => thread", () => {
  const d = decidePriceAnswerAnchor({
    turnModel: null,
    threadModel: "Fat Boy",
    leadModel: null,
    threadMatchesLead: false
  });
  assert.equal(d.source, "thread");
});

// ── 2. decidePriceObjectionTurn decision table ────────────────────────────────────────────
const objectionBase = {
  pricingRoute: true,
  recentOutboundQuotedPrice: true,
  parserPriceObjection: true,
  parserExplicitQuestion: false,
  parserConfidence: 0.94,
  confidenceMin: 0.8
};
check("objection: confident bare objection after our quote => cheaper_watch_offer", () => {
  assert.equal(decidePriceObjectionTurn(objectionBase).kind, "cheaper_watch_offer");
});
check("objection: a concrete question outranks the objection framing => none", () => {
  assert.equal(
    decidePriceObjectionTurn({ ...objectionBase, parserExplicitQuestion: true }).kind,
    "none"
  );
});
check("objection: no recent outbound quote => none (nothing to object to)", () => {
  assert.equal(
    decidePriceObjectionTurn({ ...objectionBase, recentOutboundQuotedPrice: false }).kind,
    "none"
  );
});
check("objection: low confidence => none (fail toward answering)", () => {
  assert.equal(decidePriceObjectionTurn({ ...objectionBase, parserConfidence: 0.5 }).kind, "none");
});
check("objection: parser says not an objection => none", () => {
  assert.equal(
    decidePriceObjectionTurn({ ...objectionBase, parserPriceObjection: false }).kind,
    "none"
  );
});

// ── 3. isStaleSoldAnnouncement ────────────────────────────────────────────────────────────
const nowMs = Date.parse("2026-07-23T12:00:00Z");
check("sold-news: sold 5 days ago => fresh, announce", () => {
  assert.equal(
    isStaleSoldAnnouncement({ soldAtIso: "2026-07-18T12:00:00Z", nowMs }),
    false
  );
});
check("sold-news: sold 3 months ago => stale, no announcement", () => {
  assert.equal(
    isStaleSoldAnnouncement({ soldAtIso: "2026-04-20T12:00:00Z", nowMs }),
    true
  );
});
check("sold-news: unknown soldAt => announce (fail toward disclosure)", () => {
  assert.equal(isStaleSoldAnnouncement({ soldAtIso: null, nowMs }), false);
  assert.equal(isStaleSoldAnnouncement({ soldAtIso: "not-a-date", nowMs }), false);
});
check("sold-news: custom cap respected", () => {
  assert.equal(
    isStaleSoldAnnouncement({ soldAtIso: "2026-07-10T12:00:00Z", nowMs, maxAgeDays: 7 }),
    true
  );
  assert.equal(
    isStaleSoldAnnouncement({ soldAtIso: "2026-07-10T12:00:00Z", nowMs, maxAgeDays: 60 }),
    false
  );
});

// ── 4. applyCustomerSourcedColorToUnitLabel ───────────────────────────────────────────────
check("label color: feed color stripped when the customer never sourced it", () => {
  assert.equal(
    applyCustomerSourcedColorToUnitLabel(
      "2019 Harley-Davidson Tri Glide Ultra in Midnight Blue/Barracuda Silver",
      null
    ),
    "2019 Harley-Davidson Tri Glide Ultra"
  );
});
check("label color: kept when it IS the customer's own color", () => {
  assert.equal(
    applyCustomerSourcedColorToUnitLabel("2026 Street Glide in Dark Billiard Gray", "dark billiard gray"),
    "2026 Street Glide in Dark Billiard Gray"
  );
});
check("label color: stripped when the customer asked about a DIFFERENT color", () => {
  assert.equal(
    applyCustomerSourcedColorToUnitLabel("2026 Street Glide in Teal Thunder", "Dark Billiard Gray"),
    "2026 Street Glide"
  );
});
check("label color: label without a color clause passes through", () => {
  assert.equal(applyCustomerSourcedColorToUnitLabel("2022 Iron 883", null), "2022 Iron 883");
  assert.equal(applyCustomerSourcedColorToUnitLabel("", "black"), "");
});

// ── 5. Price-objection reply copy ─────────────────────────────────────────────────────────
check("objection reply: ack + cheaper-unit watch offer, no dollar figures, no re-intro", () => {
  const withModel = buildPriceObjectionCheaperWatchReply("Tri Glide");
  assert.match(withModel, /keep an eye out for a Tri Glide at a lower price/i);
  assert.doesNotMatch(withModel, /\$|msrp|asking/i);
  assert.doesNotMatch(withModel, /over at|this is /i);
  const generic = buildPriceObjectionCheaperWatchReply(null);
  assert.match(generic, /keep an eye out for something similar at a lower price/i);
});
check("objection reply: opener counts as an ack beat (no hardship double-ack)", () => {
  assert.equal(draftAlreadyAcknowledgesHardship(buildPriceObjectionCheaperWatchReply("Tri Glide")), true);
});

// ── 6. Orchestrator: Brian's turn never re-quotes the stale lead-record bike ─────────────
const now = new Date().toISOString();
const brianHistory: { direction: "in" | "out"; body: string }[] = [
  {
    direction: "in",
    body:
      "WEB LEAD (ADF)\nSource: Marketplace - Prequal\nName: Brian Serena\nYear: 2026\nVehicle: Harley-Davidson Full Line"
  },
  {
    direction: "out",
    body: "Hi Brian- this is Scott from American H-D. Thank you for your time over the phone and I will keep in contact if we come across a pre-owned trike!"
  },
  {
    direction: "out",
    body:
      "Hey Brian, good news — a 2019 Harley-Davidson Tri Glide Ultra in Midnight Blue/Barracuda Silver you were watching for just came in. Are you still looking?"
  },
  { direction: "in", body: "Yes, send me some info" },
  {
    direction: "out",
    body:
      "We just took the bike in on Monday and still waiting for the lien release. It has just under 10,000 miles on it so we will be doing a full service check. We will be asking $29,995"
  }
];
const brianEvent = {
  channel: "sms" as const,
  provider: "twilio" as const,
  from: "+17166021492",
  to: "+17166927200",
  body: "no buddy that's too much money. That's way too much money for a 2019.",
  providerMessageId: "reply-anchor-eval-brian-1",
  receivedAt: now
};
const brianCtx = {
  pricingIntentHint: true,
  primaryIntentHint: "pricing_payments" as any,
  agentNameOverride: "Scott",
  customerReceivedOutbound: true,
  lead: {
    firstName: "Brian",
    source: "Marketplace - Prequal",
    vehicle: {
      year: "2026",
      make: "Harley-Davidson",
      condition: "used",
      description: "Street Glide Trike",
      model: "Street Glide Trike"
    }
  } as any
};

const brianResult = await orchestrateInbound({ ...brianEvent }, [...brianHistory], { ...brianCtx });
check("orchestrator: Brian's objection turn never quotes the stale 2026 Street Glide Trike", () => {
  const draft = String(brianResult?.draft ?? "");
  assert.ok(draft.trim().length > 0, "expected a draft");
  assert.doesNotMatch(draft, /street glide trike/i, `stale lead-record bike leaked: ${draft}`);
  assert.doesNotMatch(draft, /24,999|27,999/, `stale MSRP range leaked: ${draft}`);
});
check("orchestrator: no mid-thread agent re-introduction on an established thread", () => {
  const draft = String(brianResult?.draft ?? "");
  assert.doesNotMatch(
    draft,
    /it[’']s\s+\S+\s+over at|this is\s+\S+\s+at\s/i,
    `mid-thread re-introduction leaked: ${draft}`
  );
});

// First-touch ADF pricing stays anchored to the lead record (existing behavior unchanged).
const adfResult = await orchestrateInbound(
  {
    channel: "sms",
    provider: "sendgrid_adf",
    from: "+15550001111",
    to: "+17166927200",
    body: "What is the price?",
    providerMessageId: "reply-anchor-eval-adf-1",
    receivedAt: now
  },
  [],
  {
    pricingIntentHint: true,
    primaryIntentHint: "pricing_payments" as any,
    lead: {
      firstName: "Sam",
      vehicle: { year: "2025", make: "Harley-Davidson", model: "Road Glide", condition: "new" }
    } as any
  }
);
check("orchestrator: first-touch ADF pricing still anchors to the lead vehicle", () => {
  const draft = String(adfResult?.draft ?? "");
  assert.ok(draft.trim().length > 0, "expected a draft");
  assert.doesNotMatch(draft, /which .*model are you interested in/i, `lead anchor lost: ${draft}`);
});

if (failures > 0) {
  console.error(`\n${failures} reply-anchor check(s) failed.`);
  process.exit(1);
}
console.log("\nreply_anchor_live_conversation eval OK");
