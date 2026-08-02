/**
 * Shared corpus builder for the draft-judge backtests.
 *
 * Extracted from `draft_judge_backtest.ts` (2026-08-02) so the model-comparison backtest can use
 * the IDENTICAL candidate set — two scripts hand-building "approved draft" differently would make
 * their numbers incomparable, which is the hand-copy drift problem again (PR #432).
 *
 * The ground-truth proxy, and its measured limit: a draft whose text closely matches the next
 * human/twilio/sendgrid outbound was APPROVED by staff. The 2026-08-02 run showed staff approve
 * real defects (three different bikes pushed at a customer who said "Thanks Joe"; "Year ?"
 * answered with a price), so treat a judge-vs-staff disagreement as a DISAGREEMENT to read, not
 * automatically a judge false positive.
 */
import fs from "node:fs";

export type BacktestMsg = { direction: "in" | "out"; body?: string; provider?: string; at?: string };
export type BacktestConv = { id?: string; leadKey?: string; lead?: any; messages?: BacktestMsg[] };

export type BacktestCandidate = {
  convId: string;
  leadKey?: string;
  lead?: any;
  inbound: string;
  draft: string;
  channel: "sms" | "email";
  /**
   * Which HANDLER wrote the draft — the coverage question. "email_adf": the inbound it replies to
   * is an ADF/web-lead payload, so the draft came from the sendgrid lane, which today calls NO
   * judge. "sms": the Twilio lane, which does. Origin of the THREAD is not enough — a thread can
   * start on ADF and continue on SMS — so this is per-draft, off the replied-to inbound.
   */
  lane: "email_adf" | "sms";
  history: { direction: "in" | "out"; body: string }[];
};

export function loadBacktestConversations(p: string): BacktestConv[] {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  if (raw && typeof raw === "object") return Object.values(raw) as BacktestConv[];
  return [];
}

const norm = (s: string) =>
  String(s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();

export function backtestDraftsSimilar(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length > 12 && (na.includes(nb) || nb.includes(na))) return true;
  const sa = new Set(na.split(" "));
  const sb = new Set(nb.split(" "));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const jac = inter / (sa.size + sb.size - inter);
  // 0.45 captures lightly-edited sends (still a good-draft proxy); a full rewrite scores lower and
  // is correctly excluded (it means the draft was NOT good).
  return jac >= 0.45;
}

const isCustomerOutboundSent = (m: BacktestMsg) =>
  m.direction === "out" && (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid");

/** ADF/web-lead payload test — transport-shape detection on our OWN intake format, not customer comprehension. */
const isAdfInbound = (body: string) => /WEB LEAD \(ADF\)|Traffic Log Pro|^Source:/m.test(body);

export function buildApprovedDraftCandidates(conversations: BacktestConv[]): BacktestCandidate[] {
  const candidates: BacktestCandidate[] = [];
  for (const conv of conversations) {
    const msgs = (conv.messages ?? []).filter(m => m && (m.direction === "in" || m.direction === "out"));
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.provider !== "draft_ai" || m.direction !== "out") continue;
      const draft = String(m.body ?? "").trim();
      if (!draft) continue;
      // The customer turn this draft replied to (most recent inbound before it).
      let inbound = "";
      for (let j = i - 1; j >= 0; j--) {
        if (msgs[j].direction === "in" && String(msgs[j].body ?? "").trim()) {
          inbound = String(msgs[j].body ?? "").trim();
          break;
        }
      }
      if (!inbound) continue; // cadence / proactive draft — not the draft-quality judge's domain
      // Was it SENT? next customer-facing outbound that matches the draft.
      let approved = false;
      for (let k = i + 1; k < msgs.length; k++) {
        if (msgs[k].direction === "in") break; // a new customer turn — stop looking
        if (isCustomerOutboundSent(msgs[k]) && backtestDraftsSimilar(draft, String(msgs[k].body ?? ""))) {
          approved = true;
          break;
        }
      }
      if (!approved) continue;
      const channel: "sms" | "email" =
        m.provider === "sendgrid" || /@/.test(String(conv.leadKey ?? "")) ? "email" : "sms";
      const history = msgs
        .slice(Math.max(0, i - 8), i)
        .map(h => ({ direction: h.direction, body: String(h.body ?? "") }))
        .filter(h => h.body.trim());
      candidates.push({
        convId: String(conv.id ?? ""),
        leadKey: conv.leadKey,
        lead: conv.lead,
        inbound,
        draft,
        channel,
        lane: isAdfInbound(inbound) ? "email_adf" : "sms",
        history
      });
    }
  }
  return candidates;
}

/** Deterministic spread sample (stride) so a cap covers the whole corpus, not just the first convs. */
export function strideSample<T>(items: T[], cap: number): T[] {
  const stride = Math.max(1, Math.floor(items.length / Math.max(1, cap)));
  return items.filter((_, idx) => idx % stride === 0).slice(0, cap);
}
