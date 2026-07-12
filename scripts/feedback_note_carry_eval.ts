/**
 * feedback_note_carry:eval — pins the same-conversation staff-correction carry-forward
 * (Joe, 2026-07-11; conv +17163591526 "It's not redrafting with thumbs down").
 *
 * Production decode: the 👎→redraft loop DID fire — but the NEXT turn's draft never saw
 * the rejection, so the pipeline regenerated the exact reply staff had just rejected
 * (draft 64 = rejected draft 61 verbatim), and successive redrafts re-added the rejected
 * "tied to your trade" claim because prior notes didn't stack. Fix: recent thumbs-down
 * NOTES on the conversation ride into every subsequent draft as hard constraints.
 *
 * Pins:
 *  1) collectRecentStaffCorrections — down+note only, outbound only, age-windowed,
 *     newest-first, count-capped, length-bounded, excludeMessageId honored.
 *  2) Wiring — all draft entry points pass staffCorrections: BOTH paths' orchestrator
 *     ctx (live twilio + regenerate), web-widget, both sendgrid orchestrations, and the
 *     thumbs-down redraft itself (prior notes stack under the current note).
 *  3) Composer — DraftContext.staffCorrections renders as a hard-constraint block,
 *     separate from the one-shot re-draft `steering` frame.
 *
 * Generation-context only (state-safety): the notes feed the composer prompt; routing,
 * dialog state, cadence, and side effects are untouched. Fail direction: no notes →
 * empty array → the prompt is unchanged.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { collectRecentStaffCorrections } from "../services/api/src/domain/feedbackSteering.ts";

const NOW = "2026-07-11T12:00:00.000Z";
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3600_000).toISOString();

const msg = (over: any) => ({
  id: over.id ?? "m1",
  direction: over.direction ?? "out",
  body: over.body ?? "Ok, will do. I'll keep this tied to the 2015 Road King trade.",
  feedback: over.feedback === null ? null : {
    rating: "down",
    note: "Should not say anything about trade. That is incorrect",
    at: hoursAgo(2),
    ...(over.feedback ?? {})
  }
});

// 1a) The production shape: a recent 👎 note on an outbound draft is collected, bounded,
// and quotes the rejected draft.
{
  const lines = collectRecentStaffCorrections({ messages: [msg({})] }, NOW);
  assert.equal(lines.length, 1, "recent down-note must be collected");
  assert.ok(lines[0].includes("Should not say anything about trade"), "note text carried");
  assert.ok(lines[0].includes("rejected draft began:"), "rejected draft quoted");
}

// 1b) Filters — each of these must collect NOTHING.
const empties: Array<[any, string]> = [
  [{ messages: [msg({ feedback: { rating: "up", note: "great" } })] }, "thumbs-up is not a correction"],
  [{ messages: [msg({ feedback: { note: "" } })] }, "bare thumbs-down (no note) carries no instruction"],
  [{ messages: [msg({ direction: "in" })] }, "inbound messages never count"],
  [{ messages: [msg({ feedback: { at: hoursAgo(24 * 9) } })] }, "stale note outside the age window"],
  [{ messages: [] }, "no messages"],
  [null, "no conversation"]
];
for (const [conv, label] of empties) {
  assert.equal(collectRecentStaffCorrections(conv, NOW).length, 0, `must be empty: ${label}`);
}

// 1c) Ordering, cap, and exclusion.
{
  const messages = [1, 2, 3, 4, 5, 6].map(i =>
    msg({ id: `m${i}`, body: `draft ${i}`, feedback: { note: `note ${i}`, at: hoursAgo(7 - i) } })
  );
  const lines = collectRecentStaffCorrections({ messages }, NOW);
  assert.equal(lines.length, 4, "count is capped at 4");
  assert.ok(lines[0].includes("note 6"), "newest note first");
  const excl = collectRecentStaffCorrections({ messages }, NOW, { excludeMessageId: "m6" });
  assert.ok(!excl.some(l => l.includes("note 6")), "excludeMessageId drops the rated message");
  assert.ok(excl[0].includes("note 5"), "next-newest note leads after exclusion");
}

// 1d) Length bounds — a runaway note/draft can never crowd out the turn.
{
  const long = "x".repeat(2000);
  const lines = collectRecentStaffCorrections(
    { messages: [msg({ body: long, feedback: { note: long } })] },
    NOW
  );
  assert.ok(lines[0].length < 400, `line must be bounded (got ${lines[0].length})`);
}

// 2) Wiring — every draft entry point carries the corrections.
const idx = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
const idxSites = (idx.match(/staffCorrections: collectRecentStaffCorrections\(conv, new Date\(\)\.toISOString\(\)/g) || []).length;
assert.ok(
  idxSites >= 4,
  `index.ts must wire staffCorrections at live + regen + widget + redraft (found ${idxSites})`
);
assert.ok(
  /excludeMessageId: String\(ratedMsg\?\.id \?\? ""\)/.test(idx),
  "the thumbs-down redraft must exclude the just-rated message (its note rides in steering)"
);
const sg = fs.readFileSync(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
const sgSites = (sg.match(/staffCorrections: collectRecentStaffCorrections\(conv, new Date\(\)\.toISOString\(\)\)/g) || []).length;
assert.equal(sgSites, 2, `both sendgrid orchestrations must wire staffCorrections (found ${sgSites})`);

// 3) Composer — orchestrator passes it through; llmDraft renders the hard-constraint block.
const orch = fs.readFileSync(path.resolve("services/api/src/domain/orchestrator.ts"), "utf8");
assert.ok(
  /staffCorrections: ctx\?\.staffCorrections \?\? null/.test(orch),
  "orchestrator must pass ctx.staffCorrections into the draft context"
);
const draft = fs.readFileSync(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.ok(/staffCorrections\?: string\[\] \| null;/.test(draft), "DraftContext must declare staffCorrections");
assert.ok(
  /STAFF CORRECTIONS — the dealership team rejected recent drafts on THIS conversation/.test(draft),
  "composer must render staff corrections as a hard-constraint block"
);
assert.ok(
  /\$\{steeringBlock\}\$\{staffCorrectionsBlock\}/.test(draft),
  "staff-corrections block must be injected into the instructions (separate from the re-draft steering frame)"
);

console.log("PASS feedback-note-carry eval (collector bounds + 6-site wiring + composer block)");
