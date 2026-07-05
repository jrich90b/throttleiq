/**
 * Preferred-date parser for STRUCTURED ADF/web-form fields (e.g. Room58 "Book test ride"
 * lead.preferredDate). Shared by the SendGrid inbound path and the regenerate path so the two can't
 * drift (they previously had byte-identical private copies: parsePreferredDateOnly /
 * parsePreferredDateOnlyForReply).
 *
 * Room58 (and similar web forms) emit DD/MM/YYYY. The old copies assumed US MM/DD, so "29/6/2026"
 * parsed month=29 → null → the test-ride lead silently fell through to a generic "not in stock"
 * deflection that ignored the customer's requested date+time (convs 08610167776, 8879803743).
 *
 * This lives at the STRUCTURED-FIELD boundary on purpose — it is NOT the free-text customer date
 * parser (conversationStore.parseExplicitDate), which must keep the US MM/DD default for typed SMS.
 * Deterministic structured-field parsing (AGENTS.md allows deterministic for structured extraction).
 */

// Parse a structured preferred-date field into a UTC noon Date, or null. DD/MM-aware:
// - first component > 12 (can't be a month) but a valid day, second a valid month → DD/MM.
// - otherwise the US MM/DD default (so genuinely ambiguous M/D like "5/8" is unchanged).
// Purely additive vs the old MM/DD-only parser: every date that parsed before parses identically;
// only previously-null DD/MM values now resolve.
export function parsePreferredAdfDate(value: string | null | undefined): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (!m) return null;
  const first = Number(m[1]);
  const second = Number(m[2]);
  let year = m[3] ? Number(m[3]) : new Date().getUTCFullYear();
  if (m[3] && m[3].length === 2) year = 2000 + year;

  let month: number;
  let day: number;
  if (first > 12 && first <= 31 && second >= 1 && second <= 12) {
    // Unambiguous DD/MM (the structured web-form case).
    day = first;
    month = second;
  } else {
    // US MM/DD default (unchanged behavior for free-text-style values).
    month = first;
    day = second;
  }

  if (
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

// Long-form label ("Monday, June 29") for a structured preferred-date field, or null.
export function formatPreferredAdfDateForReply(value: string | null | undefined): string | null {
  const date = parsePreferredAdfDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(date);
}
