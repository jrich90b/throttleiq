/**
 * Auto-reproduce confirmation for the self-healing loop (Joe, 2026-07-24: "run the triage in
 * the routines so we don't have to burn down the report").
 *
 * The classify step (scripts/anomaly_loop_detect.ts) already drops findings via three
 * heuristics — stale-eval-guarded, open/merged-PR ledger, already-shipped-echo — but ALL THREE
 * are date/commit-name GUESSES. None re-runs the actual conversation to confirm the miss still
 * reproduces on the currently-DEPLOYED code, so a human still hand-triages next.json each run
 * (re-replaying candidate turns to separate real live misses from already-fixed ghosts).
 *
 * This module is the pure core of a fourth pass that moves that triage into the routine: a
 * bounded box sweep (scripts/reproduce_confirm_sweep.ts) re-replays the top-N eligible findings'
 * pinned turns against the deployed dist, judges the new draft with the SAME intent-handled
 * judge the corpus-replay flywheel uses, and writes a sibling file of findings that NO LONGER
 * reproduce. detect then drops exactly those keys.
 *
 * FAIL-DIRECTION (one way only — surface): a finding is confirmable-stale ONLY when a clean
 * re-replay of its pinned turn PASSED. Any replay/judge error, a turn that still reproduces, a
 * messageId mismatch (the conversation moved to a newer turn), a moved deploy commit, or a stale
 * sibling file → the finding is KEPT and surfaces. We never suppress a finding we did not
 * actually re-run and clear. Mirrors the fail-safe discipline of loopPrDedup.ts.
 */
import { findingKeyOf, isMeaningfulFindingKey, type LoopWorkOrder } from "./loopPrDedup.js";

/**
 * Dimensions where "re-draft the last inbound and judge with the intent-handled judge" is a
 * MEANINGFUL reproduce of the miss. v1 is deliberately narrow:
 *  - corpus_replay_judge_fail: literally a last-turn replay the judge marked unaddressed —
 *    re-running is the identical measurement.
 *  - human_correction_material: staff materially corrected the AI draft — re-judging the new
 *    draft directly tests whether current code now addresses the same turn.
 * Grow this set only as each new dimension earns a matching judge criterion (open_critic judges
 * ACTIONS not the reply draft; reported_issue / thumbs_down are human judgment; cadence/watch
 * are not reply-draft reproducible — all intentionally excluded).
 */
export const ELIGIBLE_REPRODUCE_DIMENSIONS: ReadonlySet<string> = new Set([
  "corpus_replay_judge_fail",
  "human_correction_material"
]);

export function isReproduceEligibleDimension(dimension: string | null | undefined): boolean {
  return ELIGIBLE_REPRODUCE_DIMENSIONS.has(String(dimension ?? "").trim());
}

/**
 * The pinned turn a finding is about, as a Twilio/store message id (`msg_...`). corpus_replay
 * findings embed it in the detail (`[replay +NNN::msg_abc_123]`); other feeds may carry an
 * explicit messageId field. Returns null when none is resolvable — and a null pin can NEVER be
 * confirmed stale (we can't prove the replayed last-inbound is the finding's turn).
 */
export function extractPinnedMessageId(finding: {
  messageId?: string | null;
  detail?: string | null;
  [k: string]: unknown;
}): string | null {
  const explicit = String(finding?.messageId ?? "").trim();
  if (/^msg_[A-Za-z0-9_]+$/.test(explicit)) return explicit;
  const m = String(finding?.detail ?? "").match(/\bmsg_[A-Za-z0-9]+_[0-9]+\b/);
  return m ? m[0] : null;
}

export type ReproduceCandidate = {
  convId: string;
  dimension: string;
  key: string;
  pinnedMessageId: string | null;
};

/**
 * From the (already tier/severity-ranked) work orders in next.json, pick the top-`max` findings
 * that are (a) an eligible dimension and (b) carry a resolvable convId + pinned messageId — the
 * only ones a last-turn replay can fairly confirm. Preserves the incoming rank order (detect
 * already ranked Tier 2 → Tier 1, P1 → P2), so we spend the replay budget on the most important
 * findings first. Findings without a pinned messageId are skipped here (they'd never be
 * confirmable anyway), keeping the replay batch small.
 */
export function selectReproduceCandidates(
  workOrders: LoopWorkOrder[] | null | undefined,
  opts?: { max?: number }
): ReproduceCandidate[] {
  const max = Math.max(0, Math.floor(opts?.max ?? 8));
  const out: ReproduceCandidate[] = [];
  const seen = new Set<string>();
  for (const wo of workOrders ?? []) {
    if (out.length >= max) break;
    const dimension = String(wo?.dimension ?? "").trim();
    if (!isReproduceEligibleDimension(dimension)) continue;
    const convId = String(wo?.convId ?? "").trim();
    if (!convId) continue;
    const key = findingKeyOf(convId, dimension);
    if (!isMeaningfulFindingKey(key) || seen.has(key)) continue;
    const pinnedMessageId = extractPinnedMessageId(wo as any);
    if (!pinnedMessageId) continue; // unpinnable → can't fairly confirm → leave it surfacing
    seen.add(key);
    out.push({ convId, dimension, key, pinnedMessageId });
  }
  return out;
}

/**
 * One replay sample's outcome for a candidate turn: was the pinned turn actually replayed
 * (`found` — a case for this conv + messageId came back), and did the deployed code produce an
 * addressed reply (`pass` — scoreTurn+adjustScore.pass on that case). `messageIdMatch` guards
 * against the conversation having moved to a NEWER last inbound than the finding's turn.
 */
export type ReproduceSample = { found: boolean; pass: boolean; messageIdMatch: boolean };

/**
 * A finding is confirmed-stale ONLY when it ran `requiredSamples` independent replays and EVERY
 * one found the pinned turn, matched its messageId, and PASSED. This asymmetric rigor (a PASS
 * here SUPPRESSES a finding, unlike the flywheel where a non-repro keeps a regression) is why we
 * require multiple clean passes: a single nondeterministic judge/replay roll must not hide a live
 * miss. Zero samples, any miss, any mismatch, or any still-reproducing pass → NOT stale (kept).
 */
export function decideConfirmedStale(
  samples: ReproduceSample[] | null | undefined,
  opts?: { requiredSamples?: number }
): boolean {
  const required = Math.max(1, Math.floor(opts?.requiredSamples ?? 2));
  const s = samples ?? [];
  if (s.length < required) return false;
  return s.slice(0, required).every(x => x && x.found && x.messageIdMatch && x.pass);
}

export type ReproduceConfirmEntry = {
  convId?: string | null;
  dimension?: string | null;
  key?: string | null;
  verdict?: string | null;
};

export type ReproduceSuppression = { anomaly: LoopWorkOrder; key: string; verdict?: string | null };

/**
 * Drop a work order ONLY when its dimension is eligible AND its `convId::dimension` key is in the
 * confirmed-stale set (a clean multi-sample re-replay PASSED). Everything else — a finding that
 * still reproduces, an ineligible dimension, an unknown key — is KEPT. Pure; mirrors
 * partitionWorkOrdersByLoopPr.
 */
export function partitionByReproduceConfirm(
  workOrders: LoopWorkOrder[] | null | undefined,
  args: { confirmedStaleKeys?: ReadonlySet<string> | null; verdictByKey?: ReadonlyMap<string, string> | null }
): { kept: LoopWorkOrder[]; suppressed: ReproduceSuppression[] } {
  const kept: LoopWorkOrder[] = [];
  const suppressed: ReproduceSuppression[] = [];
  const stale = args?.confirmedStaleKeys ?? new Set<string>();
  for (const wo of workOrders ?? []) {
    if (!isReproduceEligibleDimension(wo?.dimension ?? null)) {
      kept.push(wo);
      continue;
    }
    const key = findingKeyOf(wo?.convId ?? null, wo?.dimension ?? null);
    if (isMeaningfulFindingKey(key) && stale.has(key)) {
      suppressed.push({ anomaly: wo, key, verdict: args?.verdictByKey?.get(key) ?? null });
      continue;
    }
    kept.push(wo);
  }
  return { kept, suppressed };
}

/**
 * Parse the sweep's sibling file (reports/reproduce_confirm/latest.json) with a freshness +
 * COMMIT-BINDING guard. Returns the confirmed-stale key set + per-key verdicts ONLY when the
 * payload is well-formed, `generatedAt` is within maxAgeDays (default 3), AND `commit` equals the
 * deployed commit. Any error / malformed / stale / commit-moved / empty-commit → null, and the
 * caller suppresses NOTHING.
 *
 * The commit binding is the extra rigor over the PR-ledger: a "no longer reproduces" verdict is
 * valid ONLY for the exact code it ran against, so a deploy between the sweep and detect
 * invalidates every verdict (mirrors the flywheel's skip-if-unchanged commit logic). Entries for
 * ineligible dimensions are discarded — a confirmed entry is only trustworthy where a re-replay
 * is a meaningful reproduce.
 */
export function parseReproduceConfirmPayload(
  payload: unknown,
  opts: { nowMs?: number; maxAgeDays?: number; deployedCommit?: string | null }
): { keys: Set<string>; verdictByKey: Map<string, string> } | null {
  const p = payload as any;
  if (!p || typeof p !== "object") return null;
  const generatedMs = Date.parse(String(p.generatedAt ?? ""));
  if (!Number.isFinite(generatedMs)) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  const maxAgeMs = (opts?.maxAgeDays ?? 3) * 24 * 60 * 60 * 1000;
  if (nowMs - generatedMs > maxAgeMs) return null; // stale sweep: don't trust its verdicts
  const payloadCommit = String(p.commit ?? "").trim();
  const deployed = String(opts?.deployedCommit ?? "").trim();
  if (!payloadCommit || !deployed) return null; // can't verify code identity → trust nothing
  if (payloadCommit !== deployed) return null; // deploy moved since the sweep → verdicts invalid
  if (!Array.isArray(p.confirmed)) return null;
  const keys = new Set<string>();
  const verdictByKey = new Map<string, string>();
  for (const e of p.confirmed as ReproduceConfirmEntry[]) {
    if (!e || typeof e !== "object") continue;
    const dimension = String((e as any).dimension ?? "").trim();
    const convId = String((e as any).convId ?? "").trim();
    const key = String((e as any).key ?? findingKeyOf(convId, dimension)).trim();
    if (!isMeaningfulFindingKey(key)) continue;
    const dim = dimension || key.split("::")[1] || "";
    if (!isReproduceEligibleDimension(dim)) continue; // only trust eligible-dimension verdicts
    keys.add(key);
    if ((e as any).verdict) verdictByKey.set(key, String((e as any).verdict));
  }
  return { keys, verdictByKey };
}
