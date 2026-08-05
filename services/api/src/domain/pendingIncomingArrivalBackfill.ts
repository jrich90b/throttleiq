/**
 * Arrival backfill sweep — teach a DORMANT pending-incoming record the arrival date it never got.
 *
 * WHY THIS EXISTS, and why it is not a script (2026-08-03). #486 made a known future arrival the
 * authority for the "Notify {customer} when the {unit} arrives" task, and added a reconcile heal to
 * re-date tasks already sitting on a wrong date. Deployed, it fixed nobody: the heal can only act on
 * `pendingIncomingInventory.expectedArrivalAt`, and the code that CAPTURES an arrival for a record
 * established before #337 runs inside `applyPendingIncomingInventoryState` — i.e. only when a turn
 * happens. Mohamed Ahmed +17164258647 had told us he would "stop by when it arrives" and gone quiet
 * on 7/29, so no turn was ever coming and his task kept reading due 8/3 for an 8/21 bike. All three
 * open arrival-notify tasks were in that state.
 *
 * The obvious fix — a one-shot script that edits the store — is UNSAFE and the repo already says so
 * (`scripts/pending_incoming_todo_dupe_audit.ts`): "the running API holds todos in memory and would
 * overwrite your edit on its next save". The only safe writer is the live process, so the backfill
 * belongs on the reconcile tick, exactly like the dedup and cadence-realign heals.
 *
 * IT SELF-EXTINGUISHES, which is what makes an LLM call acceptable inside a recurring sweep. A
 * record is eligible only while it has an OPEN notify task, NO arrival of any kind, stored seed text
 * to read, and no previous attempt. Every attempt stamps `expectedArrivalCheckedAt` whether or not
 * it found a date, so each record is parsed AT MOST ONCE, ever — three today, ~zero thereafter (new
 * records get their arrival on the live turn and never become eligible). A per-tick cap bounds the
 * worst case if a backlog ever appears.
 *
 * COMPREHENSION, not pattern-matching: the arrival is read by the same
 * `parseIncomingInventoryPurposeWithLLM` (`expected_arrival_text`) the live path uses, resolved by
 * the same `parseRequestedDateOnly`, and applied by the same `applyComprehendedArrivalToPending`.
 * This module inspects no prose of its own — it only decides WHICH records to read and what to do
 * with the answer.
 *
 * FAIL DIRECTION: nothing here can create, send, or close anything. The worst case is that a record
 * is marked checked and keeps the undated task it already has — which is today's behavior. It never
 * moves a task PAST the arrival (planPendingIncomingNotifyDueAtUpdate owns that), and it never
 * touches a record that already has an arrival.
 */
import {
  applyComprehendedArrivalToPending,
  isPendingIncomingInventoryNotifyTodoSummary
} from "./pendingIncomingInventory.js";
import { parseIncomingInventoryPurposeWithLLM } from "./llmDraft.js";
import {
  healPendingIncomingNotifyTodoArrivalDate,
  healPendingIncomingNotifyTodosAcross,
  parseRequestedDateOnly,
  saveConversation
} from "./conversationStore.js";

/** Default per-tick cap. Small on purpose: this is a backlog drain, not a hot path. */
export const ARRIVAL_BACKFILL_DEFAULT_LIMIT = 10;

type PendingLike = {
  note?: string | null;
  expectedArrivalText?: string | null;
  expectedArrivalAt?: string | null;
  expectedArrivalCheckedAt?: string | null;
};

/**
 * THE REFEREE for the one-time arrival backfill: may this record be read and stamped?
 *
 * It is a `decide*` because it genuinely arbitrates the write below it — nothing else may stamp
 * `expectedArrivalCheckedAt` or spend a parse without asking here first. Pure, and returns the
 * reason so the route outcome records WHY a record was skipped.
 *
 * Pure, and deliberately conservative — every clause removes a reason to spend an LLM call:
 *  - `hasOpenNotifyTodo`: no task, nothing to fix. This is what keeps the sweep off the whole store.
 *  - already has `expectedArrivalText` or `expectedArrivalAt`: the live path got there first.
 *  - `expectedArrivalCheckedAt`: we have already tried once. Set even on a miss, so a record with no
 *    stated timing is never re-parsed on every tick forever.
 *  - no seed text: nothing to comprehend.
 */
export function decidePendingIncomingArrivalBackfill(
  pending: PendingLike | null | undefined,
  hasOpenNotifyTodo: boolean
): { backfill: boolean; reason: string } {
  if (!pending) return { backfill: false, reason: "no_pending_record" };
  if (!hasOpenNotifyTodo) return { backfill: false, reason: "no_open_notify_todo" };
  if (String(pending.expectedArrivalText ?? "").trim()) return { backfill: false, reason: "arrival_text_known" };
  if (String(pending.expectedArrivalAt ?? "").trim()) return { backfill: false, reason: "arrival_date_known" };
  if (String(pending.expectedArrivalCheckedAt ?? "").trim()) return { backfill: false, reason: "already_attempted" };
  if (!String(pending.note ?? "").trim()) return { backfill: false, reason: "no_seed_text" };
  return { backfill: true, reason: "arrival_unknown_and_unattempted" };
}

export type ArrivalBackfillResult = {
  convId: string;
  leadKey: string;
  arrivalText: string | null;
  expectedArrivalAt: string | null;
  dueAtMoved: boolean;
  reason: string;
};

/**
 * Walk the conversations that still owe an arrival, comprehend it once, and let the existing heal
 * re-date the task. Returns one row per record ATTEMPTED (including misses, so the log is honest
 * about what the parser could not find).
 */
export async function sweepPendingIncomingArrivalBackfill(args: {
  convs: any[];
  openTodos: Array<{ convId: string; status?: string; summary?: string | null }>;
  timezone?: string | null;
  nowIso: string;
  limit?: number;
}): Promise<ArrivalBackfillResult[]> {
  const withOpenNotify = new Set<string>();
  for (const t of args.openTodos) {
    if (t?.status === "open" && isPendingIncomingInventoryNotifyTodoSummary(t?.summary)) {
      withOpenNotify.add(t.convId);
    }
  }
  const limit = Number.isFinite(args.limit) ? Number(args.limit) : ARRIVAL_BACKFILL_DEFAULT_LIMIT;
  const results: ArrivalBackfillResult[] = [];
  for (const conv of args.convs) {
    if (results.length >= limit) break;
    const pending = conv?.pendingIncomingInventory;
    const decision = decidePendingIncomingArrivalBackfill(pending, withOpenNotify.has(conv?.id));
    if (!decision.backfill) continue;
    // Stamp the attempt BEFORE the parse resolves anything, so a thrown parse still burns the one
    // try. A record we keep failing to read must not become a per-tick LLM bill.
    pending.expectedArrivalCheckedAt = args.nowIso;
    let arrivalText: string | null = null;
    try {
      const parsed = await parseIncomingInventoryPurposeWithLLM({
        seedText: String(pending.note ?? "").trim(),
        condition: null,
        vehicle: String(pending.label ?? pending.model ?? "").trim() || null
      });
      arrivalText = String(parsed?.expectedArrivalText ?? "").trim() || null;
    } catch {
      arrivalText = null;
    }
    if (arrivalText) {
      applyComprehendedArrivalToPending({
        pending,
        arrivalText,
        arrivalDay: parseRequestedDateOnly(arrivalText, args.timezone || "America/New_York"),
        nowMs: Date.parse(args.nowIso)
      });
    }
    const dueAtMoved = arrivalText ? healPendingIncomingNotifyTodoArrivalDate(conv) : false;
    saveConversation(conv);
    results.push({
      convId: String(conv?.id ?? ""),
      leadKey: String(conv?.leadKey ?? ""),
      arrivalText,
      expectedArrivalAt: String(pending.expectedArrivalAt ?? "") || null,
      dueAtMoved,
      reason: decision.reason
    });
  }
  return results;
}

/**
 * The reconcile tick's WHOLE arrival-notify pass, in the order the heals depend on each other:
 *
 *  1. BACKFILL a dormant record's missing arrival (once per record, ever) — without this, step 3
 *     has nothing to act on, which is precisely why #486 deployed and fixed none of the three
 *     open tasks.
 *  2. DEDUP the notify singleton, so step 3 dates the SURVIVOR and not a copy about to be retired.
 *  3. RE-DATE the survivor onto the arrival.
 *
 * One entry point so the caller cannot get the order wrong, and so index.ts carries a call instead
 * of a procedure — the source-size ratchet's standing instruction.
 */
export async function sweepPendingIncomingNotifyTodos(args: {
  convs: any[];
  convById: Map<string, any>;
  openTodos: any[];
  timezone?: string | null;
  nowIso: string;
  limit?: number;
}): Promise<{
  backfilled: ArrivalBackfillResult[];
  dedup: Array<{ convId: string; leadKey: string; retired: number }>;
  reDated: Array<{ convId: string; leadKey: string; dueAt: string | null }>;
}> {
  const backfilled = await sweepPendingIncomingArrivalBackfill(args);
  const heal = healPendingIncomingNotifyTodosAcross(args.convById, args.openTodos);
  return { backfilled, ...heal };
}
