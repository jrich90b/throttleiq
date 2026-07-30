/**
 * replay_fidelity:eval — pins the shadow-replay fidelity guards (2026-07-29).
 *
 * WHY: the corpus-replay flywheel filed a P1 `corpus_replay_regression` ("a merged change
 * broke this turn") that was manufactured by the HARNESS, not by any commit. The temporary
 * API's conversation store hydrates asynchronously and `/health` answers before it settles,
 * so a webhook fired too early lands on an empty store: `ensureConversation()` mints a fresh
 * default-"suggest" conversation with zero history, the agent drafts a first-touch intro
 * against no context, and the judge grades that phantom as a regression of the real turn.
 * Four replays of the same pinned turn (+17164322105 / msg_164a54bdc2231) on one commit gave
 * three different outcomes, with the post-turn mode flipping autopilot <-> suggest while
 * replayMode stayed pinned to autopilot.
 *
 * Deterministic, no IO: exercises the PURE core (hasHydrationCompleted + checkReplayFidelity).
 * Fail-direction contract pinned here: a replay that cannot prove it ran against the prepared
 * thread becomes a VISIBLE harness error, and legitimate turns (matching mode, an in-turn
 * staff takeover to "human", no forced mode to compare) are never turned into errors.
 */
import assert from "node:assert/strict";
import {
  checkReplayFidelity,
  composeReplayCommentLines,
  hasHydrationCompleted
} from "../services/api/src/domain/replayFidelity.ts";

// ── hasHydrationCompleted: the store's own load line is the completion signal ──────────
{
  // The real line conversationStore.loadFromDisk prints after hydrateParsedStore returns.
  assert.equal(
    hasHydrationCompleted(["📦 Loaded 790 conversations from /srv/data/conversations.json"]),
    true,
    "the store's load line must be recognized as hydration-complete"
  );
  assert.equal(
    hasHydrationCompleted(["boot", "Loaded 1 conversations from /tmp/x.json", "ready"]),
    true,
    "singular/plain variant still counts"
  );
  assert.equal(hasHydrationCompleted([]), false, "no logs => not hydrated");
  assert.equal(hasHydrationCompleted(null), false, "missing logs => not hydrated (fail-safe)");
  assert.equal(hasHydrationCompleted(undefined as any), false, "undefined logs => not hydrated");
  assert.equal(
    hasHydrationCompleted(["Server listening on 3000", "loaded settings", "Loaded conversations"]),
    false,
    "an unrelated 'loaded' line must NOT be mistaken for the store's count line"
  );
}

// ── checkReplayFidelity: did the turn run against the PREPARED thread? ────────────────
{
  // The good case: prepared autopilot, observed autopilot.
  assert.deepEqual(
    checkReplayFidelity({ forcedMode: "autopilot", observedMode: "autopilot", conversationFound: true }),
    { ok: true },
    "a matching mode is a faithful replay"
  );
  assert.deepEqual(
    checkReplayFidelity({ forcedMode: "suggest", observedMode: "suggest", conversationFound: true }),
    { ok: true },
    "suggest-mode replays (ADF) are faithful when the mode matches"
  );
  assert.deepEqual(
    checkReplayFidelity({ forcedMode: "AUTOPILOT", observedMode: " autopilot ", conversationFound: true }),
    { ok: true },
    "mode comparison is case/whitespace insensitive"
  );
}

{
  // THE 2026-07-29 PHANTOM: prepared autopilot, read back as a fresh default "suggest".
  const verdict = checkReplayFidelity({
    forcedMode: "autopilot",
    observedMode: "suggest",
    conversationFound: true
  });
  assert.equal(verdict.ok, false, "a fresh default-suggest conversation must NOT be judged");
  assert.ok(
    !verdict.ok && /autopilot/.test(verdict.reason) && /suggest/.test(verdict.reason),
    "the error must name both the prepared and the observed mode so triage is possible"
  );
  assert.ok(
    !verdict.ok && /hydration race/i.test(verdict.reason),
    "the error must name the cause (async store hydration race)"
  );
}

{
  // A staff takeover during the turn legitimately rewrites the mode — not a harness fault.
  assert.deepEqual(
    checkReplayFidelity({ forcedMode: "autopilot", observedMode: "human", conversationFound: true }),
    { ok: true },
    "an in-turn takeover to human mode is a real side effect, never a fidelity error"
  );
}

{
  // The conversation vanished entirely.
  const verdict = checkReplayFidelity({
    forcedMode: "autopilot",
    observedMode: null,
    conversationFound: false
  });
  assert.equal(verdict.ok, false, "an unreadable conversation must surface as an error");
  assert.ok(!verdict.ok && /never loaded the prepared thread/.test(verdict.reason));
}

{
  // Found, but the row lost its mode => it was replaced mid-replay.
  const verdict = checkReplayFidelity({
    forcedMode: "autopilot",
    observedMode: "",
    conversationFound: true
  });
  assert.equal(verdict.ok, false, "a mode-less row means the prepared thread was replaced");
  assert.ok(!verdict.ok && /lost its mode/.test(verdict.reason));
}

{
  // Fail-direction: with nothing to compare against, do NOT invent an error.
  assert.deepEqual(
    checkReplayFidelity({ forcedMode: null, observedMode: "suggest", conversationFound: true }),
    { ok: true },
    "no forced mode => nothing to compare; never manufacture a harness error"
  );
  assert.deepEqual(
    checkReplayFidelity({ forcedMode: "", observedMode: null, conversationFound: true }),
    { ok: true },
    "empty forced mode => no comparison"
  );
}

// ── composeReplayCommentLines: the synthetic ADF must not duplicate the inquiry ────────
{
  // THE 2026-07-30 PRODUCTION TURN (+17165100025, msg_295d1c55e08da). The stored lead carried
  // the walk-in note in BOTH fields, so the harness emitted it twice and the agent echoed the
  // raw label: "I'll follow up about new and pre-owned Customer Comments: Looking for trike
  // models." The real send for this turn was clean — production never re-serializes a lead.
  const inquiry =
    "Looking for trike models. Was going to wait until spring of 2027 but saw the 2019 we had " +
    "in back. Wants to take a test ride on new and pre-owned (Step 2)";
  const lines = composeReplayCommentLines({ inquiry, walkInComment: inquiry });
  assert.deepEqual(lines, [inquiry], "an identical walk-in note must not be emitted a second time");
  assert.equal(
    lines.join("\n").match(/Customer Comments:/g),
    null,
    "no raw field label may be manufactured when the note adds nothing"
  );
  assert.equal(
    lines.join("\n").match(/Looking for trike models/g)?.length,
    1,
    "the inquiry text must appear exactly ONCE in the synthetic ADF comment"
  );
}

{
  // A genuinely different walk-in note is real context production had — never drop it.
  // 23 of the 45 corpus leads with a walkInComment are this shape.
  const lines = composeReplayCommentLines({
    inquiry: "Came in and showed him the bike (2022 XL1200X)",
    walkInComment: "App ID: 1013890736, Model Year: 2022, Model: Forty-Eight"
  });
  assert.equal(lines.length, 2, "a distinct walk-in note is kept");
  assert.ok(
    lines[1].startsWith("Customer Comments: App ID: 1013890736"),
    "the distinct note keeps its label so the replay sees what production saw"
  );
}

{
  // Markup is not semantic content: the same note stored with HTML must still dedupe.
  const lines = composeReplayCommentLines({
    inquiry: "Tom stopped in and is looking for a 2014-2016 Road King. Joe Hartrich",
    walkInComment: "Tom stopped in and is looking for a 2014-2016 Road King. <strong>Joe Hartrich</strong>"
  });
  assert.deepEqual(
    lines.length,
    1,
    "an HTML-marked duplicate of the inquiry is still a duplicate"
  );
}

{
  // Fail direction: the BODY's inquiry is authoritative. A walk-in note that is a strict
  // SUPERSET may come from a LATER lead on the thread, so it is kept as its own labeled line
  // and may never override or extend the inquiry the turn actually arrived with.
  const lines = composeReplayCommentLines({
    inquiry: "H-D1 Dealer Portal URL",
    walkInComment: "H-D1 Dealer Portal URL: https://hdnetportal.sharepoint.com/sites/us"
  });
  assert.equal(lines.length, 2, "a superset note is kept separately, never merged over the inquiry");
  assert.equal(lines[0], "H-D1 Dealer Portal URL", "the body-derived inquiry stays first and intact");
}

{
  // The date/time lines are deliberately NOT deduped — short structured values whose label
  // carries the meaning — and ordering stays inquiry → date → time → comments.
  const lines = composeReplayCommentLines({
    inquiry: "Wants a test ride on 2026-08-02",
    preferredDate: "2026-08-02",
    preferredTime: "10:00",
    walkInComment: "Prefers the morning"
  });
  assert.deepEqual(lines, [
    "Wants a test ride on 2026-08-02",
    "Preferred date: 2026-08-02",
    "Preferred time: 10:00",
    "Customer Comments: Prefers the morning"
  ]);
}

{
  // Empty / missing parts never manufacture a blank labeled line.
  assert.deepEqual(composeReplayCommentLines({}), [], "nothing in => nothing out");
  assert.deepEqual(
    composeReplayCommentLines({ inquiry: "Just the inquiry", walkInComment: "   " }),
    ["Just the inquiry"],
    "a whitespace-only note is not a comment"
  );
  assert.deepEqual(
    composeReplayCommentLines({ inquiry: "", walkInComment: "Walk-in only" }),
    ["Customer Comments: Walk-in only"],
    "a walk-in note with no inquiry is still emitted"
  );
}

console.log(
  "PASS replay_fidelity eval — hydration-complete signal + prepared-thread fidelity guard + synthetic-ADF comment dedupe (phantom corpus_replay_regression becomes a visible harness error; takeover/no-baseline never error; a walk-in note never duplicates the inquiry behind a raw label)"
);
