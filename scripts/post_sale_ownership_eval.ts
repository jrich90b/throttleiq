/**
 * Post-sale ownership-loss eval (2026-07-08).
 *
 * A customer on the POST-SALE cadence (courtesy/warranty/Custom Coverage touches about the bike we
 * sold them) can say the bike is GONE — sold, traded elsewhere, wrecked/totaled, given away, stolen.
 * The cadence must then stop durably instead of pestering them about a bike they don't own.
 * Operator-reported (John, +17164739373): a Custom Coverage reminder drew "Yeah i sold the bike
 * remember". Parser-first comprehension (parsePostSaleOwnershipWithLLM) + a pure decision
 * (decidePostSaleOwnershipTurn) + a deterministic side effect (stopFollowUpCadence "no_longer_owns"
 * — a stopReason the maintenance tick's sold-lead revive does NOT resurrect) in BOTH
 * /webhooks/twilio and /conversations/:id/regenerate. STATE ONLY: the reply stays with the normal
 * draft pipeline so a mixed message never loses its other half to a canned ack.
 *
 * Layers: (1) source guard (parser + flag + schema; centralized decision; hint + resolver wired
 * BOTH paths; durable stop reason; revive-does-not-resurrect), (2) pure decision table
 * (stop ONLY on an active post_sale cadence + accepted + explicit + confident no_longer_owns;
 * everything else => none — fail toward keeping the cadence), (3) LLM coverage (clear losses vs
 * ADVERSARIAL still-owns / plan-only / different-bike / idiom cases which must NOT stop).
 *
 * Run gated: LLM_ENABLED=1 LLM_POST_SALE_OWNERSHIP_PARSER_ENABLED=1 npx tsx scripts/post_sale_ownership_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parsePostSaleOwnershipWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decidePostSaleOwnershipTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Source guard. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");

assert.ok(/export async function parsePostSaleOwnershipWithLLM/.test(llm), "parser must be exported");
assert.ok(/POST_SALE_OWNERSHIP_PARSER_JSON_SCHEMA/.test(llm), "strict JSON schema const must exist");
assert.ok(/LLM_POST_SALE_OWNERSHIP_PARSER_ENABLED/.test(llm), "parser must be behind an enable flag");
assert.ok(
  /export function decidePostSaleOwnershipTurn/.test(reducer),
  "decision must be centralized in routeStateReducer"
);
assert.ok(
  /function postSaleOwnershipHint/.test(index) && /POST_SALE_OWNERSHIP_HINT_RE/.test(index),
  "pre-filter hint must exist (a gate, not comprehension — the parser owns the decision)"
);
const callSites = (index.match(/await applyPostSaleOwnershipUpdate\(/g) || []).length;
assert.ok(callSites >= 2, `the resolver must be wired in BOTH paths (live + regen); found ${callSites}`);
assert.ok(
  /stopFollowUpCadence\(conv, "no_longer_owns"\)/.test(index),
  'the side effect must stop the cadence with the durable "no_longer_owns" reason'
);
// STATE ONLY: the resolver must gate on an ACTIVE post_sale cadence.
assert.ok(
  /cadence\?\.kind === "post_sale" && cadence\?\.status === "active"/.test(index),
  "the resolver must gate on an active post_sale cadence"
);
// Durability: the maintenance tick's sold-lead revive only resurrects "appointment_booked" stops —
// a "no_longer_owns" stop must NOT be revived. Pin the exact revive condition.
assert.ok(
  /cadence\.status === "stopped" && cadence\.stopReason === "appointment_booked"/.test(index),
  'the sold-lead revive must stay scoped to stopReason "appointment_booked" (so "no_longer_owns" sticks)'
);
// stopFollowUpCadence must not treat "no_longer_owns" as one of the preserved-reason bypasses.
assert.ok(
  /reason === "manual_handoff" \|\| reason === "purchase_delivery"/.test(store),
  "stopFollowUpCadence's post_sale preserve-list must stay narrow (manual_handoff/purchase_delivery only)"
);

// --- 2) Decision-table coverage (pure). ---
type Row = {
  id: string;
  input: Parameters<typeof decidePostSaleOwnershipTurn>[0];
  kind: "stop_post_sale_cadence" | "none";
};
const ok = {
  hasActivePostSaleCadence: true,
  parserAccepted: true,
  intent: "no_longer_owns" as string | null,
  explicitStatement: true,
  confidence: 0.9,
  confidenceMin: 0.7
};
const rows: Row[] = [
  { id: "accepted_explicit_confident", input: { ...ok }, kind: "stop_post_sale_cadence" },
  { id: "at_floor", input: { ...ok, confidence: 0.7 }, kind: "stop_post_sale_cadence" },
  { id: "below_floor", input: { ...ok, confidence: 0.69 }, kind: "none" },
  // A plan/intention ("thinking about selling") is not a loss — explicit_statement gates the stop.
  { id: "not_explicit", input: { ...ok, explicitStatement: false }, kind: "none" },
  { id: "intent_none", input: { ...ok, intent: "none" }, kind: "none" },
  { id: "not_accepted", input: { ...ok, parserAccepted: false }, kind: "none" },
  { id: "no_active_post_sale_cadence", input: { ...ok, hasActivePostSaleCadence: false }, kind: "none" }
];
for (const r of rows) {
  const got = decidePostSaleOwnershipTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM coverage + adversarial negatives (gated; skips cleanly). ---
// Clear done-fact losses — must stop the cadence. First case = the exact production turn.
const lost: { text: string; soldModel?: string }[] = [
  { text: "Yeah i sold the bike remember", soldModel: "Low Rider S" },
  { text: "I actually traded it in at another shop last month" },
  { text: "Totaled it back in March, insurance already paid out" }
];
// Must NOT stop: still owns / plan-only / a DIFFERENT bike / idiom / continued engagement.
const keeps: { text: string; soldModel?: string }[] = [
  { text: "thinking about selling it, what would you give me?" },
  { text: "finally sold my old sportster, loving the new bike", soldModel: "Street Glide" },
  { text: "you sold my buddy on getting one too lol" },
  { text: "bike is awesome, thanks again" },
  { text: "when is my first service due?" }
];

let ran = 0;
let safe = 0;
for (const c of lost) {
  const v = await parsePostSaleOwnershipWithLLM({ text: c.text, soldModel: c.soldModel ?? null });
  if (!v) continue;
  ran++;
  assert.equal(v.intent, "no_longer_owns", `"${c.text}" should be no_longer_owns, got ${v.intent}`);
  assert.equal(v.explicitStatement, true, `"${c.text}" is a done fact — explicitStatement must be true`);
}
for (const c of keeps) {
  const v = await parsePostSaleOwnershipWithLLM({ text: c.text, soldModel: c.soldModel ?? null });
  if (!v) continue;
  safe++;
  assert.notEqual(
    v.intent === "no_longer_owns" && v.explicitStatement,
    true,
    `ADVERSARIAL: "${c.text}" must NOT stop the post-sale cadence`
  );
}

console.log(
  ran === 0 && safe === 0
    ? `PASS post-sale ownership eval (source guard + ${rows.length} decision rows; LLM skipped — parser disabled)`
    : `PASS post-sale ownership eval (source guard + ${rows.length} decision rows + ${ran}/${lost.length} loss + ${safe}/${keeps.length} keep cases)`
);
