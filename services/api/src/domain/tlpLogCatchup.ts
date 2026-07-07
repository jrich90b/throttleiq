/**
 * TLP CRM-log catch-up sweep (2026-07-06) — the self-healing half of the crm_log_stale fix.
 *
 * The serialized TLP queue (index.ts tlpLogChain) is IN-MEMORY fire-and-forget: a pm2
 * restart/crash between "send" and "log" silently drops every queued job — no failure is
 * recorded, so nothing retries and the CRM gap is permanent until a later send happens to
 * re-log the thread. Production case (7/6 daily review): Kellen +17167995197's post-sale
 * Custom Coverage reminder sent 7/3 14:30 was never logged (crm={}), while Plinio
 * +17162280349's send in the SAME tick second logged fine — his job ran before the chain
 * died, Kellen's didn't.
 *
 * This module is the PURE candidate decision for a periodic catch-up tick: find
 * conversations whose latest REAL outbound (twilio/sendgrid/human — never a draft_ai row,
 * which was never sent) is newer than their last CRM log, wait out a grace window so the
 * normal send-path log can land first, and return a small oldest-first batch. The tick
 * re-queues them through the SAME serialized logger, which is idempotent by construction
 * (buildTranscript logs only messages since crm.lastLoggedAt and skips on count===0), so a
 * double-fire costs one no-op browser pass, never a duplicate CRM note.
 *
 * FAIL DIRECTION: unsure => skip. A missed catch-up self-heals on the next sweep; garbage
 * input (no leadRef, unparseable timestamps) must never enqueue a Chromium job.
 *
 * RETRY BACK-OFF (2026-07-07): a permanently-failing log (e.g. lead missing in the CRM —
 * refs 10966/11252/10937 observed 7/7) must not pin the oldest-gap-first batch and burn a
 * Chromium rescue every sweep. The sweep stamps crm.lastCatchupAttemptAt when it enqueues;
 * the wait before the NEXT attempt equals how long the gap had already persisted at that
 * attempt (clamped to [minBackoff, maxBackoff]), so retries double away organically —
 * ~30m, 1h, 2h, 4h ... then daily until the lookback ages the gap out. The back-off only
 * ever delays a RETRY of the same stuck gap: it is ignored when the log SUCCEEDED since
 * the attempt (lastLoggedAt advanced past it) or a NEW outbound landed since (a newer
 * send resets the clock), and an unparseable stamp counts as no stamp — a conversation is
 * never silently blocked for good.
 */

export type TlpCatchupMessage = {
  direction?: string;
  provider?: string;
  at?: string;
  draftStatus?: string;
};

export type TlpCatchupConversation = {
  id?: string;
  lead?: { leadRef?: string | null } | null;
  latestLead?: { leadRef?: string | null } | null;
  crm?: { lastLoggedAt?: string | null; lastCatchupAttemptAt?: string | null } | null;
  messages?: TlpCatchupMessage[] | null;
};

export type TlpCatchupOptions = {
  /** Wait this long after the outbound before catching up — the normal send-path log
   *  (serialized queue) usually lands within a couple of minutes. Default 20. */
  graceMinutes?: number;
  /** Max conversations per sweep — the logger launches one Chromium per job (serialized),
   *  so a big first-run backlog must drain over multiple sweeps, not one. Default 5. */
  maxBatch?: number;
  /** Ignore outbounds older than this — ancient unlogged history is stale CRM value and
   *  a first-rollout Chromium storm. Default 30. */
  lookbackDays?: number;
  /** Floor for the retry back-off after a stamped catch-up attempt — a fresh transient
   *  failure (portal hiccup) still retries on the next sweep. Default 30 (one sweep). */
  minBackoffMinutes?: number;
  /** Ceiling for the retry back-off — even a permanently-failing log retries daily, so a
   *  lead created late in the CRM still heals without manual action. Default 24. */
  maxBackoffHours?: number;
};

/** Providers that mean the message actually REACHED the customer. draft_ai rows are
 *  console drafts (never sent); anything unknown fails toward skip. */
const REAL_OUTBOUND_PROVIDERS = new Set(["twilio", "sendgrid", "human"]);

function latestRealOutboundAtMs(messages: TlpCatchupMessage[] | null | undefined): number {
  let latest = Number.NaN;
  for (const m of messages ?? []) {
    if ((m?.direction ?? "") !== "out") continue;
    if (!REAL_OUTBOUND_PROVIDERS.has(String(m?.provider ?? "").toLowerCase())) continue;
    const t = Date.parse(String(m?.at ?? ""));
    if (!Number.isFinite(t)) continue;
    if (!Number.isFinite(latest) || t > latest) latest = t;
  }
  return latest;
}

export function findTlpLogCatchupCandidates(
  convs: TlpCatchupConversation[],
  nowMs: number,
  opts: TlpCatchupOptions = {}
): string[] {
  const graceMs = Math.max(1, opts.graceMinutes ?? 20) * 60 * 1000;
  const maxBatch = Math.max(1, opts.maxBatch ?? 5);
  const lookbackMs = Math.max(1, opts.lookbackDays ?? 30) * 24 * 60 * 60 * 1000;
  const minBackoffMs = Math.max(1, opts.minBackoffMinutes ?? 30) * 60 * 1000;
  const maxBackoffMs = Math.max(1, opts.maxBackoffHours ?? 24) * 60 * 60 * 1000;

  const candidates: { id: string; outboundAt: number }[] = [];
  for (const conv of convs ?? []) {
    const id = String(conv?.id ?? "").trim();
    if (!id) continue;
    // No leadRef anywhere => the logger would skip anyway; don't burn a queue slot.
    const leadRef = String(conv?.lead?.leadRef ?? conv?.latestLead?.leadRef ?? "").trim();
    if (!leadRef) continue;
    const outboundAt = latestRealOutboundAtMs(conv?.messages);
    if (!Number.isFinite(outboundAt)) continue;
    if (nowMs - outboundAt < graceMs) continue; // normal send-path log may still be in flight
    if (nowMs - outboundAt > lookbackMs) continue; // stale history — not worth a browser job
    const lastLoggedAt = Date.parse(String(conv?.crm?.lastLoggedAt ?? ""));
    if (Number.isFinite(lastLoggedAt) && lastLoggedAt >= outboundAt) continue; // already logged
    // Retry back-off (see header). Applies ONLY when the stamped attempt is for THIS same
    // stuck gap: a newer outbound or a lastLoggedAt advance past the attempt means the
    // world moved on — the stamp is stale and must never delay the catch-up. Unparseable
    // stamp => no back-off (fail toward retrying, never toward a silent permanent gap).
    const lastAttemptAt = Date.parse(String(conv?.crm?.lastCatchupAttemptAt ?? ""));
    if (
      Number.isFinite(lastAttemptAt) &&
      outboundAt <= lastAttemptAt &&
      !(Number.isFinite(lastLoggedAt) && lastLoggedAt > lastAttemptAt)
    ) {
      const backoffMs = Math.min(maxBackoffMs, Math.max(minBackoffMs, lastAttemptAt - outboundAt));
      if (nowMs - lastAttemptAt < backoffMs) continue; // still waiting out the last failure
    }
    candidates.push({ id, outboundAt });
  }

  // Oldest gap first — long-unlogged threads drain ahead of fresh ones.
  candidates.sort((a, b) => a.outboundAt - b.outboundAt);
  return candidates.slice(0, maxBatch).map(c => c.id);
}
