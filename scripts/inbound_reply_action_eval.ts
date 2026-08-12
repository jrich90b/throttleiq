import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseInboundReplyActionWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Action =
  | "dealer_location_question"
  | "explicit_callback_request"
  | "schedule_context_status_update"
  | "inventory_watch_acknowledgement"
  | "pending_incoming_inventory_acknowledgement"
  | "none";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  hasActiveInventoryWatch?: boolean;
  hasPendingIncomingInventory?: boolean;
  dialogState?: string | null;
  expected: {
    /**
     * Optional for the same reason as should_reply: a SLOT-focused row (one pinning
     * scheduling_conflict_open) should not also pin an action the parser reads ambiguously.
     * "Thursday works, how about 2pm" is defensibly either `none` or
     * `schedule_context_status_update`; what the row is proving is that the conflict slot is
     * FALSE there. The action/explicit metrics count only the rows that assert them.
     */
    action?: Action;
    /**
     * Optional, and DO NOT pin it on a row whose action is `none`.
     *
     * Both consumers read action FIRST and stop: `shouldTakeInboundReplyAction`
     * (inboundReplyActionPrompt.ts) is `action === "none" || !explicitAction -> false`, and the
     * email lane's `parsed.action !== action` guard never reaches the field either. So on a
     * `none` row this label steers no decision, while the parser is genuinely split on it —
     * "I'll pass, I'm not doing it this year" is a withdrawal, which reads as an explicit act to
     * one sample and as no action to the next.
     *
     * MEASURED on origin/main 2026-08-12: pinning it on that one row failed **2 of 6** runs, all
     * on this field. With the runner's single flake-retry that is ~11% of every full gate run
     * going red, for everyone, over a value nothing branches on. Assert the DECISION, not the
     * label. (Dropping it from that row: 6/6 clean, explicit-action coverage 18/18 intact.)
     */
    explicit_action?: boolean;
    /**
     * Optional: omit on rows where the field is incidental to what the row is pinning. The
     * parser is legitimately non-deterministic on should_reply for a bare withdrawal (the
     * disposition path owns that turn either way), and pinning it would only make CI flaky.
     */
    should_reply?: boolean;
    /**
     * OPEN SCHEDULING CONFLICT slot (William Indelicato +17163591526, 2026-07-24). Optional so
     * the pre-existing rows stay as written; when present it is scored like the other fields.
     */
    scheduling_conflict_open?: boolean;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "inbound_reply_action_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_INBOUND_REPLY_ACTION_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_INBOUND_REPLY_ACTION_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let total = 0;
let actionOk = 0;
let actionTotal = 0;
let explicitOk = 0;
let explicitTotal = 0;
let replyOk = 0;
let replyTotal = 0;
let conflictTotal = 0;
let conflictOk = 0;
let nullCount = 0;
const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseInboundReplyActionWithLLM({
    text: ex.text,
    history: ex.history,
    dialogState: ex.dialogState,
    hasActiveInventoryWatch: !!ex.hasActiveInventoryWatch,
    hasPendingIncomingInventory: !!ex.hasPendingIncomingInventory
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(`[${ex.id}] parser returned null`);
    continue;
  }

  const expectsAction = typeof ex.expected.action === "string";
  const actionMatch = !expectsAction || result.action === ex.expected.action;
  const expectsExplicit = typeof ex.expected.explicit_action === "boolean";
  const explicitMatch = !expectsExplicit || result.explicitAction === ex.expected.explicit_action;
  const expectsReply = typeof ex.expected.should_reply === "boolean";
  const replyMatch = !expectsReply || result.shouldReply === ex.expected.should_reply;
  const expectsConflict = typeof ex.expected.scheduling_conflict_open === "boolean";
  const conflictMatch =
    !expectsConflict || !!result.schedulingConflictOpen === ex.expected.scheduling_conflict_open;
  if (expectsConflict) {
    conflictTotal += 1;
    if (conflictMatch) conflictOk += 1;
  }

  if (expectsAction) {
    actionTotal += 1;
    if (actionMatch) actionOk += 1;
  }
  if (expectsExplicit) {
    explicitTotal += 1;
    if (explicitMatch) explicitOk += 1;
  }
  if (expectsReply) {
    replyTotal += 1;
    if (replyMatch) replyOk += 1;
  }

  if (!actionMatch || !explicitMatch || !replyMatch || !conflictMatch) {
    mismatches.push(
      `[${ex.id}] text=${JSON.stringify(ex.text)} | expected=${JSON.stringify(ex.expected)} | got=${JSON.stringify({
        action: result.action,
        explicitAction: result.explicitAction,
        shouldReply: result.shouldReply,
        schedulingConflictOpen: result.schedulingConflictOpen,
        normalizedText: result.normalizedText,
        reason: result.reason,
        confidence: result.confidence
      })}`
    );
  }
}

const pct = (n: number) => `${((n / Math.max(total, 1)) * 100).toFixed(1)}%`;
const pct2 = (n: number, d: number) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;
console.log(`Inbound reply action accuracy: ${actionOk}/${actionTotal} (${pct2(actionOk, actionTotal)})`);
console.log(`Explicit-action match: ${explicitOk}/${explicitTotal} (${pct2(explicitOk, explicitTotal)})`);
console.log(`Should-reply match: ${replyOk}/${replyTotal} (${pct2(replyOk, replyTotal)})`);
console.log(`Null parses: ${nullCount}/${total}`);
if (conflictTotal) {
  console.log(`Scheduling-conflict slot: ${conflictOk}/${conflictTotal} (${pct2(conflictOk, conflictTotal)})`);
}

if (mismatches.length) {
  console.error("\nMismatches:");
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

console.log("\nAll checks passed.");
