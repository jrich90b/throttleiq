/**
 * pipeline_draft_reintroduction:eval
 *
 * Charter **C1.2a** — "the full self-intro belongs on a FIRST touch only; once the customer has
 * received ANY message from us on the thread, never introduce again" — enforced on the PIPELINE's
 * own composed draft, at the universal draft sink (`appendOutbound`, `domain/conversationStore.ts`).
 *
 * WHY THIS EXISTS. #785 (`reviewer_reintroduction_guard:eval`) closed the same hole on the Claude
 * draft-REVIEW lane's free-composed rewrite. The pipeline's composer was never held to it at all.
 * MEASURED 2026-08-21 against the live americanharley store: of 231 standing drafts, 198 sit on a
 * thread where the customer had already received a delivered outbound, and **24 of those 198 opened
 * by re-introducing us** — every single one on the email lane (0 of the SMS drafts). So the SMS half
 * of this guard is provably inert TODAY and exists to keep the lane closed, and the email half is
 * the 12% that was actually going out.
 *
 * The lesson carried over from #785: C1.2a was already written in the prompt and did not stop the
 * model. An invariant about OUR OWN OUTPUT needs a check on the OUTPUT.
 *
 * ⭐ EVERY FIXTURE BELOW IS A VERBATIM LIVE BODY copied out of the store on 2026-08-21. Invented
 * wordings would have passed against whatever pattern I happened to write; these are the shapes the
 * composer actually produces — the greeting on its own line above the intro (daniel), the greeting
 * inline with an em-dash (Aaron, which also carries a SECOND intro further in), a name-less "Hi,"
 * opener (+17165231238), and the "it's <name> over at <dealer>" variant (Jay, Justin).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getDealerProfile } from "../services/api/src/domain/dealerProfile.js";
import { enforceNoReintroduction, stripReintroductionOpener } from "../services/api/src/domain/agentVoice.js";

// ⚠️ ISOLATE THE STORE BEFORE conversationStore IS EVER LOADED. Importing it boots a store rooted at
// DATA_DIR and `scheduleSave()` writes it back — and `data/conversations.json` is one of the seven
// shared files `ci:eval:fast` has to run as a BARRIER precisely because several evals read-modify-write
// it. An eval that quietly saved over the repo's fixture store would corrupt the gate for everyone,
// so the import is dynamic and happens only after DATA_DIR points somewhere disposable.
const SANDBOX = mkdtempSync(path.join(tmpdir(), "pipeline-reintro-eval-"));
process.env.DATA_DIR = path.join(SANDBOX, "data");
process.env.DEALER_PROFILE_PATH = path.join(SANDBOX, "dealer_profile.json");
const { appendOutbound } = await import("../services/api/src/domain/conversationStore.js");

const DEALER = "American Harley-Davidson";

/** A thread the customer has actually heard from us on (a DELIVERED outbound, not a draft). */
const HEARD_FROM_US = [
  { direction: "in", provider: "twilio" },
  { direction: "out", provider: "twilio" }
];
/** A genuine first touch: the only outbound is a draft that reached nobody. */
const FIRST_TOUCH = [
  { direction: "in", provider: "twilio" },
  { direction: "out", provider: "draft_ai" }
];

// --- 1. Live specimens: the intro goes, everything the customer needs stays ---------------------
const LIVE: Array<{ lead: string; body: string; gone: string; keeps: string[] }> = [
  {
    lead: "+17168668217 (email, greeting on its own line)",
    body:
      "Hi daniel,\n\nThis is Alexandra at American Harley-Davidson. Thanks — I got your note about " +
      "selling your 2020 Fltrxs Road Glide Special. We can do a quick in‑person appraisal and give " +
      "you a firm offer. If you’re open to stopping by, what day and time works best?",
    gone: "This is Alexandra at American Harley-Davidson",
    keeps: ["Hi daniel", "2020 Fltrxs Road Glide Special", "what day and time works best?"]
  },
  {
    lead: "+17165835956 (email, inline em-dash greeting + a SECOND intro downstream)",
    body:
      "Hi Aaron — This is Alexandra at American Harley-Davidson. thanks for your interest in the 2017 " +
      "Street Glide. This is Giovanni Boccabella at American Harley-Davidson. Let me verify " +
      "availability and I’ll confirm shortly.",
    gone: "This is Alexandra at American Harley-Davidson",
    keeps: ["Hi Aaron", "2017 Street Glide", "verify availability"]
  },
  {
    lead: "+19152754874 (email, \"it's <name> over at <dealer>\")",
    body:
      "Hey Jay, it's Alexandra over at American Harley-Davidson. Thanks — I got your trade-in request " +
      "for 2015 Zr1000gff Z1000. We can give you a firm number after a quick in-person appraisal. " +
      "What day and time works best to stop in?",
    gone: "it's Alexandra over at",
    keeps: ["Hey Jay", "2015 Zr1000gff Z1000", "What day and time works best to stop in?"]
  },
  {
    lead: "+17163434575 (email, Riding Academy — the payload is dealership facts, not a pitch)",
    body:
      "Hey Justin, it's Alexandra over at American Harley-Davidson. Thanks for signing up for the " +
      "Riding Academy — I'm your contact here for anything to do with the course. One thing to flag: " +
      "your seat isn't showing as paid yet — you can take care of that at the dealership or over the " +
      "phone.",
    gone: "it's Alexandra over at",
    keeps: ["Hey Justin", "Riding Academy", "isn't showing as paid yet"]
  },
  {
    lead: "+17165231238 (email, name-less \"Hi,\" opener)",
    body: "Hi, this is Alexandra at American Harley-Davidson. Thanks for reaching out. We can only sell to customers in the United States.",
    gone: "this is Alexandra at",
    keeps: ["We can only sell to customers in the United States"]
  }
];

for (const spec of LIVE) {
  const guarded = enforceNoReintroduction({ body: spec.body, dealerName: DEALER, messages: HEARD_FROM_US });
  assert.ok(!guarded.includes(spec.gone), `${spec.lead}: the re-introduction must be gone — got: ${guarded}`);
  for (const keep of spec.keeps) {
    assert.ok(guarded.includes(keep), `${spec.lead}: the guard must not eat "${keep}" — got: ${guarded}`);
  }
  // Fail direction: on a genuine FIRST touch charter C1.2 owns the turn and the intro is INTENDED.
  assert.equal(
    enforceNoReintroduction({ body: spec.body, dealerName: DEALER, messages: FIRST_TOUCH }),
    spec.body,
    `${spec.lead}: a first touch must come back byte-identical`
  );
}

// --- 2. The sentence that follows an intro must not be left lower-cased -------------------------
// Aaron's live body is the specimen: the greeting is inline ("Hi Aaron — "), so the joiner is the
// intro's own full stop, and before this fix the guard returned "Hi Aaron. thanks for your interest".
const AARON = stripReintroductionOpener(LIVE[1]!.body, DEALER);
assert.ok(AARON.startsWith("Hi Aaron. Thanks for your interest"), `sentence case after a terminator — got: ${AARON}`);
assert.ok(!AARON.includes("Hi Aaron. thanks"), "a full stop must not be followed by a lower-case sentence");
// A comma or dash keeps the clause running, so what follows must be left exactly as written.
assert.ok(
  stripReintroductionOpener("Hey Dana, it's Marco at American Harley-Davidson, thanks for waiting.", DEALER)
    .includes(", thanks for waiting"),
  "a comma terminator must not be sentence-cased — the clause is still running"
);

// --- 3. END TO END through the real sink: a pipeline draft on a heard-from-us thread ------------
// Trap 2/3: a source-shape check cannot prove wiring, and this is the assertion that actually
// executes production code. `appendOutbound` is the UNIVERSAL draft sink — one call covers inbound
// replies, the follow-up cadence, and both channels.
function makeConv(over: Record<string, any> = {}): any {
  return {
    id: "+15551230000",
    mode: "suggest",
    lead: { firstName: "Aaron" },
    messages: [
      { id: "m1", direction: "in", provider: "twilio", body: "Is the Street Glide still there?", at: "2026-08-20T12:00:00.000Z" },
      { id: "m2", direction: "out", provider: "twilio", body: "It is — want to come see it?", at: "2026-08-20T12:05:00.000Z" }
    ],
    ...over
  };
}
// The sink reads the dealer name from the PROFILE CACHE, exactly as the review lane does, so the
// end-to-end has to load one. A deliberately non-AH dealer proves the anchors are DERIVED from the
// profile rather than hardcoded — the portability property the readiness bar grades.
writeFileSync(
  process.env.DEALER_PROFILE_PATH!,
  JSON.stringify({ dealerName: "Lakeshore Powersports Group", agentName: "Marco" }),
  "utf8"
);
const profile = await getDealerProfile();
assert.equal(profile?.dealerName, "Lakeshore Powersports Group", "the eval must actually have a dealer profile cached");

const REINTRO_BODY = "Hey Aaron, it's Marco over at Lakeshore Powersports Group. The 2017 Street Glide is still here.";

const emailConv = makeConv({ emailThread: true, lead: { firstName: "Aaron", email: "aaron@example.com" } });
appendOutbound(emailConv, "sales@dealer.example", "aaron@example.com", REINTRO_BODY, "draft_ai");
const emailOut = String(emailConv.emailDraft?.body ?? emailConv.emailDraft ?? "");
assert.ok(emailOut.trim().length > 0, "the email sink must still store a draft");
assert.ok(
  !emailOut.includes("it's Marco over at"),
  `EMAIL lane: the stored pipeline draft must not re-introduce — got: ${emailOut}`
);
assert.ok(emailOut.includes("2017 Street Glide is still here"), "EMAIL lane: the payload must survive");

// The SMS lane does not stash a `conv.draft` field — it APPENDS a `draft_ai` row to the timeline,
// which is the row the console renders as the pending draft. Read what the sink actually wrote.
function lastDraftRow(conv: any): string {
  const rows = (conv.messages ?? []).filter((m: any) => m?.direction === "out" && m?.provider === "draft_ai");
  return String(rows[rows.length - 1]?.body ?? "");
}
const smsConv = makeConv();
appendOutbound(smsConv, "+15559990000", "+15551230000", REINTRO_BODY, "draft_ai");
const smsOut = lastDraftRow(smsConv);
assert.ok(smsOut.trim().length > 0, "the SMS sink must still store a draft");
assert.ok(
  !smsOut.includes("it's Marco over at"),
  `SMS lane: the stored pipeline draft must not re-introduce — got: ${smsOut}`
);
assert.ok(smsOut.includes("2017 Street Glide is still here"), "SMS lane: the payload must survive");

// The fail direction, executed: a genuine FIRST touch keeps its intro through the same sink.
const firstTouch = makeConv({
  messages: [{ id: "m1", direction: "in", provider: "twilio", body: "Is the Street Glide still there?", at: "2026-08-20T12:00:00.000Z" }]
});
appendOutbound(firstTouch, "+15559990000", "+15551230000", REINTRO_BODY, "draft_ai");
const firstOut = lastDraftRow(firstTouch);
assert.ok(
  firstOut.includes("it's Marco over at Lakeshore Powersports Group"),
  `FIRST TOUCH: charter C1.2 keeps the intro — got: ${firstOut}`
);

// --- 4. WIRING: the guard sits at the sink, before the channel split ----------------------------
// Placement is load-bearing, not cosmetic: running BEFORE `formatEmailLayout` means a stripped intro
// leaves the layout free to write the greeting itself, instead of the guard having to splice one.
const STORE_SRC = readFileSync(
  new URL("../services/api/src/domain/conversationStore.ts", import.meta.url),
  "utf8"
);
const CALL = "tonedBody = enforceNoReintroduction({";
assert.equal(
  STORE_SRC.split(CALL).length - 1,
  1,
  "the C1.2a guard must be applied exactly once, at the universal draft sink"
);
const guardAt = STORE_SRC.indexOf(CALL);
const smsLayoutAt = STORE_SRC.indexOf("tonedBody = formatSmsLayout(tonedBody);");
const emailLayoutAt = STORE_SRC.indexOf("const emailDraft = formatEmailLayout(tonedBody,");
assert.ok(guardAt > 0 && smsLayoutAt > guardAt, "the guard must run BEFORE formatSmsLayout");
assert.ok(emailLayoutAt > guardAt, "the guard must run BEFORE formatEmailLayout");
assert.ok(
  STORE_SRC.slice(Math.max(0, guardAt - 260), guardAt).includes('provider === "draft_ai"'),
  "the guard is scoped to machine-composed drafts — a staff-typed send is never rewritten"
);
assert.ok(
  STORE_SRC.slice(guardAt, guardAt + 320).includes("messages: conv.messages"),
  "the guard must read the WHOLE thread — hasCustomerReceivedOutbound is the entire gate"
);

console.log("pipeline_draft_reintroduction:eval PASS");
