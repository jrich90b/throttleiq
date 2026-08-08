/**
 * advance_every_reply:eval — every reply ends with ONE question that advances the lead, and the
 * turns where it must NOT are decided in CODE.
 *
 * WHY THIS EXISTS. Measured 2026-08-07: of 383 replies to a live customer over 30 days, only 65
 * (17%) ended by asking anything. That was not a capability gap — our own SMS rules said "Answer
 * ONLY what the customer asked THIS turn", capped questions at "at most ONE" (a ceiling, never a
 * floor), and forbade offering a time unless the customer asked first. Joe chose to flip it after
 * testing a competitor demo that advanced on every single turn.
 *
 * THE FAILURE THIS PINS. The first cut put the exceptions in the PROMPT ("DO NOT ask anything when
 * the customer ... disclosed a hardship"). Probed on five real-shaped turns it lost to the
 * imperative above it 3 times out of 3, including a customer who wrote "my husband passed away last
 * week" and got back "Would you like me to pause follow-ups for now or check back in a few weeks?"
 * A strong opening instruction beats a caveat further down. So the arm is now selected in code and
 * the caveat is only a second line of defence — and THAT is what this eval guards.
 *
 * Run: npx tsx scripts/advance_every_reply_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const { advanceEveryReplyEnabled, advanceEveryReplySuppressed } = await import(
  "../services/api/src/domain/draftChannelRules.ts"
);

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

// --- 1) SHIPS DARK. Unset/garbage must read OFF, so the legacy prompt is the default AND the revert.
const prior = process.env.DRAFT_ADVANCE_EVERY_REPLY;
try {
  for (const raw of [undefined, "", "0", "off", "false", "no", "maybe", " "]) {
    if (raw === undefined) delete process.env.DRAFT_ADVANCE_EVERY_REPLY;
    else process.env.DRAFT_ADVANCE_EVERY_REPLY = raw;
    ok(!advanceEveryReplyEnabled(), `DRAFT_ADVANCE_EVERY_REPLY=${JSON.stringify(raw)} must read OFF`);
  }
  for (const raw of ["1", "true", "YES", "Yes"]) {
    process.env.DRAFT_ADVANCE_EVERY_REPLY = raw;
    ok(advanceEveryReplyEnabled(), `DRAFT_ADVANCE_EVERY_REPLY=${JSON.stringify(raw)} must read ON`);
  }
} finally {
  if (prior === undefined) delete process.env.DRAFT_ADVANCE_EVERY_REPLY;
  else process.env.DRAFT_ADVANCE_EVERY_REPLY = prior;
}

// --- 2) THE SUPPRESSIONS. Each was a MEASURED failure of the prompt-caveat version.
ok(
  advanceEveryReplySuppressed({ needsEmpathy: true }),
  "hardship must suppress the arm — never sell into grief"
);
ok(
  advanceEveryReplySuppressed({ dispositionClosing: true }),
  "a customer closing the lead out must suppress the arm — do not ask a man who just bought elsewhere to keep shopping"
);
for (const appt of [
  { startLocal: "Sat, Aug 9, 11:00 AM" },
  { startsAt: "2026-08-09T15:00:00.000Z" },
  { status: "booked" },
  { status: "CONFIRMED" }
]) {
  ok(
    advanceEveryReplySuppressed({ appointment: appt }),
    `a booked appointment must suppress the arm (${JSON.stringify(appt)}) — confirm it, do not re-open it`
  );
}

// --- 3) AND IT MUST NOT SUPPRESS THE ORDINARY SELLING TURN, or the whole change is inert.
ok(!advanceEveryReplySuppressed({}), "an empty context must NOT suppress — that is the selling turn");
ok(
  !advanceEveryReplySuppressed({ needsEmpathy: false, dispositionClosing: false, appointment: null }),
  "explicit falses must NOT suppress"
);
ok(
  !advanceEveryReplySuppressed({ appointment: { status: "cancelled" } }),
  "a CANCELLED appointment is a lead to re-engage, not a settled thread"
);
ok(
  !advanceEveryReplySuppressed({ appointment: {} }),
  "an empty appointment object is not a booking"
);

// --- 4) WIRING, COUNTED. The size ratchet cannot prove a field is passed; count the call sites.
// Both inbound paths must feed dispositionClosing, or the suppression is silently dead on one of
// them — which is exactly how the regenerate path came to be missing a sign-off exemption for weeks.
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const sites = (index.match(/dispositionClosing:/g) ?? []).length;
assert.equal(sites, 2, `both inbound paths must pass dispositionClosing (live + regenerate); found ${sites}`);
checks += 1;
ok(
  /needsEmpathy: acceptedAffect\?\.needsEmpathy \?\? null,\s*\n\s*dispositionClosing:/.test(index),
  "the LIVE path passes dispositionClosing beside needsEmpathy"
);
ok(
  /needsEmpathy: regenAcceptedAffect\?\.needsEmpathy \?\? null,\s*\n\s*dispositionClosing:/.test(index),
  "the REGENERATE path passes dispositionClosing beside needsEmpathy"
);

const orchestrator = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");
ok(
  orchestrator.includes("dispositionClosing: ctx?.dispositionClosing ?? null"),
  "the orchestrator hands dispositionClosing to the draft context"
);

// --- 5) The prompt arm still carries the caveat as a SECOND line of defence, and still says BE BRIEF.
// The rules live in their own module (moved so llmDraft.ts could stay under its size ceiling);
// read each pin from where the thing it pins actually is.
const draft = fs.readFileSync("services/api/src/domain/draftChannelRules.ts", "utf8");
ok(draft.includes("YOU ARE A SALESPERSON"), "the salesperson arm exists");
ok(draft.includes("PREFER A CHOICE OF TWO"), "the two-option preference survives — it controls the flow of the conversation");
ok(
  draft.includes("Be brief and warm"),
  "brevity survives in the new arm — verbosity was staff's #1 complaint and this is not a licence to pile on"
);

console.log(`advance_every_reply:eval OK (${checks} checks)`);
