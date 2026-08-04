/**
 * gold-example harvester — "cache correct conversations" (approve-first; nothing auto-applied).
 *
 * Mines CONFIRMED-CORRECT inbound replies from the store and proposes them as reusable examples
 * (manual_reply_example candidates) + regression replay-fixtures. The discipline (per the
 * caching discussion): promote confirmed-good turns into FEW-SHOTS + FIXTURES that GUIDE/lock,
 * never into a runtime inbound->reply cache. This writes a PROPOSAL only — a human reviews and
 * promotes; it never edits data/manual_reply_examples.json or ci:eval itself.
 *
 * Gold signal (grounded in the store — there is no clean "AI draft approved verbatim" flag, so we
 * use the two trustworthy human-blessed signals, tiered):
 *   tier "positive_feedback" — a staff member explicitly marked the reply good (feedback positive).
 *   tier "human_verbatim"    — a named staff member SENT the reply (providerMessageId) with no edit
 *                              (no originalDraftBody = not corrected). Excludes calls/voice/cadence.
 * EDITED sends (originalDraftBody set) are deliberately NOT gold here — those are the existing
 * edit-feedback signal (the correction, not the confirmation).
 *
 * Usage:
 *   npx tsx scripts/gold_example_harvester.ts --self-test
 *   CONVERSATIONS_DB_PATH=... npx tsx scripts/gold_example_harvester.ts [--since-hours=720] [--limit=200] [--out-dir=DIR]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type Msg = {
  direction?: string | null;
  body?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  actorUserName?: string | null;
  originalDraftBody?: string | null;
  at?: string | null;
  callMethod?: string | null;
  feedback?: any;
};
/**
 * DEFAULT HARVEST WINDOW — 90 days (Joe, 2026-08-04). This harvest REBUILDS the candidates file, so
 * the window is not a lookback, it IS the corpus size. The hourly loop ran it at 168h and the golden
 * corpus was a rolling WEEK: 89 examples, 20 in the eval hold-out. At n=20 a 9/20 score puts the
 * agent's true rate anywhere from 26% to 66% — too wide to set a floor on, so the one number meant
 * to answer "is the agent getting better" could not answer it. 90 days yields 701 candidates / 117
 * in the hold-out (measured 8/4), tightening that to roughly +/-9. Deterministic and LLM-free, so a
 * wider scan costs seconds and no money.
 */
export const DEFAULT_HARVEST_SINCE_HOURS = 2160;
/** Cap high enough that the WINDOW is what bounds the corpus, never an arbitrary row limit. */
export const DEFAULT_HARVEST_LIMIT = 5000;

type GoldTier = "positive_feedback" | "human_verbatim";
type Candidate = { tier: GoldTier; convId: string | null; at: string | null; by: string | null; inbound: string; reply: string };

const TEXT_PROVIDERS = new Set(["twilio", "sendgrid", "human"]);
// bodies that are NOT customer-facing text replies (call/voice/system records)
const NON_REPLY_RE = /^(call initiated|left a voicemail|voicemail left|call ended|missed call|no answer|outbound call|inbound call)\b/i;

function norm(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isPositiveFeedback(fb: any): boolean {
  if (!fb || typeof fb !== "object") return false;
  const kind = String(fb.kind ?? fb.type ?? "").toLowerCase();
  const rating = fb.rating ?? fb.score;
  return kind.startsWith("pos") || kind === "good" || kind === "approve" || rating === "up" || rating === "positive" || rating === 1 || rating === 5;
}

/** Is this outbound a confirmed-good TEXT reply? Returns its gold tier, or null. */
export function goldTier(m: Msg): GoldTier | null {
  if (String(m?.direction ?? "").toLowerCase() !== "out") return null;
  const body = String(m?.body ?? "").trim();
  if (!body || NON_REPLY_RE.test(body) || m?.callMethod) return null;
  if (!TEXT_PROVIDERS.has(String(m?.provider ?? ""))) return null;
  if (isPositiveFeedback(m?.feedback)) return "positive_feedback";
  // human-sent, actually delivered, NOT an edited-from-draft correction
  if (m?.actorUserName && m?.providerMessageId && !m?.originalDraftBody) return "human_verbatim";
  return null;
}

function priorInbound(messages: Msg[], outIdx: number): string | null {
  for (let j = outIdx - 1; j >= 0; j--) {
    const m = messages[j];
    if (String(m?.direction ?? "").toLowerCase() === "in" && m?.body) return String(m.body);
  }
  return null;
}

/** All reply-like strings already captured as examples, for dedup. */
function existingReplyKeys(manualExamplesPath: string): Set<string> {
  const keys = new Set<string>();
  try {
    const raw = JSON.parse(fs.readFileSync(manualExamplesPath, "utf8"));
    const walk = (v: any) => {
      if (typeof v === "string") { if (v.trim().length > 12) keys.add(norm(v)); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(raw);
  } catch { /* none */ }
  return keys;
}

function harvest(conversations: any[], opts: { sinceHours: number; limit: number; manualExamplesPath: string }): Candidate[] {
  const cutoffMs = Date.now() - opts.sinceHours * 3600 * 1000;
  const seenReplies = existingReplyKeys(opts.manualExamplesPath);
  const out: Candidate[] = [];
  for (const conv of conversations) {
    const messages: Msg[] = Array.isArray(conv?.messages) ? conv.messages : [];
    for (let i = 0; i < messages.length; i++) {
      const tier = goldTier(messages[i]);
      if (!tier) continue;
      const at = messages[i]?.at ?? null;
      const atMs = at ? Date.parse(at) : NaN;
      if (Number.isFinite(atMs) && atMs < cutoffMs) continue;
      const inbound = priorInbound(messages, i);
      if (!inbound) continue; // need the turn it answered
      const reply = String(messages[i].body).trim();
      const key = norm(reply);
      if (seenReplies.has(key)) continue; // dedup vs existing examples + earlier candidates
      seenReplies.add(key);
      out.push({ tier, convId: conv?.id ?? conv?.leadKey ?? null, at, by: messages[i]?.actorUserName ?? null, inbound: inbound.slice(0, 400), reply: reply.slice(0, 400) });
    }
  }
  // positive_feedback first (highest confidence), then most recent
  out.sort((a, b) => (a.tier === b.tier ? String(b.at).localeCompare(String(a.at)) : a.tier === "positive_feedback" ? -1 : 1));
  return out.slice(0, opts.limit);
}

// ─────────────────────────────────────────────────────────────────────────────
function selfTest(): void {
  // Positive feedback -> gold.
  assert.equal(goldTier({ direction: "out", provider: "twilio", body: "Yes, the Street Glide is still here!", feedback: { kind: "positive" } }), "positive_feedback");
  // Human-sent, unedited, delivered -> gold.
  assert.equal(goldTier({ direction: "out", provider: "human", body: "Sounds good, see you Saturday!", actorUserName: "Scott", providerMessageId: "SM1" }), "human_verbatim");
  // Edited-from-draft (correction) -> NOT verbatim gold.
  assert.equal(goldTier({ direction: "out", provider: "twilio", body: "edited", actorUserName: "Scott", providerMessageId: "SM2", originalDraftBody: "the ai draft" }), null);
  // Call/voice record -> excluded.
  assert.equal(goldTier({ direction: "out", provider: "twilio", body: "Call initiated to +17165550000.", actorUserName: "Joe", providerMessageId: "X" }), null);
  assert.equal(goldTier({ direction: "out", provider: "voice_call", body: "hello", actorUserName: "Joe", providerMessageId: "X" }), null);
  // Pending AI draft (not sent by a human, no positive feedback) -> not gold.
  assert.equal(goldTier({ direction: "out", provider: "draft_ai", body: "a pending draft" }), null);
  // Inbound -> never gold.
  assert.equal(goldTier({ direction: "in", provider: "twilio", body: "hi" }), null);

  // End-to-end: pairing + dedup against existing examples.
  const convs = [
    { id: "c1", messages: [
      { direction: "in", provider: "twilio", body: "is the sportster still available?", at: "2026-06-21T00:00:00Z" },
      { direction: "out", provider: "human", body: "Yes! The Sportster is here. Want to come ride it?", actorUserName: "Gio", providerMessageId: "SM9", at: "2026-06-21T00:01:00Z" }
    ] },
    { id: "c2", messages: [
      { direction: "in", provider: "twilio", body: "price on the road glide?", at: "2026-06-21T00:00:00Z" },
      { direction: "out", provider: "twilio", body: "Already a known example", actorUserName: "X", providerMessageId: "SM10", at: "2026-06-21T00:01:00Z" }
    ] }
  ];
  const tmp = path.join(process.env.TMPDIR || "/tmp", `gold_dedup_${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, examples: ["Already a known example"] }));
  const cands = harvest(convs, { sinceHours: 24 * 365, limit: 50, manualExamplesPath: tmp });
  fs.unlinkSync(tmp);
  assert.equal(cands.length, 1, "the already-known example must be deduped out");
  assert.equal(cands[0].convId, "c1");
  assert.equal(cands[0].inbound, "is the sportster still available?");
  assert.match(cands[0].reply, /^Yes! The Sportster/);

  // The window is the corpus size, and the corpus size is what makes the gold score readable.
  // A default narrow enough to starve the eval hold-out would silently make the number meaningless
  // long before anything went red, so pin the floor on the DEFAULT itself.
  assert.ok(
    DEFAULT_HARVEST_SINCE_HOURS >= 2160,
    `default harvest window ${DEFAULT_HARVEST_SINCE_HOURS}h is under 90 days — the eval hold-out goes thin and the gold score stops meaning anything`
  );
  assert.ok(DEFAULT_HARVEST_LIMIT >= 2000, "the row cap must not become the thing that bounds the corpus");

  // …and prove the window actually GATES: the same conversation is harvested inside it, dropped
  // outside it. A default that was never read would pass the assertion above and change nothing.
  const old = [{ id: "old", messages: [
    { direction: "in", provider: "twilio", body: "still available?", at: "2020-01-01T00:00:00Z" },
    { direction: "out", provider: "twilio", body: "Yes it is, come take a look", actorUserName: "X", providerMessageId: "SM99", at: "2020-01-01T00:01:00Z" }
  ] }];
  const noExamples = path.join(process.env.TMPDIR || "/tmp", `gold_window_${process.pid}.json`);
  fs.writeFileSync(noExamples, JSON.stringify({ version: 1, examples: [] }));
  assert.equal(harvest(old, { sinceHours: 24 * 365 * 50, limit: 50, manualExamplesPath: noExamples }).length, 1, "inside the window it is harvested");
  assert.equal(harvest(old, { sinceHours: 1, limit: 50, manualExamplesPath: noExamples }).length, 0, "outside the window it is dropped — the window really is the corpus size");
  fs.unlinkSync(noExamples);

  console.log("gold_example_harvester self-test passed");
}

// ─────────────────────────────────────────────────────────────────────────────
function runBatch(): void {
  const arg = (k: string, d: string) => (process.argv.find(a => a.startsWith(`${k}=`))?.split("=")[1] ?? d);
  const sinceHours = Number(arg("--since-hours", String(DEFAULT_HARVEST_SINCE_HOURS)));
  const limit = Number(arg("--limit", String(DEFAULT_HARVEST_LIMIT)));
  const storePath = process.env.CONVERSATIONS_DB_PATH || "services/api/data/conversations.json";
  const dataDir = process.env.DATA_DIR || "data";
  const manualExamplesPath = process.env.MANUAL_REPLY_EXAMPLES_PATH || path.join(dataDir, "manual_reply_examples.json");
  const outDir = arg("--out-dir", process.env.REPORT_ROOT ? path.join(process.env.REPORT_ROOT, "gold_examples") : "reports/gold_examples");

  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const conversations: any[] = Array.isArray(raw) ? raw : raw?.conversations ?? [];
  const candidates = harvest(conversations, { sinceHours, limit, manualExamplesPath });

  fs.mkdirSync(outDir, { recursive: true });
  const byTier = candidates.reduce<Record<string, number>>((a, c) => ((a[c.tier] = (a[c.tier] ?? 0) + 1), a), {});
  const summary = { generatedAt: new Date().toISOString(), sinceHours, scored: conversations.length, candidates: candidates.length, byTier };
  fs.writeFileSync(path.join(outDir, "gold_examples_summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "gold_examples_candidates.json"), JSON.stringify(candidates, null, 2));
  const md = [
    `# Gold examples — confirmed-correct replies to promote (APPROVE-FIRST; nothing auto-applied)`,
    ``,
    `Generated ${summary.generatedAt} — ${candidates.length} candidate(s) (window ${sinceHours}h). By tier: ${JSON.stringify(byTier)}.`,
    `Review, then promote the good ones into data/manual_reply_examples.json (few-shots) and/or a ci:eval replay fixture.`,
    ``,
    ...candidates.slice(0, 60).map(c => `- [${c.tier}${c.by ? ` · ${c.by}` : ""}] ${c.convId}\n  IN:  ${c.inbound}\n  OUT: ${c.reply}`)
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "gold_examples_report.md"), md);
  console.log(`gold_example_harvester: ${candidates.length} candidate(s) ${JSON.stringify(byTier)} -> ${outDir}`);
}

if (process.argv.includes("--self-test")) selfTest();
else runBatch();
