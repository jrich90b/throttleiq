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
  classifyReplayErrorCause,
  composeReplayCommentLines,
  hasHydrationCompleted,
  isStoredVehicleConsistentWithBody,
  resolveReplayLead
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

// ── resolveReplayLead: the NEWEST lead is not necessarily THIS turn's lead ─────────────
{
  // THE 2026-07-30 CASE (+17165100025). Replaying message 0 (Ref 11697, a Tri Glide walk-in)
  // while the thread's latestLead is Ref 11710 (a Road Glide credit app). The body's own Ref
  // joins to the older record, so the replay must read THAT one.
  const latestLead = { leadRef: "11710", firstName: "Michael", vehicle: { year: "2026", model: "Road Glide Limited" } };
  const lead = { leadRef: "11697", firstName: "Mike", vehicle: { year: "2026", model: "Road Glide Limited" } };
  const resolved = resolveReplayLead({ bodyRef: "11697", candidates: [latestLead, lead] });
  assert.equal(resolved.matched, true, "a leadRef join is a confirmed match");
  assert.equal(resolved.lead.leadRef, "11697", "the record matching the body's Ref wins over latestLead");
}

{
  // Ambiguous: several distinct leads and none carries the body's Ref (or the body has none).
  // Keep the caller's precedence but refuse to vouch for it, so body-fallback-less fields drop.
  const a = { leadRef: "11710" };
  const b = { leadRef: "11697" };
  const noRef = resolveReplayLead({ bodyRef: "", candidates: [a, b] });
  assert.equal(noRef.matched, false, "no body Ref + multiple distinct leads => unconfirmed");
  assert.equal(noRef.lead.leadRef, "11710", "precedence is preserved (latestLead first)");

  const unknownRef = resolveReplayLead({ bodyRef: "99999", candidates: [a, b] });
  assert.equal(unknownRef.matched, false, "a Ref matching no stored record is unconfirmed");
}

{
  // Unambiguous threads must NOT lose their context: one lead (or several copies of the same
  // lead) means there is nothing to confuse, so the extras stay even with no body Ref.
  assert.deepEqual(
    resolveReplayLead({ bodyRef: "", candidates: [{ leadRef: "11697" }] }).matched,
    true,
    "a single stored lead is unambiguous"
  );
  assert.equal(
    resolveReplayLead({ bodyRef: null, candidates: [{ leadRef: "11697" }, { leadRef: "11697" }] }).matched,
    true,
    "duplicate records of the same lead are still unambiguous"
  );
  assert.equal(
    resolveReplayLead({ bodyRef: "", candidates: [null, undefined, { leadRef: "1" }] }).matched,
    true,
    "absent candidates are skipped, not counted as distinct leads"
  );
  assert.equal(
    resolveReplayLead<any>({ bodyRef: "1", candidates: [] }).matched,
    false,
    "no candidates at all => nothing is confirmed"
  );
}

// ── isStoredVehicleConsistentWithBody: never describe a different lead's motorcycle ────
{
  // The 2026-07-30 contamination: body says a 2019 Tri Glide, the stored lead is a 2026
  // Road Glide, so its colour/price/make must not reach the synthetic ADF.
  assert.equal(
    isStoredVehicleConsistentWithBody({
      bodyYear: "2019",
      bodyModel: "Harley-Davidson FLHTCUTG Tri Glide",
      storedYear: "2026",
      storedModel: "Road Glide Limited"
    }),
    false,
    "a contradicting year AND model is a different motorcycle"
  );
  assert.equal(
    isStoredVehicleConsistentWithBody({
      bodyYear: "2019",
      bodyModel: "Tri Glide",
      storedYear: "2026",
      storedModel: "Tri Glide"
    }),
    false,
    "the same model in a different year is still a different unit"
  );
  assert.equal(
    isStoredVehicleConsistentWithBody({
      bodyYear: "2026",
      bodyModel: "Harley-Davidson FLHTCUTG Tri Glide",
      storedYear: "2026",
      storedModel: "Tri Glide"
    }),
    true,
    "the stored model may be the shorter spelling of the body's"
  );
  assert.equal(
    isStoredVehicleConsistentWithBody({
      bodyYear: "",
      bodyModel: "",
      storedYear: "2026",
      storedModel: "Road Glide"
    }),
    true,
    "absent body evidence is not contradiction — a Full Line lead keeps its stored vehicle"
  );
  assert.equal(
    isStoredVehicleConsistentWithBody({ bodyYear: "2026", bodyModel: "Road Glide", storedYear: "", storedModel: "" }),
    true,
    "an empty stored vehicle contradicts nothing"
  );
}

// ── classifyReplayErrorCause: who failed, the harness or the agent? (2026-08-04) ────────
{
  // The verbatim error from the 08-04 sweep: a deploy ran `npm ci` in the deploy checkout while
  // the harness was booting one temporary API per case, and 29 consecutive cases died here.
  const REAL_BOOT_FAILURE =
    "temporary API exited early (1): node:internal/modules/esm/resolve:873\n" +
    "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);\n" +
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dotenv' imported from " +
    "/home/ubuntu/leadrider-api/americanharley/services/api/dist/domain/sentryInit.js";
  assert.equal(
    classifyReplayErrorCause(REAL_BOOT_FAILURE),
    "harness",
    "the production 08-04 boot failure must be attributed to the harness, not the agent"
  );

  for (const [text, why] of [
    ["temporary API did not become healthy: ...", "a boot that never went healthy ran no turn"],
    ["temporary API exited before the prepared thread loaded (1): ...", "died before the thread loaded"],
    ["services/api/dist/index.js is missing. Run `npm --workspace @throttleiq/api run build` first.", "no build to replay"],
    ["replay fidelity: replayed conversation lost its mode (expected \"autopilot\")", "the fidelity backstop is a harness fault"],
    ["no free port assigned", "the harness could not even get a port"],
    [
      "temporary API exited early (1): Error: Cannot find module '/home/ubuntu/x/node_modules/@sentry/node/index.js'",
      "the other install-race spelling, still behind the boot anchor"
    ]
  ] as const) {
    assert.equal(classifyReplayErrorCause(text), "harness", why);
  }

  // THE HOLE THE 08-04 PRE-SHIP REVIEW FOUND, pinned shut. `replayOne` appends the child's last
  // 20 log lines to every error string, so a module-resolution line can ride along on a REAL
  // agent failure. Matching that symptom free-floating would strip a genuine CRITICAL and its
  // work order off the gate — so only harness-thrown anchors count, never symptoms.
  assert.equal(
    classifyReplayErrorCause(
      "timed out waiting for Twilio shadow job\nRecent API logs:\n" +
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/node_modules/some-optional-dep/index.js'"
    ),
    "agent",
    "a module-not-found line in the APPENDED API LOGS must never excuse an agent failure"
  );
  assert.equal(
    classifyReplayErrorCause("Twilio shadow job failed: Cannot find package 'handlebars'"),
    "agent",
    "the API booted and then threw — a bare package error is the agent's, not the harness's"
  );

  // FAIL DIRECTION — the load-bearing pin. Anything not proven to be a harness fault stays an
  // AGENT failure, so it keeps its CRITICAL and keeps its work order. Widening this list must
  // never be the way a real defect gets excused off the gate.
  assert.equal(
    classifyReplayErrorCause("timed out waiting for Twilio shadow job"),
    "agent",
    "the API booted and then failed to answer — that IS evidence about the agent"
  );
  assert.equal(
    classifyReplayErrorCause("Twilio shadow job failed: draft generation threw"),
    "agent",
    "a job the agent failed is an agent failure"
  );
  assert.equal(
    classifyReplayErrorCause("something nobody has seen before"),
    "agent",
    "an UNRECOGNISED error must default to agent — unknown never silently leaves the gate"
  );
  for (const empty of ["", "   ", null, undefined]) {
    assert.equal(
      classifyReplayErrorCause(empty),
      "agent",
      "a missing error string is not proof of a harness fault"
    );
  }
}

console.log(
  "PASS replay_fidelity eval — hydration-complete signal + prepared-thread fidelity guard + synthetic-ADF comment dedupe + per-turn lead resolution + harness-vs-agent error attribution (phantom corpus_replay_regression becomes a visible harness error; takeover/no-baseline never error; a walk-in note never duplicates the inquiry behind a raw label; an unrecognised error stays the agent's)"
);
