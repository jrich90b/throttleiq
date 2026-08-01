/**
 * Per-dealer VOICE example miner — SHADOW (2026-08-01, Joe: "each dealer should have a tone of
 * the agent that sounds like them").
 *
 * READ-ONLY. Writes a candidate file for review; never touches the live
 * `manual_reply_examples.json` the draft prompt reads. Promotion stays a human step.
 *
 * WHY THIS EXISTS. The per-dealer voice seam already works: `manual_reply_examples.json` lives in
 * each dealer's own data dir and `llmDraft.ts` feeds it to the draft prompt, capped at
 * `maxPerIntent`. It is STARVED, not missing — American Harley's held 6 examples, all in
 * "general", 11 days stale, while every other intent sat empty. The richest source of that
 * dealer's actual voice is excluded by design: `DraftEditJudgeParse` marks voice_tone /
 * length_brevity / formatting edits NOT material, so a staff rewrite for TONE teaches nothing.
 * That is why tone never improves on its own.
 *
 * THE FILTER IS THE WORK — the whole corpus is NOT training data. An outbound with
 * `originalDraftBody` is a staff edit, but two very different things live in that set:
 *   - TWEAKS      (staff kept most of the draft) → a genuine voice signal. What we want.
 *   - REPLACEMENTS(staff wrote something else)   → almost always OUT-OF-BAND KNOWLEDGE the agent
 *     could not have had ("it's an out of state sale so no NYS tax", "the bike shipped today").
 * Training voice on replacements would teach the agent to INVENT FACTS. Of 534 edits in the AH
 * store, 362 are replacements. Only the tweaks are eligible, and the similarity floor is the gate.
 *
 * Usage (on the box, where the data lives):
 *   CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json \
 *   npm run voice_edit_examples:mine -- --since-days 90
 */

import fs from "node:fs";
import path from "node:path";

type AnyObj = Record<string, any>;

const args = process.argv.slice(2);
function argValue(flag: string, fallback: string): string {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] ? String(args[at + 1]) : fallback;
}

const sinceDays = Number(argValue("--since-days", "90"));
// Keep this in step with llmDraft's own cap; a bigger pile is not a better prompt.
const maxPerIntent = Number(argValue("--max-per-intent", "6"));
// Containment floor: ≥0.75 of the words they SENT came from our draft ⇒ a reword, not new content.
const tweakFloor = Number(argValue("--tweak-floor", "0.75"));

const conversationsPath =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(process.env.DATA_DIR || "data", "conversations.json");
const outDir = process.env.VOICE_EDIT_OUT_DIR || path.dirname(conversationsPath);

function normText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

/**
 * CONTAINMENT, not Jaccard: what share of the words the staff SENT came from our draft?
 *
 * Jaccard was the obvious first choice and it is wrong here, because it punishes DELETION as
 * hard as invention. Trimming "the 2026 FLHXSE CVO Street Glide we've got coming in" down to
 * "it" is the single most characteristic voice edit in this corpus, and Jaccard scored it 0.55
 * — below the floor — filing a textbook tweak as a replacement. Containment asks the question we
 * actually care about: did the rep write NEW content (out-of-band knowledge → drop), or rearrange
 * OURS (voice → keep)? A pure trim scores ~1.0; the "no NYS tax" rewrite scores ~0.2.
 */
function similarity(draft: string, sent: string): number {
  const A = new Set(draft.toLowerCase().split(/\s+/).filter(Boolean));
  const B = new Set(sent.toLowerCase().split(/\s+/).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of B) if (A.has(w)) shared += 1;
  return shared / B.size;
}

/**
 * SHIPPED-FIX FILTER — the second gate, and the one that stops the corpus eating its own tail.
 *
 * A tweak can pass the containment floor and still be the wrong thing to teach, because the rep
 * was not adjusting VOICE — they were correcting a FACT or a canonical form that we have since
 * fixed in code. Promote those and the prompt starts arguing with the codebase: the worst case
 * found in the live corpus is an edit that rewrites the canonical intro `it's {agent} over at
 * {dealer}` into the older `it's {agent} at {dealer}` — a form Joe explicitly ruled AGAINST
 * ("I'd rather see over at", 2026-07-29). One such example sitting in the prompt tells the agent
 * to undo a ruling.
 *
 * The unifying principle: **a voice edit rearranges our words; it does not change a fact.** So
 * the generic guard is "did the delta change a number, a year, a price, a percentage, or a model
 * name?" — plus a short, NAMED list for canonical-form reversions, each citing what it protects.
 *
 * Fail direction is DROP. We need ~30 examples and have ~130 clean ones, so an over-eager filter
 * costs nothing and an under-eager one teaches the agent to regress.
 */
const MODEL_TOKEN_RE =
  /\b(?:street\s?glide|road\s?glide|fat\s?bo[by]|breakout|sportster|iron|nightster|heritage|softail|dyna|low\s?rider|pan\s?america|tri\s?glide|freewheeler|ultra|cvo|forty[-\s]?eight|\d{3,4}\s?(?:custom|s)?)\b/gi;

function factSet(text: string): Set<string> {
  const numbers = (text.match(/\$?\d[\d,.]*%?/g) ?? []).map(s => s.replace(/[.,]$/, ""));
  const models = (text.match(MODEL_TOKEN_RE) ?? []).map(s => s.toLowerCase().replace(/\s+/g, " "));
  return new Set([...numbers, ...models]);
}

/**
 * ASYMMETRIC ON PURPOSE. Removing a fact is the archetypal voice edit — "I'll keep an eye on the
 * 2026 FLHXSE CVO Street Glide we've got coming in" → "I'll keep an eye on it". INTRODUCING or
 * SWAPPING one is a correction — "the Iron 883" → "the Sportster". So the test is not "did the
 * facts differ" (that flagged every trim) but "does the SENT text assert a fact our draft did
 * not". Subset ⇒ the rep only cut. Anything new ⇒ they corrected us.
 */
function introducesNewFact(draft: string, sent: string): boolean {
  const before = factSet(draft);
  for (const fact of factSet(sent)) {
    if (!before.has(fact)) return true;
  }
  return false;
}

/** Canonical forms we have already settled. Each entry names the decision it protects. */
const CANONICAL_FORM_REVERSIONS: Array<{ name: string; reverted: (draft: string, sent: string) => boolean }> = [
  {
    // Joe, 2026-07-29: "I'd rather see over at." Reps typing the old form fast on a phone is
    // NOT a preference signal — see the staff-draft-edit-corpus memory.
    name: "intro_over_at",
    reverted: (draft, sent) => /\bover at\b/i.test(draft) && !/\bover at\b/i.test(sent)
  },
  {
    // #340 dropRepeatSelfIntro — the second "I'm Alexandra, nice to meet you" is a shipped fix.
    name: "double_self_intro",
    reverted: (draft, sent) => /\bI'?m \w+, nice to\b/i.test(draft) && !/nice to\b/i.test(sent)
  },
  {
    // #340 staffFollowUpTiming — "shortly" after close is resolved from configured hours now.
    name: "after_hours_shortly",
    reverted: (draft, sent) => /\bshortly\b/i.test(draft) && !/\bshortly\b/i.test(sent)
  }
];

function shippedFixReason(draft: string, sent: string): string | null {
  for (const rule of CANONICAL_FORM_REVERSIONS) {
    if (rule.reverted(draft, sent)) return rule.name;
  }
  if (introducesNewFact(draft, sent)) return "fact_changed";
  return null;
}

/**
 * Mirrors `normalizeManualIntentHint` in llmDraft.ts — the same five buckets the prompt reads,
 * so a promoted candidate lands in a bucket the drafter actually looks up.
 */
function intentFor(inboundText: string, reply: string): string {
  const t = `${inboundText} ${reply}`.toLowerCase();
  if (/\b(payment|price|pricing|cost|finance|financing|apr|monthly|quote|trade[- ]?in value|out the door)\b/.test(t)) {
    return "pricing_payments";
  }
  if (/\b(in stock|availab|do you have|still have|inventory|when.*(arrive|come in))\b/.test(t)) return "availability";
  if (/\b(appointment|schedule|test ride|come in|stop in|what time|book)\b/.test(t)) return "scheduling";
  if (/\b(call me|give me a call|phone call|reach me by phone|call you)\b/.test(t)) return "callback";
  return "general";
}

function loadConversations(): AnyObj[] {
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const list = Array.isArray(raw) ? raw : raw?.conversations ?? raw;
  return Array.isArray(list) ? list : Object.values(list ?? {});
}

type Candidate = {
  intent: string;
  inboundText: string;
  draft: string;
  reply: string;
  similarity: number;
  editor: string | null;
  observedAt: string;
  convId: string;
};

const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
const conversations = loadConversations();

let editsSeen = 0;
let replacementsDropped = 0;
let shippedFixDropped = 0;
const shippedFixByReason: Record<string, number> = {};
let tooOld = 0;
const candidates: Candidate[] = [];

for (const conv of conversations) {
  const messages: AnyObj[] = Array.isArray(conv?.messages) ? conv.messages : [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const draft = normText(msg?.originalDraftBody);
    const reply = normText(msg?.body);
    if (!draft || !reply || draft === reply) continue;
    editsSeen += 1;

    const atMs = Date.parse(String(msg?.at ?? ""));
    if (!Number.isFinite(atMs) || atMs < sinceMs) {
      tooOld += 1;
      continue;
    }

    const score = similarity(draft, reply);
    if (score < tweakFloor) {
      // A replacement: the staff member knew something the agent didn't. Not voice.
      replacementsDropped += 1;
      continue;
    }

    // Gate 2: the rep was correcting a fact or a settled form, not our voice.
    const shippedFix = shippedFixReason(draft, reply);
    if (shippedFix) {
      shippedFixDropped += 1;
      shippedFixByReason[shippedFix] = (shippedFixByReason[shippedFix] ?? 0) + 1;
      continue;
    }

    // The customer turn this reply answers — the prompt needs the pair, not a bare line.
    let inboundText = "";
    for (let j = i - 1; j >= 0; j -= 1) {
      if (messages[j]?.direction === "in") {
        inboundText = normText(messages[j]?.body).slice(0, 600);
        break;
      }
    }

    candidates.push({
      intent: intentFor(inboundText, reply),
      inboundText,
      draft,
      reply,
      similarity: Number(score.toFixed(3)),
      editor: normText(msg?.actorUserName) || null,
      observedAt: String(msg?.at ?? ""),
      convId: String(conv?.id ?? conv?.leadKey ?? "")
    });
  }
}

// Newest first: a dealer's voice drifts, and the recent edits are the current house style.
candidates.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));

const byIntent: Record<string, Candidate[]> = {};
for (const c of candidates) {
  byIntent[c.intent] = byIntent[c.intent] ?? [];
  if (byIntent[c.intent].length < maxPerIntent) byIntent[c.intent].push(c);
}

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "manual_reply_examples.candidates.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      shadow: true,
      note: "CANDIDATES ONLY — review before promoting into manual_reply_examples.json",
      source: { conversationsPath, sinceDays, tweakFloor, maxPerIntent },
      summary: {
        editsSeen,
        outsideWindow: tooOld,
        replacementsDropped,
        shippedFixDropped,
        shippedFixByReason,
        tweaksEligible: candidates.length,
        selected: Object.values(byIntent).reduce((n, v) => n + v.length, 0)
      },
      byIntent
    },
    null,
    2
  ) + "\n"
);

console.log("=== PER-DEALER VOICE EXAMPLE MINER (shadow) ===\n");
console.log(`staff edits seen:        ${editsSeen}`);
console.log(`  outside ${sinceDays}d window:   ${tooOld}`);
console.log(`  replacements dropped:  ${replacementsDropped}  (out-of-band knowledge, NOT voice)`);
console.log(`  shipped-fix dropped:   ${shippedFixDropped}  (a fact or settled form we already fixed in code)`);
for (const [reason, n] of Object.entries(shippedFixByReason)) console.log(`      ${reason}: ${n}`);
console.log(`  tweaks eligible:       ${candidates.length}`);
console.log(`\nselected (max ${maxPerIntent}/intent):`);
for (const [intent, rows] of Object.entries(byIntent)) {
  console.log(`  ${intent.padEnd(18)} ${rows.length}`);
}
console.log(`\ncandidates written: ${outPath}`);
console.log("\n--- what the agent would learn (newest first) ---");
for (const [intent, rows] of Object.entries(byIntent)) {
  for (const r of rows.slice(0, 3)) {
    console.log(`\n[${intent}] ${r.observedAt.slice(0, 10)} edited by ${r.editor ?? "(unrecorded)"} (kept ${Math.round(r.similarity * 100)}%)`);
    console.log(`   agent wrote: ${r.draft.slice(0, 160)}`);
    console.log(`   dealer sent: ${r.reply.slice(0, 160)}`);
  }
}
