/**
 * "We'll keep an eye out" must mint SOMETHING — a watch when the thread names the bike, a dated
 * staff task when it doesn't. Silence is the one outcome that is never right.
 *
 * THE MISS (Joe's report 2026-08-12, `kunwarsahilnaseem@gmail.com`): a Room58 lead asked for a
 * 2016–2018 Forty-Eight in Corona Yellow; both outbounds said "we will keep an eye out"; nothing
 * has tracked it since April. THREE stacked gates each dropped the turn (all executed 2026-08-14):
 *
 *  1. `hasManualPromiseHint`'s deliverable-verb list had no watch phrasing, so the promise parser
 *     never ran on "ok we will keep an eye out. thanks for your inquiry".
 *  2. When run, the promise parser reads it `kind: "inventory_notify"` 3/3 (0.80–0.86) — which
 *     `isActionablePromiseKind` deliberately excludes, on the premise "the watch arm handles it".
 *  3. The watch arm's cue pair (`explicitWatchVerb && inventoryAvailabilityCue`) requires a bike
 *     NOUN in the REP'S OWN text, and the semantic parser's `watchAction` reads CUSTOMER intent —
 *     it returns "none" for a rep promise 3/3 even while extracting the spec (model "Forty Eight",
 *     color "corona yellow", years 2016–2018) perfectly from the thread.
 *
 * So: the PROMISE parser is the authority on "the rep promised an inventory watch" (its verdict,
 * 3/3), and the SLOT parser is the authority on WHAT to watch (its `watch` object, 3/3) — and this
 * module turns the pair into one plan. The keyword cues remain COST gates only, never vetoes.
 *
 * FAIL DIRECTION (per the 8/14 diagnosis, and Joe's report is the ruling): a false watch is a text
 * the customer half-wanted and can opt out of; a missed one is a lead that never hears from us
 * again — over-firing is the cheap side. A spec with no usable model NEVER mints a watch (the
 * placeholder guard), and falls to a dismissible dated task instead.
 */
import { isPlaceholderModel } from "./modelDeflection.js";
import type { UnifiedSemanticSlotParse } from "./llmDraft.js";

/**
 * COST hint for the manual-outbound watch arm (moved verbatim from index.ts, where the pair was
 * being used as a VETO — `verb && noun` — which is what dropped Kunwar's turn; the noun leg also
 * misses real models like "Low Rider S" that its list never contained). Exported so the arm can
 * keep the pair as a fast-path and the eval can execute both legs.
 */
export function hasManualOutboundWatchCue(textLower: string): { verb: boolean; noun: boolean } {
  const verb =
    /\b(keep (?:an|any) eye out|watch for|let you know (?:if|when)|text you (?:if|when|as soon as)|notify you (?:if|when))\b/i.test(
      textLower
    ) ||
    (/\b(i(?:'|’)ll|i will|we(?:'|’)ll|we will)\b/i.test(textLower) &&
      /\b(let you know|text you|notify you)\b/i.test(textLower));
  const noun =
    /\b(comes in|lands|in stock|available|availability|pre[- ]?owned|used|new|bike|model|road glide|street glide|road king|sportster|softail|breakout|touring|trike|pan america|nightster|xg500|xg750|xg750a|street 500|street 750|street rod)\b/i.test(
      textLower
    );
  return { verb, noun };
}

export type InventoryNotifyPromisePlan =
  | {
      kind: "watch";
      watch: {
        model: string;
        year?: number;
        yearMin?: number;
        yearMax?: number;
        color?: string;
        condition?: "new" | "used";
        exactness: "model_only";
        status: "active";
        createdAt: string;
        note: string;
      };
    }
  | { kind: "task"; summary: string; dueAtIso: string };

/**
 * Turn an `inventory_notify` staff promise into its follow-through. Pure — the slot parse comes in
 * as data, the caller owns every side effect (merge via mergeInventoryWatches, arm via
 * applyInventoryWatchArm, task via addTodo), so the eval can execute the whole decision table.
 *
 * The spec is trusted only as far as the parsers took it: no model, or a placeholder model
 * ("Full Line", "Other") ⇒ the TASK plan — a watch without a real model would alert on nothing or
 * on everything. Year handling mirrors the slot shape: a single parseable year pins `year`;
 * a "2016-2018" range string or yearMin/yearMax pins the range fields.
 */
export function resolveInventoryNotifyPromisePlan(args: {
  slots: UnifiedSemanticSlotParse | null;
  nowIso: string;
  /** ~24h out: the promise must not quietly age out when no watch could be set. */
  taskDueIso: string;
}): InventoryNotifyPromisePlan {
  const watch = args.slots?.watch ?? null;
  const model = String(watch?.model ?? "").trim();
  const taskPlan = (why: string): InventoryNotifyPromisePlan => ({
    kind: "task",
    summary: `Told the customer we'd keep an eye out and nothing is tracking it (${why}). Set up the inventory watch or follow through by hand.`,
    dueAtIso: args.taskDueIso
  });
  if (!model) return taskPlan("no bike named anywhere in the thread");
  if (isPlaceholderModel(model)) return taskPlan(`only a placeholder model ("${model}") resolved`);

  const yearRaw = String(watch?.year ?? "").trim();
  const rangeMatch = yearRaw.match(/^(\d{4})\s*[-–]\s*(\d{4})$/);
  const singleYear = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : undefined;
  const yearMin =
    typeof watch?.yearMin === "number" && Number.isFinite(watch.yearMin)
      ? watch.yearMin
      : rangeMatch
        ? Number(rangeMatch[1])
        : undefined;
  const yearMax =
    typeof watch?.yearMax === "number" && Number.isFinite(watch.yearMax)
      ? watch.yearMax
      : rangeMatch
        ? Number(rangeMatch[2])
        : undefined;
  const color = String(watch?.color ?? "").trim() || undefined;
  const condition = watch?.condition === "new" || watch?.condition === "used" ? watch.condition : undefined;
  return {
    kind: "watch",
    watch: {
      model,
      ...(singleYear ? { year: singleYear } : {}),
      ...(yearMin !== undefined ? { yearMin } : {}),
      ...(yearMax !== undefined ? { yearMax } : {}),
      ...(color ? { color } : {}),
      ...(condition ? { condition } : {}),
      exactness: "model_only",
      status: "active",
      createdAt: args.nowIso,
      note: "manual_outbound_watch_promise"
    }
  };
}
