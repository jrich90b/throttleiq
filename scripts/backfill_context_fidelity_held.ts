/**
 * One-time backfill: tag the EXISTING backlog of out-of-context drafts so the held card tag + banner
 * (PR #74/#75) surface retroactively. The runtime sets conv.draftHeld at draft-PUBLISH time, so
 * conversations whose out-of-context draft was published before the flag won't light up on their own —
 * this re-scores their latest pending draft and sets the held marker + a deduped task for the ones that
 * would hold (out_of_context + major + conf>=0.8 + turn-judged frame).
 *
 * Safety: reuses the eval'd backfillRunner harness (dry-run plans + mutates NOTHING; --write applies; cap
 * bounds it). DRY-RUN by default. Targets only OPEN convs with a real customer turn (skips ADF/widget/
 * phone-log inbounds) whose latest AI draft is unsent + not already held.
 *
 *   CONVERSATIONS_DB_PATH=.../conversations.json LLM_ENABLED=1 npx tsx scripts/backfill_context_fidelity_held.ts          # dry-run
 *   CONVERSATIONS_DB_PATH=.../conversations.json LLM_ENABLED=1 npx tsx scripts/backfill_context_fidelity_held.ts --write  # apply
 */
import fs from "node:fs";
import { scoreContextFidelityWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideContextFidelityHold } from "../services/api/src/domain/contextFidelityHold.ts";
import { CONTEXT_FIDELITY_HELD_TODO_MARKER } from "../services/api/src/domain/conversationStore.ts";
import { planBackfill, applyBackfill, renderBackfillReport } from "../services/api/src/domain/backfillRunner.ts";

const PATH = process.env.CONVERSATIONS_DB_PATH || "data/conversations.json";
const WRITE = process.argv.includes("--write") || process.env.WRITE === "1";
const CHANGE_CAP = Number(process.env.BACKFILL_CAP || 200);
const SCORE_CAP = Number(process.env.SCORE_CAP || 250);
const SYSTEM_INBOUND = /WEB LEAD \(ADF\)|WEB TEXT WIDGET|PHONE LOG \(ADF\)|thank you for calling/i;
const nowIso = () => new Date().toISOString();

const root: any = JSON.parse(fs.readFileSync(PATH, "utf8"));
const conversations: any[] = Array.isArray(root) ? root : root.conversations ?? [];
const todos: any[] | null = Array.isArray(root) ? null : (root.todos ?? (root.todos = []));

// latest pending AI draft = a draft_ai outbound after the last human/twilio/sendgrid send (mirrors the
// console's findPendingDraft) — i.e. an unsent suggestion still awaiting the rep.
function latestPending(conv: any): { draft: string; msgs: any[]; idx: number } | null {
  const msgs = (conv.messages ?? []).filter((m: any) => m && (m.direction === "in" || m.direction === "out"));
  let lastDraft = -1, lastSent = -1;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.direction !== "out") continue;
    if (m.provider === "draft_ai" && m.draftStatus !== "stale") lastDraft = i;
    if (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid") lastSent = i;
  }
  return lastDraft > lastSent ? { draft: String(msgs[lastDraft].body ?? ""), msgs, idx: lastDraft } : null;
}
function inboundBefore(msgs: any[], idx: number): string {
  for (let j = idx - 1; j >= 0; j--) {
    if (msgs[j].direction === "in" && String(msgs[j].body ?? "").trim()) return String(msgs[j].body).trim();
  }
  return "";
}

type Cand = { conv: any; draft: string; inbound: string };
const candidates: Cand[] = [];
for (const conv of conversations) {
  if (String(conv.status ?? "") === "closed") continue;
  if (conv.draftHeld) continue; // already flagged
  const lp = latestPending(conv);
  if (!lp || !lp.draft.trim()) continue;
  const inbound = inboundBefore(lp.msgs, lp.idx);
  if (!inbound || SYSTEM_INBOUND.test(inbound)) continue; // real customer turn only
  candidates.push({ conv, draft: lp.draft, inbound });
}

// Async pre-score (capped), then a SYNC `correct` reads the result so planBackfill stays pure.
const held = new Map<string, { frame: string | null; steering: string | null; inboundPreview: string; draftPreview: string }>();
let scored = 0;
for (const c of candidates) {
  if (scored >= SCORE_CAP) break;
  scored++;
  const anchor = {
    modelOfRecord: c.conv?.lead?.vehicle?.model ?? c.conv?.lead?.vehicle?.description ?? null,
    leadType: [c.conv?.classification?.bucket, c.conv?.classification?.cta].filter(Boolean).join("/") || null,
    appointmentBooked: !!c.conv?.appointment?.bookedEventId,
    dialogState: c.conv?.dialogState?.name ?? null
  };
  const history = (c.conv.messages ?? [])
    .filter((m: any) => m.direction === "in" || m.direction === "out")
    .slice(-8)
    .map((m: any) => ({ direction: m.direction, body: String(m.body ?? "") }));
  let sc: any = null;
  try {
    sc = await scoreContextFidelityWithLLM({ draft: c.draft, inbound: c.inbound, history, anchor, channel: c.conv?.channel === "email" ? "email" : "sms" });
  } catch {
    /* best-effort: an unscored conv just isn't tagged */
  }
  if (decideContextFidelityHold({ enabled: true, score: sc }).action === "hold") {
    held.set(c.conv.id, {
      frame: sc?.frame ?? null,
      steering: String(sc?.steering ?? "").slice(0, 240) || null,
      inboundPreview: c.inbound.slice(0, 240),
      draftPreview: c.draft.slice(0, 240)
    });
  }
}

const correct = (conv: any) => {
  const s = held.get(conv.id);
  if (!s) return null;
  return {
    summary: `[${conv.leadKey}] ${s.frame}: ${s.inboundPreview.slice(0, 60)}`,
    mutate: () => {
      conv.draftHeld = {
        at: nowIso(),
        reason: "context_fidelity_out_of_context",
        heldKind: "context_fidelity",
        frame: s.frame,
        steering: s.steering,
        channel: conv?.channel === "email" ? "email" : "sms",
        inboundPreview: s.inboundPreview,
        draftPreview: s.draftPreview
      };
      if (todos && !todos.some(t => t.convId === conv.id && t.status === "open" && String(t.summary ?? "").includes(CONTEXT_FIDELITY_HELD_TODO_MARKER))) {
        todos.push({
          id: `todo_cfheld_${String(conv.id).replace(/\W/g, "")}_${Date.now()}`,
          convId: conv.id,
          leadKey: conv.leadKey,
          reason: "other",
          summary: `Needs your reply — the ${CONTEXT_FIDELITY_HELD_TODO_MARKER} (${s.frame ?? "context"}). Reply to the customer.`,
          sourceMessageId: "",
          createdAt: nowIso(),
          status: "open",
          taskClass: "followup"
        });
      }
    }
  };
};

const plan = planBackfill({ conversations: candidates.map(c => c.conv), correct, cap: CHANGE_CAP });
console.log(`Scanned ${conversations.length} convs | candidates (open, pending AI draft, real customer turn, not already held): ${candidates.length} | scored ${scored} | WOULD-TAG (held): ${held.size}`);
console.log(renderBackfillReport(plan, { title: "context-fidelity held backfill", applied: false }));

if (WRITE) {
  const applied = applyBackfill(plan);
  fs.writeFileSync(PATH, JSON.stringify(root, null, 2));
  console.log(`\nAPPLIED ${applied} held markers (+ deduped tasks) -> ${PATH}. Restart the API to re-hydrate.`);
} else {
  console.log("\nDRY-RUN — no changes written. Re-run with --write to apply.");
}
