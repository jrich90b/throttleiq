/**
 * Voice-aware cadence facts — durable call-summary facts feed follow-up copy.
 *
 * Production fixture: David Gaeddert +17165872648 — four calls captured "wants
 * pre-owned ~$15k" and a phone quote of $14,995 / $16,534 OTD for the 2017
 * Breakout, yet the queued cadence said only "Still happy to help about the
 * Breakout." Facts persist on conv.voiceFacts (voiceContext expires in 48h)
 * and render deterministically — numbers come from typed fields, never prose.
 */
import {
  applyInventoryNotifyPromiseOutcome,
  saveConversation,
  type Conversation
} from "./conversationStore.js";
import { resolveInventoryNotifyPromisePlan } from "./inventoryNotifyPromise.js";
import {
  parseVoiceDurableFactsWithLLM,
  type UnifiedSemanticSlotParse,
  type VoiceDurableFactsParse
} from "./llmDraft.js";
import { isSpecificModel } from "./modelDeflection.js";

const FACT_CONFIDENCE_MIN = Number(process.env.VOICE_DURABLE_FACTS_CONFIDENCE_MIN ?? 0.7);
const FACT_FRESHNESS_DAYS = Number(process.env.VOICE_FACTS_CADENCE_MAX_AGE_DAYS ?? 45);

export function applyVoiceDurableFacts(
  conv: Conversation,
  parsed: VoiceDurableFactsParse | null,
  opts: { nowIso?: string; sourceMessageId?: string | null } = {}
): boolean {
  if (!parsed) return false;
  if (!(parsed.confidence >= FACT_CONFIDENCE_MIN)) return false;
  const hasAnything =
    parsed.quotedUnit ||
    parsed.quotedPrice > 0 ||
    parsed.otdPrice > 0 ||
    parsed.budgetMax > 0 ||
    parsed.wantsPreowned ||
    parsed.preferences.length ||
    parsed.blockers.length;
  if (!hasAnything) return false;
  const prev = conv.voiceFacts;
  conv.voiceFacts = {
    // A later call without a quote must not erase an earlier quote.
    quotedUnit: parsed.quotedUnit || prev?.quotedUnit || null,
    quotedPrice: parsed.quotedPrice > 0 ? parsed.quotedPrice : prev?.quotedPrice ?? null,
    otdPrice: parsed.otdPrice > 0 ? parsed.otdPrice : prev?.otdPrice ?? null,
    budgetMax: parsed.budgetMax > 0 ? parsed.budgetMax : prev?.budgetMax ?? null,
    wantsPreowned: parsed.wantsPreowned || prev?.wantsPreowned || null,
    preferences: dedupeShort([...(prev?.preferences ?? []), ...parsed.preferences]),
    blockers: dedupeShort([...(prev?.blockers ?? []), ...parsed.blockers]),
    updatedAt: opts.nowIso || new Date().toISOString(),
    sourceMessageId: opts.sourceMessageId ?? null
  };
  return true;
}

/**
 * Fill-only-when-empty motorcycle-of-interest write-back (Joe, 2026-07-15): when a call
 * surfaces the specific unit the customer is SHOPPING FOR (discussed/quoted unit) and the
 * lead has NO specific motorcycle of interest yet (empty, or a placeholder like
 * "Harley-Davidson Other" / "Full Line"), fill the field so staff see it. CONSERVATIVE by
 * design: never overwrites a real model (the over-attachment failure mode is worse than a
 * det-miss — see the model-relevance-guard doctrine), and the parser's discussed_unit rule
 * explicitly excludes the bike they own/trade/sell. Returns true when it wrote.
 */
export function fillLeadVehicleFromVoiceFacts(
  conv: Conversation,
  parsed: VoiceDurableFactsParse | null
): boolean {
  if (!parsed) return false;
  if (!(parsed.confidence >= FACT_CONFIDENCE_MIN)) return false;
  const unit = String(parsed.discussedUnit || parsed.quotedUnit || "").trim();
  if (!unit) return false;
  const existing = String(
    conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? ""
  ).trim();
  if (existing && isSpecificModel(existing)) return false; // fill-only: a real model stays
  const yearMatch = unit.match(/\b(19|20)\d{2}\b/);
  const model = unit.replace(/\b(19|20)\d{2}\b/, "").replace(/\s{2,}/g, " ").trim() || unit;
  conv.lead = conv.lead ?? {};
  conv.lead.vehicle = conv.lead.vehicle ?? {};
  if (yearMatch && !String(conv.lead.vehicle.year ?? "").trim()) {
    conv.lead.vehicle.year = yearMatch[0];
  }
  conv.lead.vehicle.model = model;
  conv.lead.vehicle.description = model;
  return true;
}

/**
 * Lazy catch-up: conversations whose calls predate the facts parser (or whose
 * newest summary is newer than the stored facts) get extracted at cadence
 * build time, inside the live process — never by editing the store directly.
 */
export async function ensureVoiceFactsFresh(conv: Conversation): Promise<void> {
  try {
    const summaries = (conv.messages ?? []).filter(
      m => m?.direction === "out" && m?.provider === "voice_summary" && String(m?.body ?? "").trim()
    );
    if (!summaries.length) return;
    const latest = summaries[summaries.length - 1];
    const latestAtMs = Date.parse(String(latest?.at ?? ""));
    const factsAtMs = Date.parse(String(conv.voiceFacts?.updatedAt ?? ""));
    if (Number.isFinite(factsAtMs) && (!Number.isFinite(latestAtMs) || factsAtMs >= latestAtMs)) return;
    // Parse up to the last 3 summaries oldest-first so merge semantics hold.
    const toParse = summaries.slice(-3);
    let applied = false;
    for (const summary of toParse) {
      const parsed = await parseVoiceDurableFactsWithLLM({
        summary: String(summary.body ?? ""),
        lead: conv.lead ?? undefined
      });
      if (
        applyVoiceDurableFacts(conv, parsed, {
          nowIso: String(latest?.at ?? new Date().toISOString()),
          sourceMessageId: latest?.providerMessageId ?? null
        })
      ) {
        applied = true;
      }
    }
    if (!applied && !conv.voiceFacts) {
      // Remember the attempt so we don't re-parse the same summaries nightly.
      conv.voiceFacts = { updatedAt: String(latest?.at ?? new Date().toISOString()), sourceMessageId: null };
      saveConversation(conv);
      return;
    }
    if (applied) saveConversation(conv);
  } catch {
    // Never let fact catch-up break a cadence build.
  }
}

function dedupeShort(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out.slice(0, 6);
}

function formatDollars(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

/**
 * Deterministic cadence line referencing what was discussed on the phone.
 * Returns null when there is nothing concrete or the facts are stale.
 */
export function buildVoiceFactsCadenceLine(
  conv: Pick<Conversation, "voiceFacts" | "closedReason" | "sale" | "followUpCadence" | "lead">,
  now: Date = new Date()
): string | null {
  return resolveVoiceFactsCadenceLine(conv, now)?.line ?? null;
}

/**
 * The line PLUS whether it promised the customer future outreach.
 *
 * Two of the three branches below are promises ("still keeping an eye out…", "still watching
 * for…") and one is a status report ("that Breakout is still here at $14,995"). Promise-ness is
 * decided HERE, where the sentence is authored, so nothing downstream has to sniff our own copy
 * with a keyword test to find out what we said.
 */
export function resolveVoiceFactsCadenceLine(
  conv: Pick<Conversation, "voiceFacts" | "closedReason" | "sale" | "followUpCadence" | "lead">,
  now: Date = new Date()
): { line: string; notifyPromise: boolean } | null {
  const facts = conv?.voiceFacts;
  if (!facts) return null;
  // Post-sale follow-ups must never resurrect pre-purchase quotes/budgets
  // (audit 2026-06-11: 4 of 6 pending backfills were post-sale customers).
  if (
    conv?.closedReason === "sold" ||
    !!conv?.sale?.soldAt ||
    String(conv?.followUpCadence?.kind ?? "") === "post_sale"
  ) {
    return null;
  }
  const updatedMs = Date.parse(String(facts.updatedAt ?? ""));
  if (!Number.isFinite(updatedMs)) return null;
  if (now.getTime() - updatedMs > FACT_FRESHNESS_DAYS * 24 * 60 * 60 * 1000) return null;

  const unit = String(facts.quotedUnit ?? "").trim();
  const quoted = Number(facts.quotedPrice ?? 0);
  const otd = Number(facts.otdPrice ?? 0);
  if (unit && quoted > 0) {
    const unitLabel = /^the\b/i.test(unit) ? unit.replace(/^the\s+/i, "") : unit;
    const otdPart = otd > 0 ? `, about ${formatDollars(otd)} out the door` : "";
    return {
      line: `That ${unitLabel} we went over on the phone is still here at ${formatDollars(quoted)}${otdPart}.`,
      notifyPromise: false
    };
  }
  const budget = Number(facts.budgetMax ?? 0);
  if (budget > 0) {
    const preowned = facts.wantsPreowned ? "pre-owned options" : "options";
    return {
      line: `Still keeping an eye out for ${preowned} around ${formatDollars(budget)} for you.`,
      notifyPromise: true
    };
  }
  if (facts.preferences?.length) {
    // Don't say we're "watching for" a model we're already presenting as available — the
    // cadence body offers the lead's in-stock unit, so "still watching for <that model>"
    // reads as a contradiction (Alexander Roehre, Ref 11233: a phone-mined "Street Glide"
    // preference on a Street Glide lead produced "we still have one available ... still
    // watching for something with Street Glide"). Drop preferences that match the offered
    // model; only surface genuinely different ones.
    const offeredModel = normalizeModelTokenForVoiceFacts(
      conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? ""
    );
    const novel = facts.preferences.filter(p => !preferenceMatchesOfferedModel(p, offeredModel));
    if (novel.length) {
      return {
        line: `Still watching for something with ${novel.slice(0, 2).join(" and ")} for you.`,
        notifyPromise: true
      };
    }
    return null;
  }
  return null;
}

/**
 * The ONE "freshen the facts, then append the line if it isn't already there" block. index.ts
 * carried three hand-maintained copies (two in the regenerate draft builder, one in the live
 * cadence sender).
 */
export async function appendVoiceFactsCadenceLine(
  conv: Conversation,
  message: string,
  now: Date,
  wasUsedRecently: (conv: Conversation, line: string) => boolean
): Promise<{ body: string }> {
  await ensureVoiceFactsFresh(conv);
  const line = resolveVoiceFactsCadenceLine(conv, now)?.line;
  if (!line) return { body: message };
  if (message.toLowerCase().includes(line.toLowerCase()) || wasUsedRecently(conv, line)) {
    return { body: message };
  }
  return { body: `${message} ${line}`.trim() };
}

/**
 * "Still keeping an eye out for pre-owned options around $23,000 for you." must mint SOMETHING —
 * the rule PR #709 shipped for the reply and manual-outbound authors
 * (domain/inventoryNotifyPromise.ts). Joe's report 2026-08-16, Robert Cloud +17163135464: that
 * exact sentence was DELIVERED at 15:51Z and the lead has no watch and no task.
 *
 * WHY #709 DID NOT COVER IT, executed 2026-08-17 against the real body: the message went out
 * through the very endpoint that carries #709's arm, and the arm's COST GATE never let it in.
 * `hasManualPromiseHint` matches "keep an eye out" — this sentence says "keepING an eye out", and
 * the sibling cue in `hasManualOutboundWatchCue` has the same uninflected list. Both read false.
 * ("Still WATCHING for …", the other promise this module authors, misses "watch for" the same way.)
 *
 * Widening those two regexes was the tempting one-word fix and it is the wrong one, for two
 * measured reasons. (1) `watching for` is also the watch-MATCH-ALERT phrasing — "the Low Rider ST
 * you were watching for just came in" — 24 of the 26 outbounds a widened gate newly admits over
 * 30d are alerts about a watch that already exists, so we would buy two LLM parses per alert to
 * rediscover it. (2) It leaves the mechanism intact: the sentence is AUTHORED here, from typed
 * fields, and asking a lexical gate plus two parsers to recover from prose a spec we are holding
 * in hand is the round-trip the de-tangle program exists to remove. Any future rephrasing of the
 * copy silently re-breaks it — which is exactly what happened to #709.
 *
 * So the follow-through is minted by the author, off the same typed facts that built the sentence
 * (quotedUnit / the lead's motorcycle of interest, plus wantsPreowned). No parser, no phrase list.
 * The watch-vs-task decision and the placeholder guard stay with the existing referee — this adds
 * no second opinion about either, and `mergeInventoryWatches` + addTodo's open-task merge make a
 * repeat send idempotent.
 *
 * Called at the two places a body reaches the customer: the staff/agent send endpoint (how this
 * one went out — an approved draft) and the cadence auto-sender. Both, deliberately: wiring a rule
 * to one of several authors is the bug being fixed here, not a shortcut worth repeating.
 *
 * The BUDGET is deliberately not pinned onto the watch: a price bound is a money figure, and
 * #709's plan shape carries none. A watch on the right model is honest without it.
 */
export function applyVoiceFactsCadenceNotifyPromise(
  conv: Conversation,
  args: {
    /** The body we are committed to putting in front of the customer. */
    sentBody: string;
    nowIso: string;
    sourceMessageId?: string;
    mergeWatches: Parameters<typeof applyInventoryNotifyPromiseOutcome>[2]["mergeWatches"];
    setDialogState: Parameters<typeof applyInventoryNotifyPromiseOutcome>[2]["setDialogState"];
    /** Instrumentation + persistence live here so neither caller hand-maintains its own copy. */
    recordOutcome?: (outcome: string, detail: Record<string, unknown>) => void;
    persist?: boolean;
  }
): ReturnType<typeof applyInventoryNotifyPromiseOutcome> {
  const parsedNowMs = Date.parse(args.nowIso);
  const nowMs = Number.isFinite(parsedNowMs) ? parsedNowMs : Date.now();
  const resolved = resolveVoiceFactsCadenceLine(conv, new Date(nowMs));
  // Re-derived rather than passed in, so it holds however the body was composed — and a body the
  // value gate replaced, or a draft edited past the promise, correctly mints nothing.
  if (!resolved?.notifyPromise || !args.sentBody.includes(resolved.line)) return { outcome: "none" };
  const spec = resolveVoiceFactsWatchSpec(conv);
  const applied = applyInventoryNotifyPromiseOutcome(
    conv,
    resolveInventoryNotifyPromisePlan({
      // The referee reads only `.watch`; the voice facts ARE the structured spec a slot parse
      // would have had to recover from prose.
      slots: (spec ? { watch: spec } : null) as UnifiedSemanticSlotParse | null,
      nowIso: args.nowIso,
      taskDueIso: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString()
    }),
    {
      sourceMessageId: args.sourceMessageId,
      semanticCondition: spec?.condition ?? null,
      conditionText: args.sentBody.toLowerCase(),
      mergeWatches: args.mergeWatches,
      setDialogState: args.setDialogState
    }
  );
  if (applied.outcome === "none") return applied;
  args.recordOutcome?.(`voice_facts_watch_promise_${applied.outcome}`, {
    model: applied.model ?? null,
    added: applied.added ?? null,
    taskDueAt: applied.taskDueAt ?? null
  });
  if (args.persist) saveConversation(conv);
  return applied;
}

/**
 * WHAT to watch, from typed fields only. The phone-discussed unit wins (the durable-facts parser's
 * quoted/discussed-unit rule already excludes the bike they own or are trading — charter C5.2),
 * and the lead's motorcycle of interest is the fallback because it is the same bike the cadence
 * body just named to the customer. Nothing usable ⇒ null ⇒ the referee falls to a dated task.
 */
function resolveVoiceFactsWatchSpec(
  conv: Pick<Conversation, "voiceFacts" | "lead">
): { model: string; year?: string; condition?: "new" | "used" } | null {
  const raw = String(
    conv?.voiceFacts?.quotedUnit ||
      conv?.lead?.vehicle?.model ||
      conv?.lead?.vehicle?.description ||
      ""
  ).trim();
  if (!raw) return null;
  const year = raw.match(/\b(?:19|20)\d{2}\b/)?.[0];
  const conditionWord = /\b(pre[-\s]?owned|used|new)\b/i.exec(raw)?.[1]?.toLowerCase();
  const model = raw
    .replace(/\b(?:19|20)\d{2}\b/g, "")
    .replace(/\b(pre[-\s]?owned|used|new)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!model) return null;
  const condition: "new" | "used" | undefined = conv?.voiceFacts?.wantsPreowned
    ? "used"
    : conditionWord
      ? conditionWord === "new"
        ? "new"
        : "used"
      : undefined;
  return { model, ...(year ? { year } : {}), ...(condition ? { condition } : {}) };
}

function normalizeModelTokenForVoiceFacts(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bharley[-\s]?davidson\b/g, "")
    .replace(/\bh[-\s]?d\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function preferenceMatchesOfferedModel(preference: string, offeredModel: string): boolean {
  if (!offeredModel) return false;
  const p = normalizeModelTokenForVoiceFacts(preference);
  if (!p) return false;
  // The preference IS the offered model, or a more specific variant of it
  // ("Street Glide", "2026 Street Glide", "Street Glide Special").
  return p === offeredModel || p.includes(offeredModel);
}
