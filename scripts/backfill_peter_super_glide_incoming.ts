/**
 * One-off data repair: put Peter Arnoldo (+17166887637) back on the SUPER GLIDE he actually asked
 * for, in the spoken-for / pending-incoming state the live code produces today.
 *
 * WHY (Joe ruling 2026-07-28: "Peter wants a super glide"):
 * His 2026-07-18 Traffic Log Pro walk-in note reads "Wants to see new Super Glide and told him we
 * would reach out once the next one we have coming in arrives which is spoken for. projected ship
 * date is 7/29". Two days LATER, PR #234 (`b4bf7c45`, 7/20) taught the walk-in intake to route
 * exactly this shape — an incoming unit allocated to someone else — to a STAFF HANDOFF with a
 * "notify when it arrives" task, never an availability watch. That PR was written FROM this very
 * conversation. Peter's record predates it by two days, so it still carries the old outcome.
 *
 * It then got worse: `backfill_peter_superglide_watch.ts` (applied 7/18) decided "Super Glide" was
 * a rep typo and retargeted his watch to "Street Glide", on the premise that Harley no longer makes
 * a Super Glide and there were none in inventory. That premise is FALSE — the live feed carries a
 * 2026 Super Glide, another lead's Super Glide watch fired on 2026-07-23, and inventory_holds.json
 * holds a "Future Unit — 2026 Harley-Davidson FXD Super Glide" (deposit, ship 8/14) for a DIFFERENT
 * lead. That held future unit IS the "spoken for" one Peter's rep was describing. So the retarget
 * silently changed what Peter is waiting for, and he has heard nothing since 7/18. That script is
 * deleted in the same commit as this one so it can never be re-run.
 *
 * WHAT (on the ONE conversation +17166887637, mirroring the live spoken-for path exactly):
 *  - DROP the Street Glide availability watch. An availability watch is the wrong instrument here:
 *    the only Super Glide in the feed is already spoken for, so a watch would either stay silent
 *    (the unit is on hold) or promise Peter a bike that is not his.
 *  - SET `pendingIncomingInventory` (allocation "spoken_for_other") built by the SAME domain helper
 *    the live path uses, with the model forced to the rep's typed "Super Glide" — model-authority,
 *    the same rule the live path applies over the structured ADF Vehicle field ("Street Glide").
 *  - HAND OFF: dialogState `pending_incoming_inventory`, followUp `manual_handoff`, cadence stopped.
 *    Staff own a pipeline/allocation conversation; the agent must not improvise ship dates.
 *  - QUEUE the staff notify task (`buildPendingIncomingInventoryTaskSummary`), owner = the lead
 *    owner already on the conversation, in the same record shape `addTodo` writes.
 *
 * `purpose` is deliberately left unset: the live path fills it from an LLM comprehension of the
 * note, which a backfill cannot reproduce deterministically. It is not needed here — a
 * "spoken_for_other" allocation outranks the purpose framing in the task copy.
 *
 * SAFETY: dry-run by default; --apply writes. Touches no other conversation. Idempotent (a conv
 * already in the pending-incoming state proposes nothing). Quiesce the API first (pm2 stop) and
 * back up conversations.json — the running service holds the store in memory and would clobber an
 * in-place edit — then restart so it reloads.
 *
 *   SELF-TEST: npx tsx scripts/backfill_peter_super_glide_incoming.ts --self-test
 *   DRY RUN:   CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_peter_super_glide_incoming.ts
 *   APPLY:     CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_peter_super_glide_incoming.ts --apply
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildPendingIncomingInventoryFromConversation,
  buildPendingIncomingInventoryTaskSummary
} from "../services/api/src/domain/pendingIncomingInventory.ts";

const TARGET_CONV_ID = "+17166887637";
/** The model the REP typed in the walk-in note — outranks the structured ADF Vehicle field. */
const WANTED_MODEL = "Super Glide";

export type RepairDeps = {
  nowIso: string;
  /** Injected so the self-test is deterministic; production passes the real id maker. */
  makeTodoId: () => string;
};

export type RepairResult = {
  summary: string;
  mutate: () => void;
  /** The staff task to append to the store's top-level `todos` array. */
  todo: Record<string, unknown>;
};

const customerName = (conv: any): string =>
  [String(conv?.lead?.firstName ?? "").trim(), String(conv?.lead?.lastName ?? "").trim()]
    .filter(Boolean)
    .join(" ")
    .trim() ||
  String(conv?.lead?.name ?? "").trim() ||
  String(conv?.leadKey ?? "").trim() ||
  "customer";

/** Pure: the proposed repair for this ONE conversation, or null when it isn't the target / is done. */
export function correctPeterSuperGlideIncoming(conv: any, deps: RepairDeps): RepairResult | null {
  if (!conv || conv.id !== TARGET_CONV_ID) return null;
  // Idempotent — a conversation already handed off on a pending incoming unit needs nothing.
  if (String(conv?.pendingIncomingInventory?.status ?? "").toLowerCase() === "pending") return null;

  const sourceText = String(conv?.lead?.walkInComment ?? conv?.lead?.inquiry ?? "").trim();
  const sourceMessageId =
    (Array.isArray(conv?.messages) ? conv.messages.find((m: any) => m?.direction === "in") : null)?.id ?? undefined;

  const pending = buildPendingIncomingInventoryFromConversation({
    conv,
    sourceText,
    source: "adf",
    sourceMessageId,
    allocation: "spoken_for_other",
    nowIso: deps.nowIso
  });
  if (!pending) return null;
  // MODEL AUTHORITY: the rep's typed model beats the structured Vehicle field, same as the live path.
  pending.model = WANTED_MODEL;
  pending.label = WANTED_MODEL;

  const taskSummary = buildPendingIncomingInventoryTaskSummary({
    pending,
    customerName: customerName(conv)
  });

  const droppedWatch = [
    conv?.inventoryWatch?.model,
    ...(Array.isArray(conv?.inventoryWatches) ? conv.inventoryWatches.map((w: any) => w?.model) : [])
  ]
    .filter(Boolean)
    .filter((m: string, i: number, list: string[]) => list.indexOf(m) === i)
    .join(", ");

  const todo = {
    id: deps.makeTodoId(),
    convId: conv.id,
    leadKey: conv.leadKey,
    ownerId: conv?.leadOwner?.id ?? undefined,
    ownerName: conv?.leadOwner?.name ?? undefined,
    reason: "call",
    taskClass: "followup",
    summary: taskSummary,
    sourceMessageId,
    createdAt: deps.nowIso,
    status: "open"
  };

  const summary =
    `watch dropped [${droppedWatch || "none"}] -> pending incoming "${pending.label}" ` +
    `(spoken_for_other), manual_handoff + cadence stopped, staff task: "${taskSummary}"`;

  return {
    summary,
    todo,
    mutate: () => {
      conv.pendingIncomingInventory = pending;
      // Same three fields `clearInventoryWatchState` (index.ts) clears — all undefined, so they drop
      // out of the written JSON. NOT its followUp mode: that helper parks a customer who asked us to
      // STOP watching (paused_indefinite); Peter is a staff-owned pipeline handoff.
      conv.inventoryWatch = undefined;
      conv.inventoryWatches = undefined;
      conv.inventoryWatchPending = undefined;
      conv.dialogState = { name: "pending_incoming_inventory", updatedAt: deps.nowIso };
      conv.followUp = {
        mode: "manual_handoff",
        reason: "pending_incoming_inventory",
        updatedAt: deps.nowIso
      };
      if (conv.followUpCadence) {
        conv.followUpCadence.status = "stopped";
        conv.followUpCadence.stopReason = "pending_incoming_inventory";
      }
      conv.updatedAt = deps.nowIso;
    }
  };
}

// ── self-test (explicit --self-test only, so a no-flag run is the real dry-run) ──
if (process.argv.includes("--self-test")) {
  const deps: RepairDeps = { nowIso: "2026-07-28T15:00:00.000Z", makeTodoId: () => "todo_selftest" };

  // The live record as it stands on the store today.
  const peter: any = {
    id: TARGET_CONV_ID,
    leadKey: TARGET_CONV_ID,
    leadOwner: { id: "479f56d0-ecd0-4136-acd5-77a964968aa5", name: "Scott Hartrich" },
    lead: {
      firstName: "Peter",
      lastName: "Arnoldo",
      vehicle: { make: "Harley-Davidson", year: "2026", model: "Street Glide", condition: "new" },
      walkInComment:
        "Wants to see new Super Glide and told him we would reach out once the next one we have coming in arrives which is spoken for. projected ship date is 7/29 (Step 2)"
    },
    messages: [{ id: "msg_in_1", direction: "in", body: "WEB LEAD (ADF) ..." }],
    dialogState: { name: "followup_paused", updatedAt: "2026-07-18T18:54:37.767Z" },
    followUp: { mode: "holding_inventory", reason: "inventory_watch" },
    followUpCadence: { status: "stopped", stopReason: "inventory_watch" },
    inventoryWatch: { model: "Street Glide", condition: "new", status: "active" },
    inventoryWatches: [{ model: "Street Glide", condition: "new", status: "active" }]
  };

  const repair = correctPeterSuperGlideIncoming(peter, deps);
  assert.ok(repair, "the target conversation is proposed for repair");
  assert.match(repair!.summary, /Street Glide/, "the dropped watch is named in the dry-run summary");
  repair!.mutate();

  assert.equal(peter.pendingIncomingInventory.status, "pending", "the unit is now a pending incoming one");
  assert.equal(peter.pendingIncomingInventory.model, "Super Glide", "the rep's typed model wins over the ADF field");
  assert.equal(peter.pendingIncomingInventory.allocation, "spoken_for_other", "the incoming unit is someone else's");
  assert.equal(peter.pendingIncomingInventory.purpose, undefined, "purpose is left to live comprehension, never fabricated");
  assert.equal(peter.inventoryWatch, undefined, "the wrong Street Glide watch is gone");
  assert.equal(peter.inventoryWatches, undefined, "both watch storage slots are cleared");
  assert.equal(peter.dialogState.name, "pending_incoming_inventory");
  assert.equal(peter.followUp.mode, "manual_handoff", "staff own a pipeline/allocation conversation");
  assert.equal(peter.followUpCadence.status, "stopped", "the agent cadence stays stopped");

  // The staff task must name the customer, the unit, AND that the incoming one is claimed —
  // otherwise a rep could promise Peter a bike that already belongs to another customer.
  assert.match(repair!.todo.summary as string, /Peter Arnoldo/, "the task names the customer");
  assert.match(repair!.todo.summary as string, /Super Glide/, "the task names the right bike");
  assert.match(repair!.todo.summary as string, /spoken for/i, "the task warns the incoming unit is claimed");
  assert.equal(repair!.todo.status, "open");
  assert.equal(repair!.todo.ownerName, "Scott Hartrich", "the existing lead owner keeps the task");

  assert.equal(correctPeterSuperGlideIncoming(peter, deps), null, "idempotent — a repaired conv proposes nothing");
  assert.equal(
    correctPeterSuperGlideIncoming({ id: "+15550000000", inventoryWatch: { model: "Street Glide" } }, deps),
    null,
    "no other conversation is ever touched"
  );

  console.log("PASS backfill peter super glide incoming (self-test: model authority, handoff, staff task, scoped, idempotent)");
  process.exit(0);
}

// ── real run ──
const apply = process.argv.includes("--apply");
const convPath =
  process.env.CONVERSATIONS_DB_PATH ||
  (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : "");
if (!convPath || !fs.existsSync(convPath)) {
  console.error("Set CONVERSATIONS_DB_PATH (or DATA_DIR) to the conversations.json to repair.");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(convPath, "utf8"));
const conversations: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : [];
const conv = conversations.find(c => c?.id === TARGET_CONV_ID);
if (!conv) {
  console.error(`Conversation ${TARGET_CONV_ID} not found in ${convPath}.`);
  process.exit(2);
}

const nowIso = new Date().toISOString();
const makeTodoId = () => `todo_${Math.random().toString(36).slice(2, 15)}_${Date.now()}`;
const repair = correctPeterSuperGlideIncoming(conv, { nowIso, makeTodoId });

console.log(`# Backfill — Peter Arnoldo Super Glide: ${apply ? "APPLIED" : "DRY-RUN (nothing written)"}`);
if (!repair) {
  console.log(`  (nothing to do — ${TARGET_CONV_ID} is already on a pending incoming unit)`);
  process.exit(0);
}
console.log(`  - ${TARGET_CONV_ID}: ${repair.summary}`);
console.log(`  - staff task queued for: ${repair.todo.ownerName ?? "(unassigned)"}`);

if (apply) {
  repair.mutate();
  if (!Array.isArray(raw.todos)) raw.todos = [];
  raw.todos.push(repair.todo);
  fs.writeFileSync(convPath, JSON.stringify(raw, null, 2));
  console.log(`\nApplied and persisted ${convPath}. Restart the API so it reloads the store.`);
} else {
  console.log("\n(dry-run — nothing written. Re-run with --apply after review.)");
}
