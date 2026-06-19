/**
 * ADF intake department interest eval.
 *
 * On an initial web (ADF) lead the Inquiry field IS the customer's stated request, so naming an
 * apparel/parts/service item there is a department request even with NO action verb. The SMS-tuned
 * action-signal gates (catalog*Intent / *IntentFromText in sendgridInbound, and explicit*Request in
 * the conversation-state parser) correctly suppress incidental mid-thread mentions, but they wrongly
 * dropped a terse ADF item — Kelly Gantzer's "small womens black leather vest" fell through to
 * inventory_interest and got a bogus "not in stock" reply + an inventory watch on the
 * "Harley-Davidson Full Line" placeholder vehicle. This adds a focused, parser-first override
 * (parseAdfDepartmentInterestWithLLM -> decideAdfDepartmentRoute) that runs ONLY on initial ADF leads
 * the existing signals missed, and turns a confident apparel/parts/service verdict into a department
 * route (skipping the watch + "not in stock" path, which the apparel/parts/service buckets already do).
 *
 * Layers: (1) source guard (parser + flag + strict schema; centralized pure decision + routerV2
 * re-export; isGenericLeadModel treats a "...full line" placeholder as generic; wired into the ADF
 * classification as the highest-precedence department branch, gated to initial ADF + missed-signal +
 * a catalog/placeholder cue), (2) pure decision table (route ONLY on accepted + confident +
 * apparel/parts/service; vehicle / none / low-confidence / no-parser => none — fail toward the normal
 * bike flow), (3) LLM coverage (terse verb-less department items incl. the vest replay fixture, plus
 * ADVERSARIAL real-bike inquiries that must NOT route to a department).
 *
 * Run gated: LLM_ENABLED=1 LLM_ADF_DEPARTMENT_PARSER_ENABLED=1 npx tsx scripts/adf_department_interest_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseAdfDepartmentInterestWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideAdfDepartmentRoute } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Source guard. ---
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");
const routerV2 = fs.readFileSync("services/api/src/domain/routerV2.ts", "utf8");

assert.ok(/export async function parseAdfDepartmentInterestWithLLM/.test(llm), "parser must be exported");
assert.ok(/ADF_DEPARTMENT_INTEREST_PARSER_JSON_SCHEMA/.test(llm), "strict JSON schema const must exist");
assert.ok(/LLM_ADF_DEPARTMENT_PARSER_ENABLED/.test(llm), "parser must be behind an enable flag");
assert.ok(/export function decideAdfDepartmentRoute/.test(reducer), "decision must be centralized in routeStateReducer");
assert.ok(/decideAdfDepartmentRoute/.test(routerV2), "decision must be re-exported via routerV2");
// The placeholder "Full Line" vehicle must read as generic so we never build a watch on it.
assert.ok(/full line\(up\)\?\$/.test(sendgrid), "isGenericLeadModel must treat a '...full line' placeholder as generic");
// Wired into the ADF classification: parser called + decision applied + override branches present.
assert.ok(/await parseAdfDepartmentInterestWithLLM\(/.test(sendgrid), "parser must be called in ADF intake");
assert.ok(/adfDepartmentRoute = decideAdfDepartmentRoute\(/.test(sendgrid), "decision must be applied in ADF intake");
assert.ok(/adfDepartmentRoute\.kind === "apparel"/.test(sendgrid), "apparel override branch must exist");
assert.ok(/adfDepartmentRoute\.kind === "parts"/.test(sendgrid), "parts override branch must exist");
assert.ok(/adfDepartmentRoute\.kind === "service"/.test(sendgrid), "service override branch must exist");
// Gated so it never runs on a clean bike lead the existing signals already handled.
assert.ok(/isInitialAdf && !!effectiveInquiry && !adfDepartmentExistingSignal && adfDepartmentCue/.test(sendgrid),
  "parser must be gated to initial ADF + missed-signal + a catalog/placeholder cue");

// --- 2) Decision-table coverage (pure). ---
type Row = { id: string; input: Parameters<typeof decideAdfDepartmentRoute>[0]; kind: "apparel" | "parts" | "service" | "none" };
const base = { parserAccepted: true, confidence: 0.9, confidenceMin: 0.7 };
const rows: Row[] = [
  { id: "apparel_confident", input: { ...base, department: "apparel" }, kind: "apparel" },
  { id: "parts_confident", input: { ...base, department: "parts" }, kind: "parts" },
  { id: "service_confident", input: { ...base, department: "service" }, kind: "service" },
  { id: "at_floor", input: { ...base, department: "apparel", confidence: 0.7 }, kind: "apparel" },
  { id: "below_floor", input: { ...base, department: "apparel", confidence: 0.69 }, kind: "none" },
  { id: "vehicle_is_none", input: { ...base, department: "vehicle" }, kind: "none" },
  { id: "none_is_none", input: { ...base, department: "none" }, kind: "none" },
  { id: "not_accepted", input: { ...base, department: "apparel", parserAccepted: false }, kind: "none" },
  { id: "null_department", input: { ...base, department: null }, kind: "none" }
];
for (const r of rows) {
  const got = decideAdfDepartmentRoute(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM coverage + adversarial negatives (gated; skips cleanly). ---
const confidenceMin = 0.7;
// Terse, verb-less ADF inquiries that ARE department requests. The vest is the production replay fixture.
const departmentCases: { inquiry: string; vehicle?: string; want: "apparel" | "parts" | "service" }[] = [
  { inquiry: "small womens black leather vest", vehicle: "Harley-Davidson Full Line", want: "apparel" },
  { inquiry: "looking for a riding jacket, size XL", want: "apparel" },
  { inquiry: "need brake pads and a battery for my Street Glide", want: "parts" },
  { inquiry: "oil change and 5k service", want: "service" }
];
// Real bike shoppers — must NOT route to a department (decision => none; the normal vehicle flow runs).
const vehicleCases: { inquiry: string; vehicle?: string }[] = [
  { inquiry: "interested in a 2024 Street Glide", vehicle: "Street Glide" },
  { inquiry: "do you have any Road Glides in stock in black", vehicle: "Road Glide" }
];

let ran = 0;
let safe = 0;
for (const c of departmentCases) {
  const v = await parseAdfDepartmentInterestWithLLM({ inquiry: c.inquiry, vehicle: c.vehicle ?? null });
  if (!v) continue;
  ran++;
  const kind = decideAdfDepartmentRoute({
    parserAccepted: true,
    department: v.department,
    confidence: v.confidence,
    confidenceMin
  }).kind;
  assert.equal(kind, c.want, `"${c.inquiry}" should route to ${c.want}, got ${kind} (dept=${v.department}, conf=${v.confidence})`);
}
for (const c of vehicleCases) {
  const v = await parseAdfDepartmentInterestWithLLM({ inquiry: c.inquiry, vehicle: c.vehicle ?? null });
  if (!v) continue;
  safe++;
  const kind = decideAdfDepartmentRoute({
    parserAccepted: true,
    department: v.department,
    confidence: v.confidence,
    confidenceMin
  }).kind;
  assert.equal(kind, "none", `ADVERSARIAL: "${c.inquiry}" must NOT route to a department, got ${kind} (dept=${v.department})`);
}

console.log(
  ran === 0 && safe === 0
    ? `PASS adf department interest eval (source guard + ${rows.length} decision rows; LLM skipped — parser disabled)`
    : `PASS adf department interest eval (source guard + ${rows.length} decision rows + ${ran}/${departmentCases.length} department + ${safe}/${vehicleCases.length} vehicle-safe cases)`
);
