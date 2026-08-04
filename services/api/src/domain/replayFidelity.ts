/**
 * Replay-fidelity guards for the inbound shadow replay harness.
 *
 * WHY: `scripts/inbound_shadow_replay.ts` boots a temporary API against a PREPARED
 * copy of the store — `prepareCaseData` truncates the thread to the turn under test
 * and forces `conv.mode` to the replay mode — and then POSTs the inbound webhook.
 * But the conversation store hydrates ASYNCHRONOUSLY (`whenConversationStoreReady`)
 * and `/health` answers `{ok:true}` the moment Express is listening, without waiting
 * for it. A webhook fired in that window lands on an EMPTY store, so
 * `ensureConversation()` mints a BRAND-NEW conversation (default mode "suggest", zero
 * message history), the agent drafts a first-touch intro against no context, and the
 * corpus-replay flywheel judges that phantom as a `corpus_replay_regression` — a P1
 * "a merged change broke this turn" alert manufactured entirely by the harness.
 *
 * Observed 2026-07-29 on commit 4d2ada82: four replays of the SAME pinned turn
 * (+17164322105, msg_164a54bdc2231) against the same store produced, in turn, no
 * draft at all, a first-touch intro ("can you tell me what bike you're asking
 * about"), and — in the nightly — an empathy-only line, with the post-turn
 * `conv.mode` flipping between "autopilot" and "suggest" while the harness's
 * `replayMode` was pinned to "autopilot" throughout.
 *
 * Fix direction is fail-safe in one direction only: a replay that cannot prove it ran
 * against the prepared thread must surface as a VISIBLE harness error, never as a
 * customer-facing verdict. An error is triaged; a phantom regression outranks real
 * findings in the work order and costs a revert of good work.
 *
 * Both helpers are PURE so `ci:eval` can pin them (`replay_fidelity:eval`).
 */

/** Emitted by conversationStore's `loadFromDisk` AFTER `hydrateParsedStore` returns. */
const HYDRATION_COMPLETE_LINE = /Loaded\s+\d+\s+conversations\s+from\b/i;

/**
 * True once the temporary API has logged that it finished loading the store.
 * The harness already collects the child's stdout, so this needs no API change and
 * works against an already-deployed dist (the box never builds).
 */
export function hasHydrationCompleted(logs: readonly string[] | null | undefined): boolean {
  if (!Array.isArray(logs)) return false;
  return logs.some(line => HYDRATION_COMPLETE_LINE.test(String(line ?? "")));
}

/**
 * Compose the `<comment>` lines for the synthetic ADF the harness rebuilds for a candidate.
 *
 * WHY (2026-07-30): `adfXmlForCandidate` appended `Customer Comments: ${lead.walkInComment}`
 * unconditionally. For a walk-in ADF the stored lead carries the SAME text in both
 * `lead.inquiry` and `lead.walkInComment`, so the comment was emitted TWICE — the second copy
 * carrying a raw field label. `parseAdfXml` then read that doubled blob back as the inquiry and
 * the agent echoed the label into customer-facing prose. Measured on the 2026-07-30 corpus:
 * 21 of 45 leads with a `walkInComment` duplicate their inquiry exactly, 12 of 700 replay cases
 * were fed the corrupted input, and one draft reached the judge reading
 * "I'll follow up about new and pre-owned Customer Comments: Looking for trike models."
 * Production never re-serializes a lead, so this text could not occur live — the real send for
 * that turn was clean. The corpus replay is the safety net that grades every behavior change,
 * so an input production cannot produce manufactures phantom findings (same failure class as
 * the hydration race above).
 *
 * Fail direction, deliberately one-way: the message BODY's own Inquiry section is authoritative
 * (it is what production actually received for THIS turn), while `walkInComment` is a stored
 * field read off `latestLead` and may belong to a LATER lead on the thread. So the walk-in line
 * is dropped only when it adds NOTHING over the inquiry, and it may never override or extend it.
 * Anything genuinely distinct is kept — 23 of those 45 leads carry a real, different comment,
 * and dropping one would starve the replay of context production had.
 *
 * `preferredDate` / `preferredTime` are deliberately NOT deduped: they are short structured
 * values that could appear coincidentally inside the inquiry prose, and their label is what
 * makes them meaningful.
 */
export type ReplayCommentParts = {
  /** Inquiry section extracted from the replayed message body (authoritative). */
  inquiry?: string | null;
  preferredDate?: string | null;
  preferredTime?: string | null;
  /** Stored walk-in note; may be a duplicate of `inquiry`, or from a later lead. */
  walkInComment?: string | null;
};

/** Lowercase, strip markup, collapse whitespace — CDATA markup is not semantic content. */
function normalizeCommentText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function composeReplayCommentLines(parts: ReplayCommentParts): string[] {
  const inquiry = String(parts.inquiry ?? "").trim();
  const walkIn = String(parts.walkInComment ?? "").trim();

  const lines: string[] = [];
  if (inquiry) lines.push(inquiry);
  if (parts.preferredDate) lines.push(`Preferred date: ${String(parts.preferredDate).trim()}`);
  if (parts.preferredTime) lines.push(`Preferred time: ${String(parts.preferredTime).trim()}`);

  if (walkIn) {
    const normWalkIn = normalizeCommentText(walkIn);
    const normInquiry = normalizeCommentText(inquiry);
    // Drop only when the walk-in note is fully represented by the authoritative inquiry.
    const redundant = normWalkIn.length > 0 && normInquiry.includes(normWalkIn);
    if (!redundant) lines.push(`Customer Comments: ${walkIn}`);
  }

  return lines;
}

/**
 * Pick the stored lead record that belongs to the message being replayed.
 *
 * WHY (2026-07-30): `adfXmlForCandidate` read `conv.latestLead ?? conv.lead`, i.e. the NEWEST
 * lead on the thread, even when replaying an OLDER message. Fields with no message-body
 * fallback (name, vehicle make/color/price, preferredDate/Time, walkInComment) were therefore
 * imported from a lead that arrived AFTER the turn — the harness showed the agent information
 * production could not have had. Measured across the 872 replayable ADF messages on the
 * 2026-07-30 store: 156 picked a lead whose `leadRef` differs from the body's `Ref:`, 96 carried
 * a vehicle contradicting the body's own Year/Vehicle, and 29 a different first name
 * ("Michael" from a later credit app vs the "Mike" production actually received).
 *
 * There is no time-scoped lead to select: the store keeps a single evolving `lead` (mutated in
 * place — `conv.lead.leadRef` can still be the FIRST ref while its `vehicle` has been
 * overwritten by a later one) plus optional `latestLead`/`originalLead`, and NONE of them carry
 * a timestamp. The only usable join key is `leadRef`, which the ADF body also carries as `Ref:`.
 *
 * Fail direction: when the right record cannot be CONFIRMED, the caller must fall back to the
 * message body alone rather than import a possibly-later lead's values. A missing colour is
 * honest; a colour from a different motorcycle is contamination that produces phantom findings.
 * This matches the precedent set by the feed-alias work: prefer missing over wrong.
 */
export type ReplayLeadResolution<TLead> = {
  /** The record to read from — always defined when any candidate was supplied. */
  lead: TLead;
  /**
   * True when this record is CONFIRMED to be the one the replayed message belongs to, either
   * by a `leadRef` match or because the thread is unambiguous (one distinct lead). Callers
   * must not import body-fallback-less fields when this is false.
   */
  matched: boolean;
};

export function resolveReplayLead<TLead extends { leadRef?: unknown }>(input: {
  /** `Ref:` extracted from the replayed message body. */
  bodyRef?: string | null;
  /** Stored records in the caller's current precedence order (latestLead, lead, originalLead). */
  candidates: ReadonlyArray<TLead | null | undefined>;
}): ReplayLeadResolution<TLead> {
  const present = input.candidates.filter((c): c is TLead => Boolean(c));
  if (present.length === 0) return { lead: {} as TLead, matched: false };

  const refOf = (lead: TLead): string => String((lead as any)?.leadRef ?? "").trim();
  const bodyRef = String(input.bodyRef ?? "").trim();

  // 1. The body names a lead ref and a stored record carries it — an exact join.
  if (bodyRef) {
    const exact = present.find(lead => refOf(lead) === bodyRef);
    if (exact) return { lead: exact, matched: true };
  }

  // 2. Every stored record describes the same lead, so there is nothing to confuse.
  const distinctRefs = new Set(present.map(refOf));
  if (distinctRefs.size <= 1) return { lead: present[0], matched: true };

  // 3. Ambiguous: keep the caller's existing precedence but refuse to vouch for it.
  return { lead: present[0], matched: false };
}

/**
 * Is the stored lead's vehicle the same motorcycle the replayed message is about?
 *
 * Guards the vehicle attributes the synthetic ADF has no body fallback for (make, colour,
 * list price). The body's own `Year:` / `Vehicle:` fields are authoritative for the turn, so a
 * stored vehicle that contradicts either one belongs to a different lead and must not be read.
 * Absent evidence is not contradiction: when the body names no vehicle, or the stored record
 * has none, there is nothing to disagree with and the stored value is allowed through.
 */
export function isStoredVehicleConsistentWithBody(input: {
  bodyYear?: string | null;
  bodyModel?: string | null;
  storedYear?: unknown;
  storedModel?: unknown;
}): boolean {
  const bodyYear = String(input.bodyYear ?? "").trim();
  const storedYear = String(input.storedYear ?? "").trim();
  if (bodyYear && storedYear && bodyYear !== storedYear) return false;

  const normModel = (value: unknown): string =>
    String(value ?? "")
      .replace(/harley-?davidson/gi, " ")
      .replace(/[^a-z0-9]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const bodyModel = normModel(input.bodyModel);
  const storedModel = normModel(input.storedModel);
  if (!bodyModel || !storedModel) return true;

  // Either may be the fuller spelling ("FLHTCUTG Tri Glide" vs "Tri Glide").
  return bodyModel.includes(storedModel) || storedModel.includes(bodyModel);
}

export type ReplayFidelityInput = {
  /** `conv.mode` that `prepareCaseData` forced into the prepared snapshot. */
  forcedMode: string | null | undefined;
  /** `conv.mode` read back AFTER the replayed turn. */
  observedMode: string | null | undefined;
  /** false when the conversation could not be read back at all. */
  conversationFound: boolean;
};

export type ReplayFidelityVerdict = { ok: true } | { ok: false; reason: string };

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Did this replay actually run against the thread the harness prepared?
 *
 * The discriminator is `conv.mode`: `prepareCaseData` writes the forced replay mode
 * into the prepared snapshot, and nothing in a correct inbound turn rewrites it —
 * `setConversationMode` is only ever called with "human" (a staff takeover) on the
 * webhook path. So a post-turn mode that is neither the forced mode nor "human" means
 * the store was replaced under us by a freshly-minted default conversation.
 */
export function checkReplayFidelity(input: ReplayFidelityInput): ReplayFidelityVerdict {
  if (!input.conversationFound) {
    return {
      ok: false,
      reason:
        "replayed conversation could not be read back after the turn — the harness never loaded the prepared thread"
    };
  }

  const forced = norm(input.forcedMode);
  const observed = norm(input.observedMode);

  // Nothing to compare against: don't invent an error.
  if (!forced) return { ok: true };

  // A staff takeover during the turn legitimately rewrites the mode.
  if (observed === "human") return { ok: true };

  if (!observed) {
    return {
      ok: false,
      reason: `replayed conversation lost its mode (expected "${forced}") — the prepared thread was replaced mid-replay`
    };
  }

  if (observed !== forced) {
    return {
      ok: false,
      reason:
        `replayed conversation mode is "${observed}" but the harness prepared "${forced}" — ` +
        "the turn landed on a freshly-created conversation (async store hydration race), so its draft " +
        "was produced without the prepared history and must not be judged"
    };
  }

  return { ok: true };
}

/**
 * Who failed: the HARNESS (the turn never reached the agent) or the AGENT (it ran and
 * misbehaved)?
 *
 * WHY (measured 2026-08-04): the nightly replay boots ONE temporary API per case out of
 * `services/api/dist`, in the SAME deploy checkout a deploy runs `npm ci` in. The 08-04
 * sweep started 05:00Z; a deploy landed ~05:06Z, and cases 27-55 — a perfectly contiguous
 * block of 29 — died booting with `ERR_MODULE_NOT_FOUND` against SIX different packages
 * (`dotenv`, `@sentry/node`, `@sentry/core`, `googleapis`, `import-in-the-middle`) as
 * `node_modules` was rewritten under them. Six unrelated packages vanishing and returning
 * inside one window is an install, not a code defect. The night before: 1 failure in 700.
 *
 * The damage was NOT the lost turns, it was what they were scored as. `scoreTurn` folds
 * `verdict === "error"` into `critical`, so those 29 became **9 of the 12 criticals** in the
 * sweep — 75% of the release-BLOCKING signal — and `gate_pass` went false. Each also minted a
 * per-conversation P1 `corpus_replay_error` work order reading `draft: "(none)"`, i.e. a
 * finding that blames the agent for a reply it was never asked to write. Every routine then
 * re-triages them. Same phantom family as the hydration race above: a harness fault wearing a
 * customer-facing verdict's clothes.
 *
 * FAIL DIRECTION, deliberately one-way: an UNRECOGNISED error is "agent". Calling a real agent
 * failure "harness" would excuse it from the gate and delete it from the feed — silently
 * shrinking the safety net — while calling a harness failure "agent" only reproduces today's
 * noise. So this widens only on evidence, and the default surfaces.
 *
 * Pure, so `ci:eval` can pin it (`replay_fidelity:eval`).
 */
export type ReplayErrorCause = "harness" | "agent";

/**
 * Failures that prove the temporary API never got far enough to answer for the agent.
 * Every one of these is thrown by the harness itself (`inbound_shadow_replay.ts`) BEFORE or
 * INSTEAD OF a draft, or by node while loading that process.
 */
const HARNESS_ERROR_PATTERNS: readonly RegExp[] = [
  // startApi / waitForHealth / waitForPreparedConversation — the boot never completed.
  /temporary API exited early/i,
  /temporary API did not become healthy/i,
  /temporary API exited before the prepared thread loaded/i,
  // The build the harness replays against is absent.
  /dist\/index\.js is missing/i,
  // checkReplayFidelity's backstop: it ran, but not against the prepared thread.
  /replay fidelity:/i,
  // findFreePort.
  /no free port assigned/i,
  // node's own module resolution — the concurrent-install signature.
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find package '/i,
  /Cannot find module '/i
];

export function classifyReplayErrorCause(errorText: string | null | undefined): ReplayErrorCause {
  const text = String(errorText ?? "");
  if (!text.trim()) return "agent";
  return HARNESS_ERROR_PATTERNS.some(re => re.test(text)) ? "harness" : "agent";
}
