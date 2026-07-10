/**
 * Loop digest — the "surface" step of the self-healing loop. DETECT writes a tier-tagged work order to
 * reports/anomaly_loop/next.json, but nothing read it — findings piled up unseen. This formats that work
 * order into a human-readable digest emailed to the operator so the loop's findings actually reach a human:
 * Joe skims it, confirms/dismisses, and that review is BOTH the precision signal for the cross-model critic
 * AND the graduation input for the tier ladder. Pure + deterministic (the script does the file read + send).
 *
 * Tier 2 (needs your review — unconfirmed/behavioral) is listed first; Tier 1 (safe auto-patch candidates)
 * second. Nothing auto-merges yet, so the digest is the human-in-the-loop until the ACT runner lands.
 */

export type LoopWorkOrder = {
  convId?: string | null;
  leadKey?: string | null;
  dimension?: string | null;
  category?: string | null;
  severity?: string | null;
  tier?: number | null;
  action?: string | null;
  notify?: boolean;
  autoMergeEligible?: boolean;
  persistent?: boolean;
  detail?: string | null;
  firstSeenAt?: string | null;
  ageDays?: number | null;
};

export type LoopDigestPayload = {
  generatedAt?: string | null;
  feedGeneratedAt?: string | null;
  totalAnomalies?: number | null;
  workOrderCount?: number | null;
  byTier?: Record<string, number> | null;
  byAction?: Record<string, number> | null;
  notifyCount?: number | null;
  workOrders?: LoopWorkOrder[] | null;
  stop?: boolean;
};

export type LoopDigest = { subject: string; text: string; hasContent: boolean };

const MAX_ITEMS = 30;

function fmtItem(w: LoopWorkOrder): string {
  const t = `T${w.tier ?? "?"}`;
  const sev = String(w.severity ?? "").trim();
  const who = [w.convId, w.leadKey].filter(Boolean).join(" / ") || "(no conv id)";
  const tags = [w.persistent ? "persistent" : "", w.autoMergeEligible ? "auto-merge-eligible" : ""].filter(Boolean).join(", ");
  const tagStr = tags ? ` [${tags}]` : "";
  return `  • [${t} ${w.action ?? "?"}${sev ? ` · ${sev}` : ""}] ${w.dimension ?? "?"}${tagStr}\n      ${String(w.detail ?? "").trim()}\n      conv: ${who}`;
}

export function formatLoopDigest(payload: LoopDigestPayload, opts: { dealer?: string } = {}): LoopDigest {
  const dealer = opts.dealer ? ` (${opts.dealer})` : "";
  const orders = Array.isArray(payload.workOrders) ? payload.workOrders : [];
  const count = payload.workOrderCount ?? orders.length;
  const notifyCount = payload.notifyCount ?? orders.filter(o => o.notify).length;

  if (!count) {
    return {
      hasContent: false,
      subject: `LeadRider agent-watch${dealer} — all clear`,
      text: `No open findings as of ${payload.generatedAt ?? "now"}. The self-healing loop scanned the store and the turn-critic found nothing that needs review.`
    };
  }

  const tier2 = orders.filter(o => (o.tier ?? 0) === 2);
  const tier1 = orders.filter(o => (o.tier ?? 0) === 1);
  const other = orders.filter(o => (o.tier ?? 0) !== 1 && (o.tier ?? 0) !== 2);

  const lines: string[] = [];
  lines.push(`LeadRider agent-watch digest${dealer}`);
  lines.push(`${count} finding(s) — ${notifyCount} need your review. Generated ${payload.generatedAt ?? "now"} (feed ${payload.feedGeneratedAt ?? "?"}).`);
  if (payload.byTier) {
    lines.push(`By tier: T2 ${payload.byTier["2"] ?? 0} (needs review) / T1 ${payload.byTier["1"] ?? 0} (safe auto-patch) / T0 ${payload.byTier["0"] ?? 0} (reconcile-handled).`);
  }
  // The AGE CLOCK (Joe, 2026-07-09: reports were "building… and aren't touched for a while"):
  // lead with how stale the queue is, so an aging decision is impossible to miss.
  const aged = orders.filter(o => Number(o.ageDays ?? 0) > 0);
  if (aged.length) {
    const oldest = aged.reduce((a, b) => (Number(a.ageDays ?? 0) >= Number(b.ageDays ?? 0) ? a : b));
    lines.push(
      `⏰ Oldest untouched finding: ${oldest.ageDays} day(s) (${oldest.dimension ?? "?"} ${oldest.convId ?? ""}). ${
        orders.filter(o => Number(o.ageDays ?? 0) >= 2).length
      } item(s) are 48h+ OVERDUE.`
    );
  }
  lines.push("");

  // DECISION QUEUE — the human half of the loop, as numbered one-liners instead of a passive
  // pile: Tier-2 notify items sorted oldest-first so a reply like "1 yes, 2 no, 3 skip" clears
  // them in one message (the pattern that cleared 7 items in 30 seconds on 7/9). The morning
  // routine adds recommendations; this deterministic queue guarantees numbering + ages.
  const queue = tier2
    .filter(o => o.notify !== false)
    .slice()
    .sort((a, b) => Number(b.ageDays ?? 0) - Number(a.ageDays ?? 0))
    .slice(0, 15);
  if (queue.length) {
    lines.push(`DECISION QUEUE — reply by number (e.g. "1 yes, 2 no, 3 skip"):`);
    queue.forEach((w, i) => {
      const age = Number(w.ageDays ?? 0);
      const ageTag = age >= 2 ? ` ⏰ OVERDUE ${age}d` : age >= 1 ? ` (${age}d)` : " (new)";
      const firstLine = String(w.detail ?? "").trim().split("\n")[0].slice(0, 140);
      lines.push(`  ${i + 1}.${ageTag} [${w.dimension ?? "?"}] ${w.convId ?? "?"} — ${firstLine}`);
    });
    lines.push("");
  }

  let shown = 0;
  const section = (title: string, items: LoopWorkOrder[]) => {
    if (!items.length) return;
    lines.push(title);
    for (const w of items) {
      if (shown >= MAX_ITEMS) break;
      lines.push(fmtItem(w));
      shown += 1;
    }
    lines.push("");
  };
  section("NEEDS YOUR REVIEW — Tier 2 (new/unconfirmed behavior; nothing auto-merges):", tier2);
  section("Safe auto-patch candidates — Tier 1 (deterministic / fixture; graduates to auto-merge after a clean track record):", tier1);
  section("Other:", other);

  if (shown < count) lines.push(`… and ${count - shown} more (see reports/anomaly_loop/next.json).`);
  lines.push("");
  lines.push("Reply or open the console to confirm/dismiss. Confirmations sharpen the critic + graduate the safe categories toward auto-merge.");

  return {
    hasContent: true,
    subject: `LeadRider agent-watch${dealer} — ${count} finding(s), ${notifyCount} need review`,
    text: lines.join("\n")
  };
}
