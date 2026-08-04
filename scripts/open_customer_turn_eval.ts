/**
 * open_customer_turn:eval — the customer's OPEN TURN is every message they sent that we have not
 * answered yet, and the draft composer must see all of it.
 *
 * Pins Joe's 2026-08-04 report: *"If the customer asks multiple questions before the draft is sent,
 * it won't answer previous questions."* Both draft paths composed against ONE message (live:
 * `event.body`; regenerate / thumbs-down re-draft: the last inbound), so anything said earlier was
 * demoted to background history and went unanswered. Fixtures 1-3 are the reproduced live cases.
 *
 * The invariant that carries the bug: a PENDING DRAFT DOES NOT CLOSE A TURN. That is the whole of
 * "before the draft is sent" — an unsent `draft_ai` row is a proposal the customer never saw.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOpenTurnInquiry,
  collectOpenCustomerTurn,
  hasMultiMessageOpenTurn,
  OPEN_TURN_MAX_MESSAGES
} from "../services/api/src/domain/openCustomerTurn.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err?.message ?? err}`);
  }
}

const inb = (body: string, at = "2026-08-04T12:00:00.000Z") => ({ direction: "in", provider: "twilio", body, at });
const sent = (body: string, at = "2026-08-04T12:00:00.000Z") => ({ direction: "out", provider: "twilio", body, at });
const draft = (body: string, at = "2026-08-04T12:00:00.000Z") => ({ direction: "out", provider: "draft_ai", body, at });

console.log("open_customer_turn:eval");

// ---------------------------------------------------------------------------------------------
// The reproduced production cases. Each is a real thread where the reply answered only the newest
// message; the assertion is that the composer would now be handed BOTH asks.
// ---------------------------------------------------------------------------------------------

check("+17163390288 (7/19) — photos + service history + mods, then a follow-on, both stay open", () => {
  const msgs = [
    sent("Sure — what would you like to know?"),
    inb("Photos, service history, any known mods/upgrades from stock?"),
    inb("More than what's listed on the site")
  ];
  const turn = collectOpenCustomerTurn(msgs);
  assert.equal(turn.length, 2, "both customer messages are still open");
  const inquiry = buildOpenTurnInquiry(msgs);
  assert.ok(/mods\/upgrades/.test(inquiry), "the photos/service-history/mods ask must reach the composer");
  assert.ok(/More than what's listed/.test(inquiry), "the follow-on must reach the composer too");
});

check("+17163591526 (7/9) — a photo request followed by a credit ADF: the photo ask is not dropped", () => {
  const msgs = [
    sent("Go ahead and send that over whenever you're ready."),
    inb("Sent... do you have any pictures of the road king?"),
    inb("WEB LEAD (ADF)\nSource: HDFS COA Online\nRef: 11606\nName: William Indelicato")
  ];
  const inquiry = buildOpenTurnInquiry(msgs);
  assert.ok(/pictures of the road king/i.test(inquiry), "the picture request must survive the ADF that landed after it");
  assert.ok(/HDFS COA Online/.test(inquiry), "the credit application is still part of the open turn");
});

check("+17166035402 (7/7) — the delivery question is not lost behind a thank-you", () => {
  const msgs = [
    sent("Your bike is in the shop for the final once-over."),
    inb("Thank you "),
    inb("Good afternoon Mr stone, I should have the balance when delivered.  And can you deliver my bike to my house?")
  ];
  const inquiry = buildOpenTurnInquiry(msgs);
  assert.ok(/deliver my bike to my house/i.test(inquiry), "the delivery question must reach the composer");
});

// ---------------------------------------------------------------------------------------------
// The load-bearing invariant: an unsent draft is not an answer.
// ---------------------------------------------------------------------------------------------

check("a PENDING DRAFT between two customer messages does not close the turn", () => {
  const msgs = [
    sent("Happy to help."),
    inb("What's the out-the-door price?"),
    draft("Ballpark, you're around $560-$1,020/mo at 60 months."),
    inb("And do you have it in black?")
  ];
  const turn = collectOpenCustomerTurn(msgs);
  assert.equal(turn.length, 2, "the unsent draft is a proposal, not a reply — both asks stay open");
  const inquiry = buildOpenTurnInquiry(msgs);
  assert.ok(/out-the-door price/i.test(inquiry) && /in black/i.test(inquiry), "both asks reach the composer");
});

check("a SENT reply between two customer messages DOES close the turn", () => {
  const msgs = [
    inb("What's the out-the-door price?"),
    sent("It's $29,399 before tax and fees."),
    inb("And do you have it in black?")
  ];
  const turn = collectOpenCustomerTurn(msgs);
  assert.equal(turn.length, 1, "the answered question is closed");
  assert.equal(buildOpenTurnInquiry(msgs), "And do you have it in black?", "only the open ask remains");
});

check("an undelivered outbound (delivered:false) does not close the turn", () => {
  const msgs = [
    inb("Is it still available?"),
    { direction: "out", provider: "twilio", body: "Yes it is!", delivered: false, at: "2026-08-04T12:00:00.000Z" },
    inb("And what's the mileage?")
  ];
  assert.equal(collectOpenCustomerTurn(msgs).length, 2, "a send that never landed answered nothing");
});

check("a placed voice call DOES close the turn; our own call notes do not", () => {
  const called = [
    inb("Can you call me?"),
    { direction: "out", provider: "voice_call", body: "Call initiated to +17165550123.", at: "2026-08-04T12:00:00.000Z" },
    inb("Thanks, talk then")
  ];
  assert.equal(collectOpenCustomerTurn(called).length, 1, "a real call reached the customer");

  const notesOnly = [
    inb("Can you call me?"),
    { direction: "out", provider: "voice_summary", body: "Voicemail — not contacted.", at: "2026-08-04T12:00:00.000Z" },
    inb("Still waiting")
  ];
  assert.equal(collectOpenCustomerTurn(notesOnly).length, 2, "a voicemail NOTE is not contact — both stay open");
});

// ---------------------------------------------------------------------------------------------
// No-op on ordinary traffic: the single-message turn must be byte-identical to today's input.
// ---------------------------------------------------------------------------------------------

check("a single-message turn is returned VERBATIM (no wrapper, no relabelling)", () => {
  const body = "Do you have the 2026 Road Glide in stock?";
  assert.equal(buildOpenTurnInquiry([sent("Hi there!"), inb(body)]), body);
  assert.equal(hasMultiMessageOpenTurn([sent("Hi there!"), inb(body)]), false);
});

check("no open turn at all yields empty, so every call site falls back to its own inbound", () => {
  assert.equal(buildOpenTurnInquiry([inb("Hi"), sent("Hello!")]), "");
  assert.equal(buildOpenTurnInquiry([]), "");
  assert.equal(buildOpenTurnInquiry(null), "");
  assert.equal(buildOpenTurnInquiry(undefined as any), "");
});

check("blank/whitespace inbound rows are ignored, never emitted as an empty ask", () => {
  const msgs = [sent("Hi"), inb("   "), inb("Is it available?")];
  assert.equal(buildOpenTurnInquiry(msgs), "Is it available?");
});

// ---------------------------------------------------------------------------------------------
// Prompt guards degrade toward today's behaviour (keep the NEWEST), never away from it.
// ---------------------------------------------------------------------------------------------

check("the message cap keeps the NEWEST messages", () => {
  const msgs = [sent("Hi"), ...Array.from({ length: 12 }, (_, i) => inb(`question ${i + 1}`))];
  const inquiry = buildOpenTurnInquiry(msgs);
  assert.ok(inquiry.includes("question 12"), "the newest ask is always kept");
  assert.ok(!inquiry.includes("question 1\n") && !/\(1\) question 1$/m.test(inquiry), "the oldest overflow is dropped");
  const numbered = inquiry.split("\n").filter(l => /^\(\d+\) /.test(l));
  assert.equal(numbered.length, OPEN_TURN_MAX_MESSAGES, `caps at ${OPEN_TURN_MAX_MESSAGES} messages`);
});

check("a single enormous message is never truncated away to nothing", () => {
  const huge = "x".repeat(9000);
  const msgs = [sent("Hi"), inb("short one"), inb(huge)];
  const inquiry = buildOpenTurnInquiry(msgs);
  assert.ok(inquiry.includes(huge), "the newest message survives the char guard intact");
});

check("the multi-message block tells the composer they are ALL still open", () => {
  const inquiry = buildOpenTurnInquiry([sent("Hi"), inb("first ask?"), inb("second ask?")]);
  assert.ok(/NO reply yet/.test(inquiry), "the block states nothing has been answered");
  assert.ok(/Answer ALL of them/.test(inquiry), "the block instructs answering every one");
});

// ---------------------------------------------------------------------------------------------
// Wiring: the fix is worthless in one path only (CLAUDE.md rule 5 — live and regenerate in sync).
// ---------------------------------------------------------------------------------------------

check("both draft paths pass openTurnInquiry, and the composer prefers it over the single message", () => {
  const index = fs.readFileSync(path.join(repoRoot, "services/api/src/index.ts"), "utf8");
  const live = index.indexOf('safeOrchestrateInbound("twilio_inbound"');
  const regen = index.indexOf('safeOrchestrateInbound("regen"');
  assert.ok(live > 0, "the live twilio call site must exist");
  assert.ok(regen > 0, "the regenerate call site must exist");
  assert.ok(
    /openTurnInquiry: buildOpenTurnInquiry\(conv\.messages\)/.test(index.slice(live, live + 1200)),
    "the LIVE path must pass the open turn"
  );
  assert.ok(
    /openTurnInquiry: buildOpenTurnInquiry\(conv\.messages\)/.test(index.slice(regen, regen + 1200)),
    "the REGENERATE path must pass the open turn (both paths stay in sync)"
  );
  assert.ok(
    /inquiry: buildOpenTurnInquiry\(conv\.messages\) \|\| inbound/.test(index),
    "the thumbs-down re-draft must answer the open turn too"
  );

  const orch = fs.readFileSync(path.join(repoRoot, "services/api/src/domain/orchestrator.ts"), "utf8");
  assert.ok(
    /inquiry: String\(ctx\?\.openTurnInquiry \?\? ""\)\.trim\(\) \|\| event\.body/.test(orch),
    "the composer must prefer the open turn and fall back to the triggering message"
  );
});

if (failures) {
  console.error(`\nopen_customer_turn:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("open_customer_turn:eval passed");
