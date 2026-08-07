/**
 * REP-CALL QUIET WINDOW — the phone counts as reaching the customer.
 *
 * THE DEFECT (measured 2026-08-06, americanharley live store). The staff send endpoint already
 * hushes the proactive cadence for 24h after a rep types to a customer
 * (`pauseCadenceAfterManualOutbound`, `/conversations/:id/send`), and the cadence loop separately
 * benches itself when `hasRecentDeliveredHumanOutbound` sees a delivered `provider: "human"` row.
 * Both of those read TYPED messages only. A rep PHONING the customer is recorded as
 * `provider: "voice_call"` and was invisible to both, so an automated touch could land on top of a
 * rep's call:
 *
 *   +17164815358 (Gary) — 2026-07-21 15:54Z Gio calls and leaves a voicemail: *"just wanna give you
 *   a call and see if you're still interested in a Street Bob. I do have three of them here."*
 *   2026-07-21 16:42Z, 48 minutes later, the cadence auto-sends *"Quick follow-up — if timing
 *   changed, just let me know."* The cadence-quality judge graded that touch `suppress` at 0.88
 *   ("contentless, generic ping ... terse and a bit robotic").
 *
 * BLAST RADIUS, measured before writing this. Of the 90 conversations carrying a judged proactive
 * touch, exactly ONE was benched by a typed human outbound inside 14 days, while **23** had a rep
 * phone call in that window that counted for nothing. Narrowed to the window this guard actually
 * uses, **6** of the 90 fired within a day of a rep's call. The broad 14-day question — should a
 * phone call bench the cadence the way a typed message does — is deliberately NOT settled here: at
 * 23/90 it would route roughly a quarter of proactive touches into a staff draft queue that runs
 * ~93% stale, which is the lead-ghosting hazard `cadenceQualityConsensus.ts` documents. That is a
 * policy call, not a bug fix.
 *
 * DETERMINISTIC ON PURPOSE, and allowed to be. This is a STATE predicate over a message row's
 * provider and timestamp — structured extraction, AGENTS.md's deterministic carve-out — not
 * comprehension. Nothing here reads what anyone SAID. `openCustomerTurn.ts` already makes exactly
 * this call for exactly this provider ("a placed call is real contact with the customer").
 *
 * FAIL DIRECTION: it DEFERS, it never drops. The caller feeds the result to `setBlockUntil`, which
 * bumps `nextDueAt` and leaves `stepIndex` alone, so a quieted touch fires a day later rather than
 * being skipped. Returning `quiet: false` is today's behaviour exactly. It cannot silence a lead.
 *
 * Pinned by scripts/rep_call_quiet_window_eval.ts (ci:eval).
 */

/** A rep's placed call, one day. Same 24h the staff manual-send pause already uses. */
export const REP_CALL_QUIET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Only what this module reads, so the caller can pass raw store rows. */
export type RepCallMessage = {
  direction?: string | null;
  provider?: string | null;
  delivered?: boolean | null;
  at?: string | null;
};

export type RepCallQuietDecision = {
  /** Hold this tick's proactive touch back? */
  quiet: boolean;
  /** The call that caused it, for the log line. */
  callAt: string | null;
  /** Epoch ms the quiet window ends — feed straight to setBlockUntil. */
  quietUntilMs: number | null;
  why: string;
};

/**
 * Our own NOTES about a call — a summary and a transcript are written after the fact and must not
 * start a second quiet window of their own. Mirrors `NOTE_ONLY_PROVIDERS` in openCustomerTurn.ts.
 */
const NOTE_ONLY_PROVIDERS = new Set(["voice_summary", "voice_transcript"]);

function isPlacedRepCall(msg: RepCallMessage | null | undefined): boolean {
  if (!msg || msg.direction !== "out") return false;
  const provider = String(msg.provider ?? "");
  if (NOTE_ONLY_PROVIDERS.has(provider)) return false;
  if (provider !== "voice_call") return false;
  // Absent means delivered (pre-marker history) — the same convention agentVoice.ts uses.
  return msg.delivered !== false;
}

export function decideRepCallQuietWindow(input: {
  messages: ReadonlyArray<RepCallMessage | null | undefined> | null | undefined;
  nowMs: number;
  windowMs?: number;
}): RepCallQuietDecision {
  const quiet: RepCallQuietDecision = {
    quiet: false,
    callAt: null,
    quietUntilMs: null,
    why: "no rep call inside the quiet window"
  };
  const messages = input?.messages;
  if (!Array.isArray(messages)) return quiet;
  const nowMs = Number(input?.nowMs);
  if (!Number.isFinite(nowMs)) return quiet;
  const rawWindow = Number(input?.windowMs ?? REP_CALL_QUIET_WINDOW_MS);
  const windowMs = Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : REP_CALL_QUIET_WINDOW_MS;

  let latestMs: number | null = null;
  let latestAt: string | null = null;
  for (const msg of messages) {
    if (!isPlacedRepCall(msg)) continue;
    const atMs = new Date(String(msg?.at ?? "")).getTime();
    if (!Number.isFinite(atMs)) continue;
    // A call in the FUTURE is a clock artefact, not contact — ignore it rather than quieting for
    // a day from a bad timestamp.
    if (atMs > nowMs) continue;
    if (nowMs - atMs >= windowMs) continue;
    if (latestMs == null || atMs > latestMs) {
      latestMs = atMs;
      latestAt = String(msg?.at ?? "");
    }
  }
  if (latestMs == null) return quiet;

  return {
    quiet: true,
    callAt: latestAt,
    quietUntilMs: latestMs + windowMs,
    why: "a rep phoned this customer inside the quiet window — let the call land before texting"
  };
}
