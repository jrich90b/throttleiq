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
