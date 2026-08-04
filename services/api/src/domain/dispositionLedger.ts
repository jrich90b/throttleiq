/**
 * Disposition ledger — the DURABLE "already dealt with" record for the self-healing loop.
 *
 * Joe, 2026-07-30: "it should know what is stale/already fixed and not show up again."
 * The three existing suppression passes are all INFERENCE — a dimension-level fix cutover
 * (suppressStaleFindings), a commit whose message happens to name the phone number
 * (suppressAlreadyShippedEchoes), a 14-day merged-PR window (loopPrDedup). Each is a guess
 * that expires, so a finding a routine explicitly disposed weeks ago comes back as fresh
 * Tier-2 work: on 2026-07-30 the feed still ranked Derek's budget miss (Joe-ruled AND built
 * 7/29) and the Aaron Smith no-show (disposed that morning) in its top 8.
 *
 * This is the non-inferential complement: when a routine DISPOSES a finding it records the
 * fact once, keyed by `convId::dimension`, and detect suppresses that key PERMANENTLY —
 * no window, no expiry, nothing to re-derive.
 *
 * THE ONE FAIL-SAFE EXCEPTION: a disposition must never silently eat a real regression. A
 * disposition is one of two kinds, and the kind decides whether a later occurrence can
 * revive the key:
 *
 *   CODE-STATE ("fixed" / "stale-echo") — a claim ABOUT THE CODE at a moment in time. It
 *     carries a boundary (`deployTs ?? at`). An occurrence AFTER that boundary is evidence
 *     the fix did not hold, so the finding comes back marked `regression-of-disposed`.
 *     An occurrence we cannot date is unknowable ⇒ KEPT (same fail-safe as the sibling
 *     passes: never hide what we cannot prove is old).
 *
 *   POLICY ("no-action" / "joe-ruled") — a claim that this finding IS NOT A DEFECT. That
 *     does not expire and does not depend on dates, so the key is suppressed outright.
 *     Safe because a disposition is scoped to ONE conversation+dimension: if the underlying
 *     rule really regresses, it surfaces on other convIds, which carry no disposition.
 *
 * Fail-direction throughout: a malformed record, an unknown disposition, or an unparseable
 * timestamp suppresses NOTHING. We only ever hide a finding someone explicitly disposed.
 *
 * Pure + IO-free. The file lives box-side at REPORT_ROOT/anomaly_loop/dispositions.json;
 * scripts/act_runner.ts `dispose` is the single writer every routine calls.
 */
import { findingKeyOf, isMeaningfulFindingKey } from "./loopPrDedup.js";

/** The vocabulary every routine disposes with (ROUTINE_CONTRACT.md "Staleness"). */
export type Disposition = "fixed" | "stale-echo" | "no-action" | "joe-ruled";

export const DISPOSITIONS: readonly Disposition[] = ["fixed", "stale-echo", "no-action", "joe-ruled"] as const;

/** Claims about the CODE at a point in time — dated, so a later occurrence can revive them. */
export const CODE_STATE_DISPOSITIONS: ReadonlySet<Disposition> = new Set<Disposition>(["fixed", "stale-echo"]);

/** Claims that the finding is NOT A DEFECT — timeless, so the key stays suppressed. */
export const POLICY_DISPOSITIONS: ReadonlySet<Disposition> = new Set<Disposition>(["no-action", "joe-ruled"]);

export function isDisposition(value: unknown): value is Disposition {
  return typeof value === "string" && (DISPOSITIONS as readonly string[]).includes(value);
}

export type DispositionRecord = {
  /** `convId::dimension` — the same key act_runner stamps on loop PRs. */
  key: string;
  disposition: Disposition;
  /** When the finding was FIRST disposed (ISO). Earliest wins on re-dispose — see upsertDisposition. */
  at: string;
  /** Which routine disposed it. */
  by: string;
  /** For a code-state disposition: when the fix reached production. The regression boundary. */
  deployTs?: string | null;
  note?: string | null;
};

export type DispositionLedger = ReadonlyMap<string, DispositionRecord>;

export const DISPOSITION_LEDGER_VERSION = 1;

/**
 * The regression boundary: an occurrence strictly after this is a possible post-fix
 * regression. `deployTs` (when the fix actually shipped) beats `at` (when we wrote it down),
 * because a routine often disposes a finding hours after the deploy that fixed it.
 * Always finite for a record that survived parsing.
 */
export function dispositionBoundaryMs(record: DispositionRecord): number {
  const deployMs = Date.parse(String(record.deployTs ?? ""));
  if (Number.isFinite(deployMs)) return deployMs;
  return Date.parse(record.at);
}

function parseRecord(raw: unknown): DispositionRecord | null {
  const r = raw as any;
  if (!r || typeof r !== "object") return null;
  const key = String(r.key ?? "").trim();
  // A key that dedups to nothing ("::") would suppress by accident — reject it.
  if (!key || !isMeaningfulFindingKey(key)) return null;
  if (!isDisposition(r.disposition)) return null; // unknown vocabulary → suppress nothing
  const at = String(r.at ?? "").trim();
  if (!Number.isFinite(Date.parse(at))) return null; // undatable record → suppress nothing
  const deployRaw = r.deployTs == null ? null : String(r.deployTs).trim();
  // A present-but-unparseable deployTs is dropped rather than trusted; `at` then carries the
  // boundary (earlier ⇒ more findings resurface ⇒ the safe direction).
  const deployTs = deployRaw && Number.isFinite(Date.parse(deployRaw)) ? deployRaw : null;
  return {
    key,
    disposition: r.disposition,
    at,
    by: String(r.by ?? "unknown").trim() || "unknown",
    deployTs,
    note: r.note == null ? null : String(r.note)
  };
}

/**
 * Parse the on-disk ledger. Returns a key→record map, or null when the payload is not a
 * ledger at all (caller then suppresses nothing). Individual malformed records are dropped
 * rather than failing the whole file — one bad hand-edit must not un-suppress everything,
 * and must not suppress anything either.
 *
 * Deliberately NOT freshness-guarded (unlike parseLoopPrLedgerPayload): this ledger is the
 * permanent record. An old disposition is still a disposition.
 */
export function parseDispositionLedgerPayload(payload: unknown): Map<string, DispositionRecord> | null {
  const p = payload as any;
  if (!p || typeof p !== "object") return null;
  const rows = Array.isArray(p.records) ? p.records : null;
  if (!rows) return null;
  const out = new Map<string, DispositionRecord>();
  for (const raw of rows) {
    const rec = parseRecord(raw);
    if (rec) out.set(rec.key, rec);
  }
  return out;
}

/**
 * Record a disposition, one row per key (idempotent — re-disposing updates in place).
 *
 * The newest statement wins for disposition/by/note, but `at` keeps the EARLIEST value: the
 * boundary must never drift later on its own, or occurrences between the original disposal
 * and a re-disposal would stop counting as regressions. `deployTs` DOES take a newer value,
 * because naming a deploy is an explicit "a fix landed then" claim, not drift.
 */
export function upsertDisposition(
  existing: readonly DispositionRecord[] | null | undefined,
  entry: DispositionRecord
): DispositionRecord[] {
  const rows = (existing ?? []).filter(r => r.key !== entry.key);
  const prior = (existing ?? []).find(r => r.key === entry.key);
  let at = entry.at;
  if (prior) {
    const priorMs = Date.parse(prior.at);
    const nextMs = Date.parse(entry.at);
    if (Number.isFinite(priorMs) && (!Number.isFinite(nextMs) || priorMs < nextMs)) at = prior.at;
  }
  rows.push({
    ...entry,
    at,
    deployTs: entry.deployTs ?? prior?.deployTs ?? null,
    note: entry.note ?? prior?.note ?? null
  });
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return rows;
}

export function serializeDispositionLedger(
  records: readonly DispositionRecord[],
  opts?: { nowIso?: string }
): { version: number; updatedAt: string; records: DispositionRecord[] } {
  return {
    version: DISPOSITION_LEDGER_VERSION,
    updatedAt: opts?.nowIso ?? new Date().toISOString(),
    records: [...records]
  };
}

/** An anomaly / work-order row — anything carrying convId + dimension (+ optional occurredAt). */
export type DisposableFinding = {
  convId?: string | null;
  dimension?: string | null;
  occurredAt?: string | null;
  /** Upper bound on the triggering event (operator "Report issue" time) — see occurrenceMsOf. */
  reportedAt?: string | null;
  [k: string]: unknown;
};

/**
 * When a code-state disposition may treat this finding as pre-fix.
 *
 * `occurredAt` is the triggering event and is always preferred. But a whole SOURCE never sets it:
 * an operator "Report issue" (dimension `reported_issue`) carries only `reportedAt`, deliberately
 * kept separate at the source so the stale-finding suppressor can't mistake an upper bound for the
 * event (conversationOutcomeAudit.ts, OutcomeAnomaly field note). Undated ⇒ KEPT, so before this
 * fallback EVERY `fixed`/`stale-echo` disposition on a reported_issue key suppressed nothing:
 * measured 2026-08-02, 23 such records sat in the ledger while all 65 of their findings stayed in
 * the feed, and the burndown loop re-triaged leads it had itself disposed 90 minutes earlier.
 *
 * An upper bound is SOUND here in a way it is not at the source, because of the direction of the
 * comparison: suppression requires `ts <= boundary`, and since `event <= reportedAt`, proving
 * `reportedAt <= boundary` proves `event <= boundary` too. The error can only ever fall the safe
 * way — a report filed after the fix looks NEWER than it is, so it resurfaces as a regression
 * rather than being eaten. That is the same fail-direction the rest of this module keeps.
 */
export function occurrenceMsOf(finding: DisposableFinding | null | undefined): number {
  const occurredMs = Date.parse(String(finding?.occurredAt ?? ""));
  if (Number.isFinite(occurredMs)) return occurredMs;
  return Date.parse(String(finding?.reportedAt ?? "")); // NaN when neither is datable ⇒ caller keeps it
}

export type DispositionSuppression<T = DisposableFinding> = {
  anomaly: T;
  key: string;
  record: DispositionRecord;
  reason: string;
};

export type DispositionRegression<T = DisposableFinding> = {
  anomaly: T;
  key: string;
  record: DispositionRecord;
  reason: string;
};

export type DispositionPartition<T = DisposableFinding> = {
  kept: T[];
  suppressed: DispositionSuppression<T>[];
  /** Disposed keys that RE-OCCURRED after their fix boundary — surfaced, never eaten. */
  regressions: DispositionRegression<T>[];
};

/**
 * Split a feed against the ledger: undisposed findings are KEPT, disposed ones are dropped,
 * and a disposed CODE-STATE key with an occurrence after its boundary comes back as a
 * regression (the caller re-adds these, marked, so a failed fix is never hidden).
 *
 * An empty/absent ledger suppresses nothing.
 */
export function partitionByDispositions<T extends DisposableFinding>(
  anomalies: readonly T[] | null | undefined,
  args: { ledger?: DispositionLedger | null }
): DispositionPartition<T> {
  const kept: T[] = [];
  const suppressed: DispositionSuppression<T>[] = [];
  const regressions: DispositionRegression<T>[] = [];
  const ledger = args.ledger;
  for (const a of anomalies ?? []) {
    const key = findingKeyOf(a?.convId ?? null, a?.dimension ?? null);
    const record = ledger && isMeaningfulFindingKey(key) ? ledger.get(key) : undefined;
    if (!record) {
      kept.push(a);
      continue;
    }
    if (POLICY_DISPOSITIONS.has(record.disposition)) {
      // Not a defect — timeless, and scoped to this one conversation+dimension.
      suppressed.push({
        anomaly: a,
        key,
        record,
        reason: `disposed ${record.disposition} by ${record.by} on ${record.at} — policy disposition, permanently suppressed`
      });
      continue;
    }
    const boundaryMs = dispositionBoundaryMs(record);
    const occurredMs = occurrenceMsOf(a);
    if (!Number.isFinite(occurredMs)) {
      // Can't date the occurrence ⇒ can't prove it predates the fix ⇒ keep (fail-safe).
      kept.push(a);
      continue;
    }
    if (!Number.isFinite(boundaryMs)) {
      kept.push(a);
      continue;
    }
    // Name the timestamp we actually compared (an operator report has only `reportedAt`), so the
    // reason line stays auditable instead of reading "event undefined".
    const occurredIso = new Date(occurredMs).toISOString();
    if (occurredMs > boundaryMs) {
      regressions.push({
        anomaly: a,
        key,
        record,
        reason: `regression-of-disposed: event ${occurredIso} postdates the ${record.disposition} boundary ${record.deployTs ?? record.at}`
      });
      continue;
    }
    suppressed.push({
      anomaly: a,
      key,
      record,
      reason: `disposed ${record.disposition} by ${record.by} — event ${occurredIso} predates the boundary ${record.deployTs ?? record.at}`
    });
  }
  return { kept, suppressed, regressions };
}

// ===================================================================================================
// THE REGRESSION SHIELD (2026-08-04 — Charles Desalvo +17168614216)
//
// `partitionByDispositions` above makes a promise: a disposed finding whose event POSTDATES its fix
// boundary comes back marked `regression-of-disposed`, so "a fix that did not hold is never silently
// eaten". That promise did not survive the rest of the detector. Four more suppression passes run
// AFTER it — PR-ledger, already-shipped echo, stale-finding, re-replay — and every one of them
// matches on `convId::dimension` alone, which is exactly the key the ledger just decided must be
// seen. Whichever fires first wins, and the regression disappears with no trace in the work order.
//
// MEASURED. Joe filed "No sold cadence" on +17168614216 at 2026-08-03T12:32Z. The 8/4 08:55 feed
// classified it correctly as a regression (its event postdates the 08:56 fixed boundary) and then
// dropped it anyway, because PR #470 — merged at 08:43 that SAME MORNING, four hours before the
// report was even filed — shares the lead's `reported_issue` key. Work-order rows: zero. Nobody
// could have worked it. Generalized: one PR on a lead permanently blinds every LATER report on that
// lead, because a lead has ONE key per dimension no matter how many separate things go wrong on it.
//
// The shield is deliberately dumb and runs LAST: whatever the passes did, put back anything the
// ledger marked as a regression. FAIL DIRECTION: it can only ever ADD findings back, and only ones
// a routine already disposed and the ledger already re-armed — so the worst case is re-triaging a
// finding, never hiding one. Restoring is a no-op when the passes left the regression alone.
// ===================================================================================================

export type RegressionShieldResult<T> = {
  /** The surviving findings, plus any regression a later pass had dropped. */
  anomalies: T[];
  /** The ones this shield had to put back — empty when the passes behaved. */
  restored: T[];
};

/**
 * Put back any ledger-marked regression that a downstream suppression pass dropped.
 *
 * Order is preserved: survivors keep their position, restored regressions are appended.
 */
export function restoreDisposedRegressions<T extends { convId?: unknown; dimension?: unknown }>(
  survivors: readonly T[],
  regressions: readonly T[]
): RegressionShieldResult<T> {
  // Same key function every suppression pass uses — `findingKeyOf` from loopPrDedup, already
  // imported above and used by `partitionByDispositions`. Sharing it is the point: the shield must
  // recognize a finding as "already present" by exactly the key the passes matched on to drop it.
  const keyOf = (a: T) => findingKeyOf((a as any)?.convId ?? null, (a as any)?.dimension ?? null);
  const present = new Set(survivors.map(keyOf));
  const restored: T[] = [];
  for (const r of regressions) {
    const key = keyOf(r);
    if (present.has(key)) continue;
    present.add(key); // never restore the same key twice
    restored.push(r);
  }
  return { anomalies: [...survivors, ...restored], restored };
}
