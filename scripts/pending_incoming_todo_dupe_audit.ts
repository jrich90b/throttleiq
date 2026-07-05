/**
 * Read-only audit for duplicate pending-incoming "Notify when the trade arrives" todos.
 *
 * Reports, per conversation, how many copies of the singleton notify task are open and which
 * the dedup would retire (reusing the SAME pure planner the runtime heal uses). Read-only — it
 * NEVER writes. The actual cleanup is the in-process maintenance heal
 * (healPendingIncomingNotifyTodoDuplicates), which runs safely inside the live process; editing
 * the store file directly is unsafe (the running API holds todos in memory and would overwrite
 * your edit on its next save). Use this to size the backlog and to verify the heal afterwards.
 *
 * Usage:
 *   npx tsx scripts/pending_incoming_todo_dupe_audit.ts [path/to/conversations.json]
 *   # defaults to ./data/conversations.json
 */
import fs from "node:fs";
import {
  isPendingIncomingInventoryNotifyTodoSummary,
  planPendingIncomingNotifyDedup
} from "../services/api/src/domain/pendingIncomingInventory.ts";

const storePath = process.argv[2] || "data/conversations.json";
const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
const todos: any[] = Array.isArray(raw) ? [] : raw.todos ?? [];
const open = todos.filter(t => t?.status === "open");

const byConv = new Map<string, any[]>();
for (const t of open) {
  if (!isPendingIncomingInventoryNotifyTodoSummary(t?.summary)) continue;
  const list = byConv.get(t.convId) ?? [];
  list.push(t);
  byConv.set(t.convId, list);
}

let affectedConvs = 0;
let redundant = 0;
const rows: string[] = [];
for (const [convId, list] of byConv) {
  if (list.length < 2) continue;
  affectedConvs += 1;
  const plan = planPendingIncomingNotifyDedup(list);
  redundant += plan.retireIds.length;
  const classes = list.map(t => t.taskClass ?? "(none)").join(",");
  rows.push(`${convId} | open=${list.length} | classes=[${classes}] | keep=${plan.keepId} | retire=${plan.retireIds.length}`);
}

console.log(`store: ${storePath}`);
console.log(`conversations with an open notify-todo: ${byConv.size}`);
console.log(`conversations with DUPLICATES (>=2): ${affectedConvs}`);
console.log(`redundant tasks the heal would retire: ${redundant}`);
for (const r of rows.sort()) console.log(`  - ${r}`);
