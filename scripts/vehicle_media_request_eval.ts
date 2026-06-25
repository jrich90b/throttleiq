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
// Fail-safe: never fire without something real to send.
assert.equal(decideVehicleMediaRequestTurn({ ...base, hasUnitsWithUrl: false }).kind, "none");

// --- 2) Deterministic reply: PREFER photos (MMS), link the rest, exact URLs only. ---
const units = toRecommendedUnits([
  // has a jpg photo => attach it (not the link)
  { year: "2022", model: "Forty-Eight", color: "Vivid Black", stockId: "U121-22", url: "https://d.com/inventory/979150/forty-eight", images: ["https://cdn.x/a.jpg", "https://cdn.x/b.jpg"] } as any,
  // only a webp (MMS-unfriendly) => fall back to its link
  { year: "2026", model: "Nightster", color: "Vivid Black", stockId: "X4-26", url: "https://d.com/inventory/995742/nightster", images: ["https://cdn.x/c.webp"] } as any,
  // no photo, no url => omitted entirely (never fabricated)
  { year: "2013", model: "1200 Custom", color: "Vivid Black", stockId: "U119-13", url: "", images: [] } as any
]);
assert.equal(units.length, 3, "toRecommendedUnits maps each match (incl. images)");
const built = buildRecommendedUnitsMediaReply({ firstName: "s R", units })!;
assert.ok(built, "a result is built");
assert.deepEqual(built.mediaUrls, ["https://cdn.x/a.jpg"], "attaches the jpg photo (one per unit), skips webp");
assert.match(built.reply, /2026 Nightster \(Vivid Black\): https:\/\/d\.com\/inventory\/995742\/nightster/, "webp-only unit falls back to its exact link");
assert.ok(!built.reply.includes("Forty-Eight"), "the photographed unit is sent as a photo, not also linked");
assert.ok(!built.reply.includes("1200 Custom"), "a unit with no photo and no url is omitted (never fabricated)");
assert.match(built.reply, /run numbers on one of these\?/, "offers the next step");
// Photos attached but no links needed => still a valid reply (the MMS carries the content).
const photoOnly = buildRecommendedUnitsMediaReply({
  firstName: "x",
  units: toRecommendedUnits([{ model: "Forty-Eight", url: "", images: ["https://cdn.x/a.jpg"] } as any])
})!;
assert.deepEqual(photoOnly.mediaUrls, ["https://cdn.x/a.jpg"]);
assert.ok(!/•/.test(photoOnly.reply), "no link lines when the photo carries it");
// Nothing real to send (no photo, no url) => null.
assert.equal(
  buildRecommendedUnitsMediaReply({ firstName: "x", units: toRecommendedUnits([{ model: "Nightster", url: "", images: ["x.webp"] } as any]) }),
  null,
  "no usable photo and no url => null"
);
// MMS cap: at most 3 photos even with many units.
const many = toRecommendedUnits(Array.from({ length: 6 }, (_, i) => ({ model: `M${i}`, images: [`https://cdn.x/${i}.jpg`] } as any)));
assert.equal(buildRecommendedUnitsMediaReply({ units: many })!.mediaUrls.length, 3, "MMS photo count is capped");

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
