/**
 * Voice-aware cadence facts — durable call-summary facts feed follow-up copy.
 *
 * Production fixture: David Gaeddert +17165872648 — four calls captured "wants
 * pre-owned ~$15k" and a phone quote of $14,995 / $16,534 OTD for the 2017
 * Breakout, yet the queued cadence said only "Still happy to help about the
 * Breakout." Facts persist on conv.voiceFacts (voiceContext expires in 48h)
 * and render deterministically — numbers come from typed fields, never prose.
 */
import type { Conversation } from "./conversationStore.js";
import type { VoiceDurableFactsParse } from "./llmDraft.js";

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
  conv: Pick<Conversation, "voiceFacts">,
  now: Date = new Date()
): string | null {
  const facts = conv?.voiceFacts;
  if (!facts) return null;
  const updatedMs = Date.parse(String(facts.updatedAt ?? ""));
  if (!Number.isFinite(updatedMs)) return null;
  if (now.getTime() - updatedMs > FACT_FRESHNESS_DAYS * 24 * 60 * 60 * 1000) return null;

  const unit = String(facts.quotedUnit ?? "").trim();
  const quoted = Number(facts.quotedPrice ?? 0);
  const otd = Number(facts.otdPrice ?? 0);
  if (unit && quoted > 0) {
    const unitLabel = /^the\b/i.test(unit) ? unit.replace(/^the\s+/i, "") : unit;
    const otdPart = otd > 0 ? `, about ${formatDollars(otd)} out the door` : "";
    return `That ${unitLabel} we went over on the phone is still here at ${formatDollars(quoted)}${otdPart}.`;
  }
  const budget = Number(facts.budgetMax ?? 0);
  if (budget > 0) {
    const preowned = facts.wantsPreowned ? "pre-owned options" : "options";
    return `Still keeping an eye out for ${preowned} around ${formatDollars(budget)} for you.`;
  }
  if (facts.preferences?.length) {
    return `Still watching for something with ${facts.preferences.slice(0, 2).join(" and ")} for you.`;
  }
  return null;
}
