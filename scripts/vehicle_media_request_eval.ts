/**
 * Vehicle media request eval (2026-06-24).
 *
 * After the recommender suggests units, the customer asks to SEE them (pics/colors/links). The agent
 * used to punt ("I don't have the links yet") despite the feed carrying each unit's listing url + color
 * (s R Gurajala +17167506588). This pins: the persisted units feed a DETERMINISTIC links reply (exact
 * URLs — never LLM-composed), gated by a parser-first decision, wired in BOTH paths.
 *
 * Layers: pure decision table; deterministic reply builder (exact urls, no-url => null); the typed
 * parser contract; and a source guard (recommender persists units; both paths call the resolver).
 *
 * Run: npx tsx scripts/vehicle_media_request_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideVehicleMediaRequestTurn } from "../services/api/src/domain/routeStateReducer.ts";
import {
  toRecommendedUnits,
  buildRecommendedUnitsMediaReply
} from "../services/api/src/domain/inventoryRecommender.ts";

// --- 1) Pure decision table. ---
const base = { parserAccepted: true, wantsMedia: true, confidence: 0.9, confidenceMin: 0.7, hasUnitsWithUrl: true };
type Row = { id: string; input: Parameters<typeof decideVehicleMediaRequestTurn>[0]; kind: string };
const rows: Row[] = [
  { id: "no_parse", input: { ...base, parserAccepted: false }, kind: "none" },
  { id: "not_media", input: { ...base, wantsMedia: false }, kind: "none" },
  { id: "low_conf", input: { ...base, confidence: 0.5 }, kind: "none" },
  { id: "no_units_with_url", input: { ...base, hasUnitsWithUrl: false }, kind: "none" },
  { id: "send", input: { ...base }, kind: "send_media" },
  { id: "at_floor", input: { ...base, confidence: 0.7 }, kind: "send_media" }
];
for (const r of rows) {
  assert.equal(decideVehicleMediaRequestTurn(r.input).kind, r.kind, `decide[${r.id}] expected ${r.kind}`);
}
// Fail-safe: never fire without real links to send (that's what prevents a fabricated/punt reply).
assert.equal(decideVehicleMediaRequestTurn({ ...base, hasUnitsWithUrl: false }).kind, "none");

// --- 2) Deterministic reply builder (exact URLs). ---
const units = toRecommendedUnits([
  { year: "2026", model: "Nightster", color: "Vivid Black", price: 10299, stockId: "X4-26", url: "https://d.com/inventory/995742/nightster" } as any,
  { year: "2022", model: "Forty-Eight", color: "Vivid Black", price: 8995, stockId: "U121-22", url: "https://d.com/inventory/979150/forty-eight" } as any,
  { year: "2013", model: "1200 Custom", color: "Vivid Black", price: 6995, stockId: "U119-13", url: "" } as any // no url
]);
assert.equal(units.length, 3, "toRecommendedUnits maps each match");
const reply = buildRecommendedUnitsMediaReply({ firstName: "s R", units })!;
assert.ok(reply, "a reply is built when units have urls");
assert.match(reply, /2026 Nightster \(Vivid Black\): https:\/\/d\.com\/inventory\/995742\/nightster/, "exact Nightster url + color");
assert.match(reply, /2022 Forty-Eight \(Vivid Black\): https:\/\/d\.com\/inventory\/979150\/forty-eight/, "exact Forty-Eight url");
assert.ok(!reply.includes("1200 Custom"), "a unit with no url is omitted (never a fabricated link)");
assert.match(reply, /run numbers on one of these\?/, "offers the next step");
// No units with a url => null (caller falls back to commit-to-follow-up, not a punt).
assert.equal(
  buildRecommendedUnitsMediaReply({ firstName: "x", units: toRecommendedUnits([{ model: "Nightster", url: "" } as any]) }),
  null,
  "no usable links => null"
);

// --- 3) Parser contract. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.match(llm, /export async function parseVehicleMediaRequestWithLLM/, "media-request parser exported");
assert.match(llm, /VEHICLE_MEDIA_REQUEST_JSON_SCHEMA/, "strict schema exists");
assert.match(llm, /LLM_VEHICLE_MEDIA_REQUEST_PARSER_ENABLED/, "parser is flag-gated");

// --- 4) Source guard: persistence + both paths. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /conv\.recommendedUnits = toRecommendedUnits\(matches\)/, "recommender persists the suggested units");
assert.equal(
  (api.match(/resolveRecommendedUnitsMediaReply\(conv,/g) ?? []).length >= 2,
  true,
  "the media resolver runs in BOTH the live and regenerate paths"
);
assert.match(api, /recordRouteOutcome\((?:scope|"live"|"regen"), "vehicle_media_request"/, "route outcome recorded");

console.log("PASS vehicle media request eval (decision + deterministic links + parser + both paths)");
