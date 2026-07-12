/**
 * Same-conversation staff-correction carry-forward (Joe, 2026-07-11; conv +17163591526).
 *
 * A thumbs-down note steers the immediate re-draft (maybeRedraftOnNegativeFeedback), but
 * the NEXT turn's draft never saw it — so the pipeline regenerated the exact reply staff
 * had just rejected (Nick's backrest thread: the rejected draft came back verbatim on the
 * next customer turn, and "tied to your trade" resurfaced through three consecutive
 * redrafts). This module collects the conversation's RECENT thumbs-down notes so every
 * subsequent draft on the same conversation is composed under those corrections.
 *
 * Generation-context only: these notes feed the draft composer's prompt. They do not
 * touch routing, dialog state, cadence, or any side effect (same state-safety posture as
 * promoted tone rules / manual reply exemplars — see AGENTS.md "State safety lock").
 *
 * Fail direction: no notes -> empty array -> the composer prompt is unchanged. Notes are
 * staff-authored instructions (the operator wrote them to correct the agent), bounded in
 * count, age, and length so a chatty note history can never crowd out the actual turn.
 */

export type FeedbackMessageLike = {
  id?: string;
  direction?: string;
  body?: string;
  feedback?: {
    rating?: string;
    note?: string;
    at?: string;
  } | null;
};

const DEFAULT_MAX_NOTES = 4;
const DEFAULT_MAX_AGE_DAYS = 7;
const NOTE_CHAR_CAP = 200;
const REJECTED_DRAFT_CHAR_CAP = 90;

function boundedLine(note: string, rejectedBody: string): string {
  const cleanNote = note.replace(/\s+/g, " ").trim().slice(0, NOTE_CHAR_CAP);
  const cleanBody = rejectedBody.replace(/\s+/g, " ").trim().slice(0, REJECTED_DRAFT_CHAR_CAP);
  return cleanBody ? `"${cleanNote}" (rejected draft began: "${cleanBody}…")` : `"${cleanNote}"`;
}

/**
 * Collect the conversation's recent staff thumbs-down NOTES (newest first, bounded) for
 * the draft composer. Only outbound messages with rating "down" AND a non-empty note
 * count — a bare thumbs-down carries no instruction to follow.
 */
export function collectRecentStaffCorrections(
  conv: { messages?: FeedbackMessageLike[] | null } | null | undefined,
  nowIso: string,
  opts?: { maxNotes?: number; maxAgeDays?: number; excludeMessageId?: string | null }
): string[] {
  const messages = conv?.messages ?? [];
  if (!Array.isArray(messages) || !messages.length) return [];
  const maxNotes = Math.max(1, opts?.maxNotes ?? DEFAULT_MAX_NOTES);
  const maxAgeDays = Math.max(1, opts?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return [];
  const minMs = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  const excludeId = String(opts?.excludeMessageId ?? "").trim();

  const hits: Array<{ atMs: number; line: string }> = [];
  for (const m of messages) {
    if (!m || m.direction !== "out") continue;
    if (excludeId && String(m.id ?? "") === excludeId) continue;
    const fb = m.feedback;
    if (!fb || String(fb.rating ?? "").toLowerCase() !== "down") continue;
    const note = String(fb.note ?? "").trim();
    if (!note) continue;
    const atMs = Date.parse(String(fb.at ?? ""));
    if (!Number.isFinite(atMs) || atMs < minMs || atMs > nowMs + 60_000) continue;
    hits.push({ atMs, line: boundedLine(note, String(m.body ?? "")) });
  }
  hits.sort((a, b) => b.atMs - a.atMs);
  return hits.slice(0, maxNotes).map(h => h.line);
}
