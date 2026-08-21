/**
 * ACT-runner CLI argument contract — "am I reading the feed I think I am?"
 *
 * WHY THIS EXISTS (measured 2026-08-21, and it cost twelve days of queue).
 *
 * The loop's SKILL prescribes a two-step read: scp the box's work order to /tmp, filter it through
 * `loop_pr_ledger_filter.ts --in /tmp/next.json`, then read the SELECTION through
 * `act_runner.ts list`. Those two steps do not connect. `loop_pr_ledger_filter` takes `--in`;
 * `act_runner` never had one — it always read `<REPORT_ROOT>/anomaly_loop/next.json`, and its
 * argument parser is a bare `argv.indexOf`, so an unrecognised `--in /tmp/next.json` was neither
 * honoured nor rejected. It was silently DROPPED.
 *
 * The base clone's local `reports/anomaly_loop/next.json` was last written 2026-08-09. So every
 * `act_runner list --in /tmp/next.json` since then printed a frozen 8/09 selection of 14 work
 * orders while the live queue held 60 — including every operator report filed in the twelve days
 * between. The run believed it was reading the fresh feed it had just downloaded, because nothing
 * ever said otherwise. Two things had to be true at once for that to happen, and this module ends
 * both:
 *
 *   1. an unknown flag was ignored instead of refused, and
 *   2. nothing stated the age of the work order file actually being read.
 *
 * FAIL DIRECTION — toward REFUSING TO RUN, which is the right way round for a read-only triage
 * tool. A rejected flag costs one corrected command; a silently ignored one costs a fortnight of
 * invisible findings. The staleness check is the softer half and only WARNS: a genuinely old feed
 * is still the best evidence available when the detectors are down, and suppressing the queue over
 * its age would re-create the "an empty queue looks like a quiet store" failure that
 * `detectorFeedFreshness.ts` exists to prevent. Loud, never silent; never suppressing.
 *
 * Pure and scripts-only: no filesystem, no clock, no `services/api/src` imports, no side effects.
 * Consumed by `scripts/act_runner.ts`; pinned by `scripts/act_runner_feed_input_eval.ts`, which
 * EXECUTES the CLI rather than asserting on this file's source text.
 */

/** Flags that consume the NEXT argv token as their value. */
type FlagSpec = { value: readonly string[]; bool: readonly string[] };

/**
 * The complete flag surface, per subcommand. Derived from every `flag(...)`/`has(...)` call site in
 * act_runner.ts — if a subcommand grows a flag, it belongs here too, or the CLI will refuse it.
 */
export const ACT_RUNNER_FLAGS: Readonly<Record<string, FlagSpec>> = {
  list: { value: ["in"], bool: [] },
  prep: { value: ["id", "in"], bool: ["top"] },
  "check-open-pr": { value: ["key"], bool: [] },
  dispose: { value: ["key", "as", "by", "deploy-ts", "note"], bool: [] },
  "open-pr": { value: ["title", "finding-key"], bool: ["eval-verified"] },
  review: {
    value: ["title", "finding-key", "finding", "charter"],
    bool: ["ship", "eval-verified"]
  }
};

/** Subcommands that read the work order feed and therefore accept `--in`. */
export const FEED_READING_SUBCOMMANDS = ["list", "prep"] as const;

/**
 * Every `--flag` in argv that the subcommand does not declare.
 *
 * A value-taking flag's value is skipped, so `--note "--not-a-flag"` is not reported. An unknown
 * flag's value cannot be identified as a value (we do not know the flag's arity), so it is skipped
 * conservatively only when it does not itself start with `--` — which keeps `--in /tmp/next.json`
 * reporting exactly one unknown flag rather than two.
 */
export function unknownFlags(argv: readonly string[], sub: string | undefined): string[] {
  const spec = sub ? ACT_RUNNER_FLAGS[sub] : undefined;
  if (!spec) return []; // unknown subcommand — the usage banner already handles that case
  const known = new Set<string>([...spec.value, ...spec.bool]);
  const takesValue = new Set<string>(spec.value);
  const out: string[] = [];
  // argv[0] is the subcommand itself.
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    if (known.has(name)) {
      if (takesValue.has(name)) i += 1; // its value is not a flag, whatever it looks like
      continue;
    }
    out.push(token);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) i += 1;
  }
  return out;
}

/** The refusal a caller sees. Names the flags, the subcommand, and what IS accepted. */
export function formatUnknownFlagError(sub: string, unknown: readonly string[]): string {
  const spec = ACT_RUNNER_FLAGS[sub];
  const accepted = spec
    ? [...spec.value.map(f => `--${f} <value>`), ...spec.bool.map(f => `--${f}`)].join(" ") || "(no flags)"
    : "(no flags)";
  const plural = unknown.length === 1 ? "flag" : "flags";
  const feedHint = (FEED_READING_SUBCOMMANDS as readonly string[]).includes(sub)
    ? ""
    : `\n   NOTE: only ${FEED_READING_SUBCOMMANDS.join(" and ")} read the work order feed, so only they accept --in.`;
  return (
    `!! UNKNOWN ${plural.toUpperCase()} for \`act_runner ${sub}\`: ${unknown.join(" ")}\n` +
    `   Refusing to run rather than ignoring it. An ignored flag is how a stale feed gets read as a fresh one.\n` +
    `   ${sub} accepts: ${accepted}${feedHint}`
  );
}

/**
 * Which work order file to read. `--in` wins; otherwise the report root's own, exactly as before.
 * Returned with its provenance so the caller can SAY which file it read — the silent part of the
 * 8/21 failure was that nothing ever named the path.
 */
export function resolveWorkOrderPath(args: {
  inFlag: string | undefined;
  defaultPath: string;
}): { path: string; source: "--in" | "report-root" } {
  const explicit = args.inFlag?.trim();
  return explicit
    ? { path: explicit, source: "--in" }
    : { path: args.defaultPath, source: "report-root" };
}

/**
 * The work order file is DAILY, like the detector feeds it is built from, so it shares their
 * bound. Kept as its own constant because it measures a different thing: `detectorFeedFreshness`
 * asks "did the detectors run?", this asks "is the file in front of me from today?".
 */
export const WORK_ORDER_STALE_HOURS_DEFAULT = 26;

export function workOrderAgeHours(generatedAt: unknown, nowMs: number): number | null {
  if (typeof generatedAt !== "string" || !generatedAt.trim()) return null;
  const ms = Date.parse(generatedAt);
  if (!Number.isFinite(ms)) return null;
  return (nowMs - ms) / 3_600_000;
}

/**
 * The banner. Returns null when the feed is current — a fresh read stays quiet, so the banner
 * appearing always means something.
 *
 * An UNDATABLE feed (no parsable `generatedAt`) reports stale, matching `detectorFeedFreshness`:
 * a file whose age cannot be established is exactly the file that turns out to be from last week.
 */
export function formatStaleWorkOrderBanner(args: {
  path: string;
  source: "--in" | "report-root";
  generatedAt: unknown;
  nowMs: number;
  staleHours?: number;
}): string | null {
  const bound = args.staleHours ?? WORK_ORDER_STALE_HOURS_DEFAULT;
  const age = workOrderAgeHours(args.generatedAt, args.nowMs);
  if (age !== null && age <= bound) return null;
  const how =
    args.source === "--in" ? "read from --in" : "read from REPORT_ROOT (no --in given)";
  const when =
    age === null
      ? `carries no usable generatedAt stamp, so its age cannot be established`
      : age >= 48
        ? `was generated ${Math.floor(age / 24)} DAYS ago (${age.toFixed(0)}h)`
        : `was generated ${age.toFixed(1)}h ago (over the ${bound}h daily bound)`;
  return (
    `\n!! THIS WORK ORDER FILE IS STALE — it ${when}.\n` +
    `   file: ${args.path}  (${how})\n` +
    `   Findings filed since are NOT in it. If you downloaded a fresh feed, pass it: --in <path>.\n` +
    `   Nothing below has been suppressed or reordered — this is provenance, not a filter.\n`
  );
}
