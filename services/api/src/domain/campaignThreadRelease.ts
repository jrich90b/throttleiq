/**
 * CAMPAIGN-THREAD RELEASE (2026-08-22) — a blast tag must not hide a brand-new lead.
 *
 * Joe, 2026-08-22, on Matt Weiser: *"That lead was buried in campaigns which is confusing to find."*
 *
 * WHAT HAPPENS. A campaign blast tags every recipient thread. The tagging is deliberate and correct:
 * `POST /campaigns/send` writes `campaignThread.status = "campaign"` when the thread was CLOSED or
 * already campaign-tagged, and `"linked_open"` when it was a live open thread — and the console
 * skips `status === "campaign"` in the working Inbox (`apps/web/src/app/page.tsx:7893`). Without
 * that, one send to "All contacts" would bury the real work under 151 blast recipients.
 *
 * THE GAP. Nothing puts a thread BACK when it becomes live again. The only release is
 * `hasInboundCampaignReplyAfter` (index.ts), and it contains this line:
 *
 *     if (provider === "sendgrid_adf") continue;
 *
 * That exclusion is RIGHT for the question it answers — an ADF web lead is not the customer replying
 * to your campaign text, and counting it as one would inflate campaign response. **But it is also
 * the only gate on visibility**, so the single strongest piece of evidence that a thread is alive
 * again — the customer filling in a brand-new web form — is the one signal that cannot free it.
 *
 * MEASURED THE SAME DAY. 151 threads carry `status: "campaign"`, all from one "250 Years Of Freedom
 * SMS" send to All contacts on 2026-07-16. Two have since received a new ADF web lead:
 *   • `+17165072289` Matt Weiser — 2026-08-21 14:55, `Trade Accelerator - Trade In`, ref 11822,
 *     a 2007 FXDWG Dyna Wide Glide trade. A draft was composed 6 seconds later and never sent.
 *     Joe could not find him; the thread reads as an April lead who said "Not now".
 *   • `+17164182738` — 2026-08-10.
 * So: exposure 151, realized harm 2 — a real bug with a wide blast radius and a small instance
 * count so far. It re-arms every time anyone on that list comes back, and the list was everyone.
 *
 * ⚠️ THE FIX IS NOT "DELETE THE ADF EXCLUSION". That predicate answers "did they reply to the
 * campaign?" and its answer is correct. Two different questions need two different predicates, so
 * this module adds the second one and leaves the first exactly as it is.
 *
 * WHAT RELEASE MEANS. It moves the thread to `"linked_open"` — a state the design ALREADY uses for
 * "campaign-tagged, but belongs in the working Inbox". No new state, no new reply class, no new
 * copy, and the campaign attribution (`campaignId`, `campaignName`, `listId`, send stamps) is
 * preserved untouched, so reporting still knows this contact was on the blast.
 *
 * FAIL DIRECTION: toward SHOWING work. A wrong release puts one already-handled thread back in the
 * Inbox, where staff see it and move on. A wrong hide loses a live lead — which is what happened.
 *
 * Pure + IO-free. Called from the ADF landing path in routes/sendgridInbound.ts; pinned by
 * scripts/campaign_thread_release_eval.ts.
 */

export type CampaignThreadState = {
  status?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  listId?: string | null;
  listName?: string | null;
  firstSentAt?: string | null;
  lastSentAt?: string | null;
  [k: string]: unknown;
};

export type CampaignReleaseDecision = {
  /** True when the caller should write `campaignThread`. */
  changed: boolean;
  /** The value to write. Identical to the input when `changed` is false. */
  campaignThread: CampaignThreadState | null;
  /** Plain-words reason, for the route trace. Null when nothing changed. */
  reason: string | null;
};

/** The status a blast gives a thread it is hiding from the working Inbox. */
const HIDDEN_STATUS = "campaign";
/** The status the design already uses for "campaign-tagged, but show it in the Inbox". */
const RELEASED_STATUS = "linked_open";

function parseMs(value: unknown): number | null {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether a NEW inbound web lead should release a campaign-hidden thread back to the Inbox.
 *
 * Releases only when every one of these holds — anything unproven leaves the thread as it is:
 *  1. the thread is currently HIDDEN (`status === "campaign"`); any other status is already visible,
 *     or is a deliberate later state (`passed`) this must not walk back;
 *  2. a genuine new lead arrived (the caller vouches for `isNewWebLead`);
 *  3. the lead is datable AND lands strictly AFTER the blast. A lead that predates the send is the
 *     history the blast was tagged onto, not a reason to un-hide. An undatable lead proves nothing.
 */
export function resolveCampaignThreadOnNewLead(args: {
  campaignThread: CampaignThreadState | null | undefined;
  isNewWebLead: boolean;
  leadReceivedAtIso?: string | null;
}): CampaignReleaseDecision {
  const current = args.campaignThread ?? null;
  const unchanged: CampaignReleaseDecision = { changed: false, campaignThread: current, reason: null };

  if (!current || !args.isNewWebLead) return unchanged;
  if (String(current.status ?? "").trim().toLowerCase() !== HIDDEN_STATUS) return unchanged;

  const leadMs = parseMs(args.leadReceivedAtIso);
  if (leadMs == null) return unchanged; // cannot prove it is new ⇒ leave it hidden

  // `firstSentAt` is the blast boundary. Missing/unparseable ⇒ we cannot prove the lead postdates
  // the send, so we do not act — the same fail-safe the rest of this file keeps.
  const sentMs = parseMs(current.firstSentAt) ?? parseMs(current.lastSentAt);
  if (sentMs == null || leadMs <= sentMs) return unchanged;

  return {
    changed: true,
    // Spread FIRST so the campaign attribution survives; only `status` is overwritten.
    campaignThread: { ...current, status: RELEASED_STATUS, releasedAt: new Date(leadMs).toISOString() },
    reason:
      `a new web lead arrived ${new Date(leadMs).toISOString()}, after the campaign send ` +
      `${new Date(sentMs).toISOString()} — releasing the thread to the working Inbox ` +
      `(campaign attribution kept)`
  };
}
