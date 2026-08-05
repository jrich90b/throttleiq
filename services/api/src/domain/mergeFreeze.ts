/**
 * MERGE FREEZE — the thing that makes a full-suite release gate actually achievable.
 *
 * Joe, 2026-08-04: "let's set up the full suite with the golden corpus."
 *
 * THE PROBLEM. `ci:eval` takes ~45 minutes. `throttleiq-unstack-loop` merges every ~20. On 8/4 main
 * moved FOUR times under a single deploy attempt (#519, #523, #524, #526), so the tree that was
 * proven green was never the tree that would ship. Chasing it is unwinnable arithmetic: you cannot
 * finish a 45-minute proof about a branch that changes every 20 minutes. The choice was either
 * deploy something unproven or never deploy. This is the third option — hold merges still for one
 * gate window, prove the exact tree, ship it, let go.
 *
 * SHAPE. A freeze is a directory (mkdir is atomic, so two routines cannot both take it) holding a
 * JSON record of who took it, when, and why. Every routine that MERGES checks it first; a routine
 * that only builds, reviews, or reports is unaffected and keeps working.
 *
 * FAIL-DIRECTION — this is the important part, and it points AWAY from the freeze. A stuck freeze
 * would silently halt every routine's ability to land work, which is far worse than one deploy
 * shipping on a slightly-moved main. So:
 *   - a freeze EXPIRES on its own (`maxAgeMinutes`, default 90 — comfortably longer than a gate run,
 *     far shorter than a working day). An expired freeze is reported as such and MUST be ignored;
 *   - a malformed, unreadable, or undated record reads as NOT frozen, never as frozen;
 *   - releasing is idempotent and safe to call from any exit path, including a failed gate.
 * In other words: every ambiguous state means "carry on merging". The freeze can only ever pause
 * work while it is demonstrably fresh and well-formed.
 *
 * Pure decision logic here; the CLI (`scripts/merge_freeze.ts`) owns the filesystem and the clock.
 */

import nodeFs from "node:fs";

export type MergeFreezeRecord = {
  /** Routine or person that took it. */
  owner: string;
  /** ISO timestamp the freeze was taken. */
  at: string;
  /** Why — shown to whoever is blocked, so a freeze is never a mystery. */
  reason?: string;
};

export type MergeFreezeStatus =
  | { frozen: false; reason: "absent" }
  | { frozen: false; reason: "malformed"; detail: string }
  | { frozen: false; reason: "expired"; owner: string; ageMinutes: number }
  | { frozen: true; owner: string; ageMinutes: number; why: string };

/** Minutes a freeze is honoured before it is treated as abandoned. */
export const DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES = 90;

/**
 * Read a freeze record into a decision. `raw` is whatever was on disk (or null when the freeze
 * directory does not exist). Anything we cannot positively read as a FRESH freeze comes back
 * `frozen: false` — see the fail-direction note above.
 */
export function evaluateMergeFreeze(
  raw: unknown,
  args: { nowMs: number; maxAgeMinutes?: number }
): MergeFreezeStatus {
  if (raw === null || raw === undefined) return { frozen: false, reason: "absent" };
  const rec = raw as Partial<MergeFreezeRecord>;
  if (typeof rec !== "object") return { frozen: false, reason: "malformed", detail: "not an object" };

  const owner = String(rec.owner ?? "").trim();
  if (!owner) return { frozen: false, reason: "malformed", detail: "no owner" };

  const atMs = Date.parse(String(rec.at ?? ""));
  if (!Number.isFinite(atMs)) return { frozen: false, reason: "malformed", detail: "no readable timestamp" };

  const maxAge = Math.max(1, args.maxAgeMinutes ?? DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES);
  const ageMinutes = Math.max(0, Math.round((args.nowMs - atMs) / 60_000));
  if (ageMinutes > maxAge) return { frozen: false, reason: "expired", owner, ageMinutes };

  const why = String(rec.reason ?? "").trim() || "release gate in progress";
  return { frozen: true, owner, ageMinutes, why };
}

/** One line a blocked routine can print (and a human can act on) without re-deriving anything. */
export function describeMergeFreeze(status: MergeFreezeStatus): string {
  if (status.frozen) {
    return `MERGE FROZEN by ${status.owner} ${status.ageMinutes}m ago — ${status.why}. Do not merge; end this tick and retry next run.`;
  }
  switch (status.reason) {
    case "absent":
      return "no merge freeze — merging is allowed";
    case "expired":
      return `stale merge freeze from ${status.owner} (${status.ageMinutes}m old) IGNORED — merging is allowed`;
    case "malformed":
      return `unreadable merge freeze (${status.detail}) IGNORED — merging is allowed`;
  }
}

/**
 * The freeze as read FROM DISK — the form every caller actually needs, and the one place the
 * fail-open promise is kept. `evaluateMergeFreeze` above judges a record; this finds it.
 *
 * Extracted 2026-08-04 because act_runner grew its own copy of the read and a sabotage test walked
 * straight through it: the eval was checking `evaluateMergeFreeze` while the BUG lived in the
 * wrapper. One readable implementation, one thing to test.
 *
 * FAIL OPEN on everything that is not an explicit, live freeze — absent dir, absent file, corrupt
 * JSON, unreadable permissions, any throw at all. A stuck freeze silently halting every routine's
 * ability to land work is far worse than one deploy shipping on a slightly-moved main.
 */
export function readMergeFreezeStatus(args: {
  dir: string;
  nowMs: number;
  maxAgeMinutes?: number;
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
}): MergeFreezeStatus {
  try {
    const record = `${args.dir.replace(/\/+$/, "")}/freeze.json`;
    const exists = args.exists ?? ((p: string) => nodeFs.existsSync(p));
    if (!exists(record)) return { frozen: false, reason: "absent" };
    const readFile = args.readFile ?? ((p: string) => nodeFs.readFileSync(p, "utf8"));
    return evaluateMergeFreeze(JSON.parse(readFile(record)), {
      nowMs: args.nowMs,
      maxAgeMinutes: args.maxAgeMinutes
    });
  } catch {
    return { frozen: false, reason: "malformed", detail: "unreadable — failing open" };
  }
}
