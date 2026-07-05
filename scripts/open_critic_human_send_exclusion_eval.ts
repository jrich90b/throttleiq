/**
 * open_critic_human_send_exclusion:eval — pins the open-critic's reply-selection so it grades the
 * AGENT's reply, never a human-typed/edited send.
 *
 * Production bug (2026-06-30): salesman Kurtis Stone typed manual self-intros with a missing comma
 * after his own name — "hello stone from American Harley…" / "hello Donald Stone from American Harley
 * come stop by…" — and the open-ended turn critic read them as the AGENT addressing the customer as
 * "Stone" (issueClass wrong_customer_name_in_reply). Those were MANUAL human sends (the send path stamps
 * actorUserName/actorUserId on a from-scratch or edited send), so they must not be graded as agent
 * errors. An AI draft approved UNCHANGED carries NO actor and MUST still be graded (the high-value
 * staff-approved-AI-draft catch) — so the discriminator is the actor, not the provider.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isHumanAuthoredOutbound,
  selectOpenCriticAgentReply
} from "../services/api/src/domain/conversationOutcomeAudit.ts";

// The sweep's notion of a "real" (sent) outbound — mirror it here so the fixture matches production.
const REAL_OUT = new Set(["twilio", "sendgrid", "human"]);

// --- isHumanAuthoredOutbound -------------------------------------------------
// Kurtis Stone's manual send: provider twilio + an actor stamp => human-authored.
assert.equal(
  isHumanAuthoredOutbound({
    direction: "out",
    provider: "twilio",
    body: "hello stone from American Harley we have some other models if your interested",
    actorUserName: "Joe Hartrich",
    actorUserId: "95e86615-1e33-49b9-adb2-69f557d98a65"
  }),
  true,
  "a sent outbound carrying an actor (manual compose / edited draft) is human-authored"
);
// An AI draft approved UNCHANGED: sent via twilio, NO actor stamp => agent-authored (must be graded).
assert.equal(
  isHumanAuthoredOutbound({ direction: "out", provider: "twilio", body: "Hi Donald — this is Alexandra at American Harley-Davidson." }),
  false,
  "an approved-unchanged AI draft (no actor) is NOT human-authored"
);
// actorUserId alone (no name) still counts as human-authored.
assert.equal(
  isHumanAuthoredOutbound({ direction: "out", provider: "twilio", body: "hey", actorUserId: "u_1" }),
  true,
  "actorUserId alone marks a human-authored send"
);
// Inbound is never "authored" by the agent or human in this sense.
assert.equal(isHumanAuthoredOutbound({ direction: "in", body: "hi", actorUserName: "x" }), false, "inbound is not an authored outbound");
assert.equal(isHumanAuthoredOutbound(null), false, "null is safe");

// --- selectOpenCriticAgentReply ----------------------------------------------
// THE PRODUCTION CASE: AI reply earlier, then Stone's manual self-intro is the LATEST real outbound =>
// a human is driving => skip (return null), so the critic never grades "hello stone…" as an agent error.
const stoneThread = [
  { direction: "in", provider: "twilio", body: "WEB LEAD (ADF)\nName: Theodore Leber" },
  { direction: "out", provider: "draft_ai", body: "draft pending", actorUserName: "" }, // pending AI draft (not a real send)
  { direction: "out", provider: "twilio", body: "Hi Theodore — This is Giovanni at American Harley-Davidson." }, // approved AI send, no actor
  { direction: "in", provider: "twilio", body: "No" },
  { direction: "out", provider: "twilio", body: "hello stone from American Harley we have some other models", actorUserName: "Joe Hartrich", actorUserId: "u_1" }
];
assert.equal(
  selectOpenCriticAgentReply(stoneThread, REAL_OUT),
  null,
  "latest real outbound is Stone's manual send => skip (no agent reply to grade)"
);

// When the latest real outbound IS the agent's (approved AI, no actor), it is selected for grading.
const agentLatest = [
  { direction: "in", provider: "twilio", body: "is it still available?" },
  { direction: "out", provider: "twilio", body: "Yep — still here. Want to set a time to stop in?" }
];
const picked = selectOpenCriticAgentReply(agentLatest, REAL_OUT);
assert.ok(picked && picked.body.startsWith("Yep —"), "an agent-authored latest reply is selected for grading");

// A pending AI draft (provider draft_ai) is NOT a real send => not selectable; nothing to grade.
assert.equal(
  selectOpenCriticAgentReply(
    [
      { direction: "in", provider: "twilio", body: "hi" },
      { direction: "out", provider: "draft_ai", body: "unsent draft" }
    ],
    REAL_OUT
  ),
  null,
  "a pending draft_ai message is not a real reply (REAL_OUT excludes draft_ai)"
);

// No outbound at all => null.
assert.equal(selectOpenCriticAgentReply([{ direction: "in", provider: "twilio", body: "hi" }], REAL_OUT), null, "no outbound => null");

// --- wiring: the sweep uses the shared selector in BOTH the prefilter and the loop ------------------
const sweep = fs.readFileSync(path.resolve("scripts/open_critic_sweep.ts"), "utf8");
assert.ok(/selectOpenCriticAgentReply/.test(sweep), "open_critic_sweep imports the shared agent-reply selector");
assert.ok(
  (sweep.match(/selectOpenCriticAgentReply\(msgs, REAL_OUT\)/g) || []).length >= 2,
  "the sweep uses the selector in BOTH the prefilter and the per-conv loop (no human-authored reply graded)"
);
assert.ok(!/\.reverse\(\)\s*\.find\(\(m: any\) => m\?\.direction === "out"/.test(sweep), "the old un-authored lastReply find is gone");

console.log("PASS open-critic human-send exclusion eval (authorship predicate + agent-reply selection + sweep wiring)");
