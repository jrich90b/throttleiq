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

console.log(
  "PASS replay_fidelity eval — hydration-complete signal + prepared-thread fidelity guard (phantom corpus_replay_regression becomes a visible harness error; takeover/no-baseline never error)"
);
