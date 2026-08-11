/**
 * enough_info_handoff:eval — "we have enough; stop asking and hand off" (Joe, 2026-08-10).
 *
 * ORIGIN — John Zimmerman, +17169902571, 2026-08-10 19:18 ET. A SUBMITTED HDFS credit application
 * for a 2026 Road Glide. We asked "Are you looking at the Road Glide, or open to a couple of
 * options?"; he answered "Couple options" — our own second option, in our own words. The routing
 * parser returned fallback_action "clarify", so the draft asked him what he meant and the thread
 * was filed `clarify_schedule`.
 *
 * Joe: "the agent has to know when we have enough info and to handoff — we don't need the agent to
 * keep asking questions."
 *
 * WHAT THIS PINS
 *  1. The decision table — every input must be POSITIVELY known, unsure ⇒ keep_asking.
 *  2. The money path is an ARTEFACT (a submitted credit app), never a prequal ORIGIN label.
 *  3. The hand-off reply ends WITHOUT a question — the fifth C1.7 exception is the whole point.
 *  4. `advanceEveryReplySuppressed` honours it, so no advancing question is appended afterwards.
 *  5. John's exact shape produces a hand-off; the same lead one input short does not.
 *
 * Deterministic: the parser verdict is injected, never called. Confidence numbers from the live
 * model are unstable (measured 0.97/0.69/0.82 on one identical input elsewhere today), so nothing
 * here asserts a model-produced number — only the decision.
 */
import assert from "node:assert/strict";
import { decideSalesHandoffReadiness } from "../services/api/src/domain/routeStateReducer.ts";
import { advanceEveryReplySuppressed } from "../services/api/src/domain/draftChannelRules.ts";
import {
  bikeScopeIsSettled,
  buildEnoughInfoHandoffReply,
  evaluateEnoughInfoHandoff,
  moneyPathIsKnown
} from "../services/api/src/domain/salesHandoffReadiness.ts";

const READY = {
  contactable: true,
  moneyPathKnown: true,
  bikeScopeSettled: true,
  alreadyHandedOff: false,
  appointmentBooked: false
};

// ── 1. The decision table ──────────────────────────────────────────────────────────────
{
  assert.equal(decideSalesHandoffReadiness(READY).kind, "handoff", "all three known ⇒ hand off");

  const keepAsking: Array<[string, Partial<typeof READY>]> = [
    ["no way to reach them", { contactable: false }],
    ["money path unknown", { moneyPathKnown: false }],
    ["bike question unsettled", { bikeScopeSettled: false }],
    ["already on a person's desk", { alreadyHandedOff: true }],
    ["appointment already booked", { appointmentBooked: true }]
  ];
  for (const [label, patch] of keepAsking) {
    assert.equal(
      decideSalesHandoffReadiness({ ...READY, ...patch }).kind,
      "keep_asking",
      `${label} ⇒ keep asking (a premature hand-off spends a salesperson on a lead still qualifying)`
    );
  }
}

// ── 2. The money path is an ARTEFACT, not an origin label ──────────────────────────────
{
  assert.equal(moneyPathIsKnown("hdfs_coa"), true, "a submitted credit application counts");
  assert.equal(moneyPathIsKnown("hdfs_coa_online"), true, "…including the online variant");
  // The trap this mirrors: a prequal ORIGIN label never expires, so treating it as a live artefact
  // would hand off every prequal-sourced lead forever.
  assert.equal(moneyPathIsKnown("prequalify"), false, "a soft prequal form is NOT a money path");
  assert.equal(moneyPathIsKnown(""), false, "blank is not a money path");
  assert.equal(moneyPathIsKnown(null), false, "absent is not a money path");
}

// ── 3. The bike question, and the confidence floor ─────────────────────────────────────
{
  assert.equal(bikeScopeIsSettled({ bike_scope: "open_to_options", confidence: 0.93 }), true);
  assert.equal(bikeScopeIsSettled({ bike_scope: "specific_bike", confidence: 0.9 }), true);
  assert.equal(bikeScopeIsSettled({ bike_scope: "not_stated", confidence: 0.99 }), false);
  assert.equal(bikeScopeIsSettled({ bike_scope: "open_to_options", confidence: 0.2 }), false);
  assert.equal(bikeScopeIsSettled(null), false, "no parser answer ⇒ not settled");
}

// ── 4. The reply does NOT ask — that is the exception, not an oversight ────────────────
{
  const reply = buildEnoughInfoHandoffReply("John");
  assert.ok(!reply.includes("?"), "the hand-off must NOT end with a question — that is the rule");
  assert.ok(/finance team/i.test(reply), "it names the FINANCE team — who the first ack already promised");
  assert.ok(
    !/salesperson|salespeople/i.test(reply),
    "and never a salesperson: the first ack on these threads says the finance team will reach out, " +
      "so naming anyone else contradicts our own earlier message to the same customer"
  );
  assert.ok(reply.includes("John"), "it uses their name when we have one");
  assert.ok(
    !/\$|\d\s*%|\bin stock\b|\bapproved\b/i.test(reply),
    "it promises no figure, no stock claim and no credit outcome"
  );
  assert.ok(buildEnoughInfoHandoffReply(null).length > 0, "it still works with no name");
}

// ── 5. The suppressor honours it (fifth C1.7 exception) ───────────────────────────────
{
  assert.equal(
    advanceEveryReplySuppressed({ enoughInfoHandoff: true }),
    true,
    "no advancing question may be appended to a hand-off"
  );
  assert.equal(
    advanceEveryReplySuppressed({ enoughInfoHandoff: false }),
    false,
    "and it does not suppress an ordinary turn — the arm still runs everywhere else"
  );
}

// ── 6. John's exact shape ──────────────────────────────────────────────────────────────
{
  const john = {
    cta: "hdfs_coa",
    leadPhone: "+17169902571",
    leadEmail: "johnzimerman85@gmail.com",
    leadKey: "+17169902571",
    followUpMode: null as string | null,
    hasAppointment: false,
    firstName: "John",
    decide: decideSalesHandoffReadiness
  };
  const out = evaluateEnoughInfoHandoff({
    ...john,
    scopeParse: { bike_scope: "open_to_options", confidence: 0.93 }
  });
  assert.ok(out, "John's turn hands off instead of asking him what he meant");
  assert.ok(!out!.reply.includes("?"), "and does not ask him anything");

  // One input short, same lead: still a question, never a hand-off.
  assert.equal(
    evaluateEnoughInfoHandoff({ ...john, scopeParse: { bike_scope: "not_stated", confidence: 0.99 } }),
    null,
    "an unsettled bike question keeps the conversation going"
  );
  assert.equal(
    evaluateEnoughInfoHandoff({
      ...john,
      cta: "prequalify",
      scopeParse: { bike_scope: "open_to_options", confidence: 0.93 }
    }),
    null,
    "a prequal-origin lead with no submitted application keeps qualifying"
  );
  assert.equal(
    evaluateEnoughInfoHandoff({
      ...john,
      followUpMode: "manual_handoff",
      scopeParse: { bike_scope: "open_to_options", confidence: 0.93 }
    }),
    null,
    "a thread already on a person's desk is never handed off twice"
  );
}

console.log("enough_info_handoff:eval PASS");
