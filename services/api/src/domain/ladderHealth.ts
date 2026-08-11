/**
 * LADDER HEALTH — is each lead lane still ADVANCING leads? (Joe, 2026-08-11.)
 *
 * WHY THIS EXISTS, and why the existing nets could not do it. The loop's three detection nets all ask
 * the same shape of question — *was this reply WRONG?* `conversation_outcome_audit` hunts state that
 * contradicts itself; `open_critic_sweep` asks "did we mishandle this lead?"; `intent_handled_audit`
 * asks "did we answer the right thing?". **A broken ladder is none of those.** A lead that never gets
 * asked anything has perfectly consistent state and a polite, on-topic reply. You only see the problem
 * when you count forty of them.
 *
 * MEASURED, and this is the whole argument: on 2026-08-11 the loop's work queue was EMPTY while
 * 35 of 37 walk-in first touches asked nothing, 11 approved credit applications had booked zero, and
 * 8% of active conversations were repeating a question word for word. Months of it, invisible, because
 * every net was per-conversation and every individual reply looked fine.
 *
 * The readiness bar cannot cover it either: one lane going dark is ~40 leads inside a 500-lead
 * average, a fraction of a percent.
 *
 * WHAT THIS IS: a COUNT, not a judgement. No LLM, no taxonomy — "how many of this lane's first touches
 * asked the customer anything, and how does that compare with the lane's own history?" A lane that
 * drops from 90% asking to 5% is unmistakable and needs nobody's opinion.
 *
 * THE THREE ALARMS, and why they are separate — each sends you to a different building:
 *   `ask_rate_collapsed` — the lane USED to ask and stopped. A regression; reproduce it, then fix code.
 *   `never_asks`         — the lane likely never had a ladder. A build candidate; write the copy.
 *   `uncontactable`      — the leads carry no phone and no email. Neither of the above: no wording
 *                          change can reach someone with no address, so the fix is upstream in the
 *                          vendor feed. Added 2026-08-11 after `never_asks` sent a run hunting for
 *                          missing copy on AutoDealers.Digital, whose 18 leads had nobody to send to.
 *
 * FAIL DIRECTION: it only ever REPORTS. It cannot hold a reply, change a route, or fail a deploy. The
 * worst a false alarm costs is one person reading one line.
 */

export type LadderWindowCounts = {
  leads: number;
  asked: number;
  replied: number;
  booked: number;
  /**
   * Leads carrying a phone number or an email address — i.e. someone we can actually reach.
   *
   * Counted because a lane can score 0% asked for two completely different reasons, and the fix is in
   * a different building for each: no ladder (write one) versus nobody to send it to (call the vendor).
   */
  contactable: number;
};

export type LadderLaneHealth = {
  source: string;
  /** Set when the lane is DECLARED as having no ladder — carries the reason, and suppresses alarms. */
  noLadderByDesign?: string | null;
  recent: LadderWindowCounts;
  baseline: LadderWindowCounts;
  askRateRecent: number | null;
  askRateBaseline: number | null;
  alarm: "ask_rate_collapsed" | "never_asks" | "uncontactable" | null;
  why: string;
};

export type LadderHealthReport = {
  windowDays: number;
  baselineDays: number;
  lanes: LadderLaneHealth[];
  alarms: LadderLaneHealth[];
  summary: { lanesScanned: number; leadsRecent: number; askedRecent: number; bookedRecent: number };
};

/**
 * A lane needs this many leads in the recent window before an alarm may fire at all.
 *
 * MEASURED PRECEDENT: the canary's ratio rule tripped on a healthy build because an 8-hour slice
 * carried ~2 drafts — "a x2 ratio rule on a base that small trips on ordinary variation". Most lanes
 * here run single digits per month, so the floor is absolute, not a ratio.
 */
/**
 * LANES THAT DELIBERATELY HAVE NO LADDER, each with the reason.
 *
 * This list is the point, not an escape hatch. Without it the sweep flags `Traffic Log Pro` — a VOICE
 * lane whose first "message" is literally "Call initiated to +1716…" — on every single run, and an
 * instrument that always shows a false alarm gets ignored, which is worse than no instrument.
 *
 * It also does the job of a coverage registry, in the only way that matters: a NEW source we have
 * never seen either starts asking, or shows up here with a reason, or alarms. **It does not demand a
 * ladder; it demands a decision** — the same contract `decision_registry_coverage:eval` uses for
 * referees.
 *
 * ⚠️ Adding a lane here is a claim that pushing an appointment on it would be WRONG. It is not a way
 * to quiet a lane we simply have not got to yet.
 */
export const NO_LADDER_LANES: { pattern: RegExp; why: string }[] = [
  { pattern: /traffic log pro/i, why: "a VOICE lane — the first outbound is a call, not a text" },
  { pattern: /walk\s*in/i, why: "they are already standing in the store" },
  { pattern: /ride challenge|sweeps|rsvp/i, why: "a marketing signup, not a buyer" },
  { pattern: /riding academy/i, why: "course enrolment, not a motorcycle purchase" }
];

export function laneHasNoLadderByDesign(source: string): string | null {
  return NO_LADDER_LANES.find(l => l.pattern.test(source))?.why ?? null;
}

export const LADDER_MIN_RECENT_LEADS = 5;
/** Never-asked needs a bigger base: a lane can legitimately go 5 quiet leads without a ladder break. */
export const LADDER_MIN_NEVER_ASKS_LEADS = 8;
/** A collapse means the lane USED to ask and now does not. Step change, not a wobble. */
export const LADDER_HEALTHY_ASK_RATE = 0.7;
export const LADDER_COLLAPSED_ASK_RATE = 0.3;

/**
 * Did this message ask the customer anything?
 *
 * ⚠️ Strips URLs first. A credit-application link carries `?dealerid=` and is not a question — the
 * same trap that made an earlier repeat-detector count links as questions (2026-08-11).
 */
export function messageAsksSomething(body: string | null | undefined): boolean {
  return String(body ?? "").replace(/https?:\/\/\S+/g, " ").includes("?");
}

function emptyCounts(): LadderWindowCounts {
  return { leads: 0, asked: 0, replied: 0, booked: 0, contactable: 0 };
}

/**
 * Can we reach this lead at all — is there a phone number or an email address on it?
 *
 * Deliberately generous: ANY non-empty phone or email counts. The point is to separate "we have a way
 * in and did not use it" from "the feed handed us a name and a stock number and nothing else", and a
 * false "yes" simply leaves the lane on today's `never_asks` diagnosis.
 */
export function leadIsContactable(conv: any): boolean {
  const lead = conv?.lead ?? {};
  return !!String(lead.phone ?? "").trim() || !!String(lead.email ?? "").trim();
}

function rate(counts: LadderWindowCounts): number | null {
  return counts.leads > 0 ? counts.asked / counts.leads : null;
}

export function assessLadderHealth(input: {
  conversations: any[];
  now: Date | number;
  windowDays?: number;
  baselineDays?: number;
}): LadderHealthReport {
  const nowMs = typeof input.now === "number" ? input.now : input.now.getTime();
  const windowDays = input.windowDays ?? 30;
  const baselineDays = input.baselineDays ?? 60;
  const recentFrom = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const baselineFrom = recentFrom - baselineDays * 24 * 60 * 60 * 1000;

  const lanes = new Map<string, { recent: LadderWindowCounts; baseline: LadderWindowCounts }>();
  for (const conv of input.conversations ?? []) {
    const createdAt = Date.parse(String(conv?.createdAt ?? ""));
    if (!Number.isFinite(createdAt) || createdAt < baselineFrom) continue;
    const bucket = createdAt >= recentFrom ? "recent" : "baseline";
    const source = String(conv?.lead?.source ?? "").trim() || "(no source)";
    if (!lanes.has(source)) lanes.set(source, { recent: emptyCounts(), baseline: emptyCounts() });
    const counts = lanes.get(source)![bucket as "recent" | "baseline"];
    counts.leads += 1;
    if (leadIsContactable(conv)) counts.contactable += 1;

    const messages: any[] = Array.isArray(conv?.messages) ? conv.messages : [];
    const outbound = messages.filter(m => String(m?.direction) === "out");
    const firstOut = outbound[0];
    if (firstOut && messageAsksSomething(firstOut.body)) counts.asked += 1;

    const firstOutAt = Date.parse(String(firstOut?.at ?? ""));
    if (
      Number.isFinite(firstOutAt) &&
      messages.some(m => String(m?.direction) === "in" && Date.parse(String(m?.at ?? "")) > firstOutAt)
    ) {
      counts.replied += 1;
    }
    if (conv?.appointment?.whenIso || conv?.appointment?.whenText) counts.booked += 1;
  }

  const out: LadderLaneHealth[] = [];
  for (const [source, w] of lanes) {
    const askRateRecent = rate(w.recent);
    const askRateBaseline = rate(w.baseline);
    let alarm: LadderLaneHealth["alarm"] = null;
    let why = "healthy or below the reporting floor";

    const byDesign = laneHasNoLadderByDesign(source);
    if (byDesign) {
      why = `no ladder by design: ${byDesign}`;
    } else if (w.recent.leads >= LADDER_MIN_RECENT_LEADS) {
      const collapsed =
        w.baseline.leads >= LADDER_MIN_RECENT_LEADS &&
        (askRateBaseline ?? 0) >= LADDER_HEALTHY_ASK_RATE &&
        (askRateRecent ?? 0) <= LADDER_COLLAPSED_ASK_RATE;
      if (collapsed) {
        alarm = "ask_rate_collapsed";
        why = `this lane used to ask (${Math.round((askRateBaseline ?? 0) * 100)}%) and now does not (${Math.round((askRateRecent ?? 0) * 100)}%)`;
      } else if (w.recent.leads >= LADDER_MIN_NEVER_ASKS_LEADS && w.recent.contactable === 0) {
        // NOT a ladder problem. MEASURED 2026-08-11 on AutoDealers.Digital: 18 of 18 recent leads
        // carry no phone and no email — the ADF is a name, a stock number and "Inquiry: Lead arrived".
        // The three that appeared to have an address had the DEALER's own (gio@americanharley-…), which
        // the ADF parser correctly refused to store. Every other lane in the same window is ~100%
        // contactable, so this test discriminates rather than blankets.
        //
        // It still ALARMS — a lane we cannot reach is a real problem — but calling it `never_asks` sent
        // a run hunting for missing copy, and no wording change can reach someone with no address. The
        // fix is upstream, with the vendor feed.
        //
        // Checked BEFORE never_asks on purpose: a lane with nobody to reach obviously never asks, so
        // whichever runs first owns the diagnosis, and the contact defect is the deeper cause.
        alarm = "uncontactable";
        why = `${w.recent.leads} leads and not one carries a phone or an email — nothing we write can reach them; this is a lead-feed defect, not a missing ladder`;
      } else if (
        w.recent.leads >= LADDER_MIN_NEVER_ASKS_LEADS &&
        w.recent.asked === 0 &&
        w.baseline.asked === 0
      ) {
        // Not a break — a lane that never had a ladder at all.
        alarm = "never_asks";
        why = `${w.recent.leads} leads and not one first touch asked anything — this lane may have no ladder`;
      }
    }
    out.push({ source, noLadderByDesign: byDesign, recent: w.recent, baseline: w.baseline, askRateRecent, askRateBaseline, alarm, why });
  }

  out.sort((a, b) => b.recent.leads - a.recent.leads);
  return {
    windowDays,
    baselineDays,
    lanes: out,
    alarms: out.filter(l => l.alarm),
    summary: {
      lanesScanned: out.length,
      leadsRecent: out.reduce((n, l) => n + l.recent.leads, 0),
      askedRecent: out.reduce((n, l) => n + l.recent.asked, 0),
      bookedRecent: out.reduce((n, l) => n + l.recent.booked, 0)
    }
  };
}
