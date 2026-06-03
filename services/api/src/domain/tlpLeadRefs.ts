export type TlpLeadRefCandidateOptions = {
  explicitLeadRef?: unknown;
  draftId?: unknown;
  multiRefWindowHours?: number;
};

export function normalizeTlpLeadRef(value: unknown): string {
  return String(value ?? "").trim();
}

export function extractTlpLeadRefFromAdfBody(body: unknown): string {
  const text = String(body ?? "");
  return (
    text.match(/(?:^|\n)\s*Ref:\s*([^\n\r]+)/i)?.[1]?.trim() ||
    text.match(/(?:^|\n)\s*Lead\s*Ref:\s*([^\n\r]+)/i)?.[1]?.trim() ||
    ""
  );
}

export function leadProfileForTlpRef(conv: any, leadRef: string): any | null {
  const normalized = normalizeTlpLeadRef(leadRef);
  if (!normalized) return null;
  const candidates = [conv?.latestLead, conv?.lead, conv?.originalLead];
  return candidates.find(profile => normalizeTlpLeadRef(profile?.leadRef) === normalized) ?? null;
}

export function adfMessageAtForTlpLeadRef(conv: any, leadRef: string): string | null {
  const normalized = normalizeTlpLeadRef(leadRef);
  if (!normalized || !Array.isArray(conv?.messages)) return null;
  for (const message of conv.messages) {
    if (message?.direction !== "in") continue;
    if (String(message?.provider ?? "").toLowerCase() !== "sendgrid_adf") continue;
    if (extractTlpLeadRefFromAdfBody(message?.body) === normalized) {
      return String(message?.at ?? "").trim() || null;
    }
  }
  return null;
}

function fallbackTlpLeadRefs(conv: any): string[] {
  const refs = [
    normalizeTlpLeadRef(conv?.latestLead?.leadRef),
    normalizeTlpLeadRef(conv?.lead?.leadRef)
  ].filter(Boolean);
  return [...new Set(refs)];
}

export function resolveTlpContactLeadRefs(
  conv: any,
  opts?: TlpLeadRefCandidateOptions
): string[] {
  const explicit = normalizeTlpLeadRef(opts?.explicitLeadRef);
  if (explicit) return [explicit];

  if (!Array.isArray(conv?.messages)) {
    return fallbackTlpLeadRefs(conv);
  }

  const draftId = normalizeTlpLeadRef(opts?.draftId);
  const draftIndex = draftId ? conv.messages.findIndex((m: any) => String(m?.id ?? "") === draftId) : -1;
  const scanEndExclusive = draftIndex >= 0 ? draftIndex : conv.messages.length;
  const entries: { ref: string; atMs: number; index: number }[] = [];

  for (let i = 0; i < scanEndExclusive; i += 1) {
    const message = conv.messages[i];
    if (message?.direction !== "in") continue;
    if (String(message?.provider ?? "").toLowerCase() !== "sendgrid_adf") continue;
    const ref = extractTlpLeadRefFromAdfBody(message?.body);
    if (!ref) continue;
    const atMs = Date.parse(String(message?.at ?? ""));
    entries.push({ ref, atMs: Number.isFinite(atMs) ? atMs : 0, index: i });
  }

  if (entries.length === 0) {
    return fallbackTlpLeadRefs(conv);
  }

  const newestAtMs = Math.max(...entries.map(entry => entry.atMs).filter(Boolean));
  const hours = Math.max(1, opts?.multiRefWindowHours ?? 72);
  const windowMs = hours * 60 * 60 * 1000;
  const seen = new Set<string>();
  const refs: string[] = [];

  for (const entry of [...entries].reverse()) {
    if (seen.has(entry.ref)) continue;
    const withinWindow = !newestAtMs || !entry.atMs || newestAtMs - entry.atMs <= windowMs;
    if (!withinWindow) continue;
    seen.add(entry.ref);
    refs.push(entry.ref);
  }

  for (const fallback of fallbackTlpLeadRefs(conv)) {
    if (!seen.has(fallback)) refs.push(fallback);
  }

  return refs;
}

export function resolveTlpContactLeadRef(
  conv: any,
  opts?: TlpLeadRefCandidateOptions
): string {
  return resolveTlpContactLeadRefs(conv, opts)[0] ?? "";
}
