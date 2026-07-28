/**
 * Vehicle media request eval (2026-06-24; Phase 1 photo-quality rework 2026-07-27).
 *
 * The customer asks to SEE the bikes we've discussed (pics/colors/links). We resolve the bikes they
 * named against the LIVE feed (which carries listing url + photos), and:
 *   - SEND the real dealer photos + links when a bike has a real gallery (>= MIN_REAL_PHOTOS);
 *   - make a salesperson "send customer photos" TASK when a bike has no photos, only a STOCK shot
 *     (< MIN_REAL_PHOTOS — the americanharley feed splits 1-photo=stock vs 4+=real), or the customer
 *     wants MORE than what's posted (Melanie Castro +19518078554, Joe report 2026-07-27).
 * Never texts a lone stock image as the real bike; never fabricates ("bike in the back").
 *
 * Layers: pure decision table (send / send+task / task / none); the reply builder (attaches only a
 * real gallery, links the rest, pluggable closer); the real-photo threshold; the typed parser
 * contract (referenced units + wants-additional); and source guards (both paths, live-only task,
 * dedup). Run: npx tsx scripts/vehicle_media_request_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideVehicleMediaRequestTurn } from "../services/api/src/domain/routeStateReducer.ts";
import {
  toRecommendedUnits,
  buildRecommendedUnitsMediaReply,
  buildSalespersonPhotoAckReply,
  buildSalespersonPhotoTaskSummary,
  unitHasRealPhotos,
  MIN_REAL_PHOTOS
} from "../services/api/src/domain/inventoryRecommender.ts";

// --- 1) Pure decision table. ---
const base = {
  parserAccepted: true,
  wantsMedia: true,
  confidence: 0.9,
  confidenceMin: 0.7,
  wantsAdditionalPhotos: false,
  hasUnits: true,
  hasUnitsWithRealPhotos: true,
  hasUnitsNeedingPhotos: false
};
type Row = { id: string; input: Parameters<typeof decideVehicleMediaRequestTurn>[0]; kind: string };
const rows: Row[] = [
  { id: "no_parse", input: { ...base, parserAccepted: false }, kind: "none" },
  { id: "not_media", input: { ...base, wantsMedia: false }, kind: "none" },
  { id: "low_conf", input: { ...base, confidence: 0.5 }, kind: "none" },
  { id: "no_units", input: { ...base, hasUnits: false }, kind: "none" },
  // Every discussed bike has a real gallery => send the photos.
  { id: "all_real", input: { ...base }, kind: "send_media" },
  { id: "at_floor", input: { ...base, confidence: 0.7 }, kind: "send_media" },
  // Some have a gallery, some are stock/none => send the real ones AND task the rest.
  { id: "mixed", input: { ...base, hasUnitsNeedingPhotos: true }, kind: "send_and_task" },
  // No real gallery anywhere (Melanie Castro: stock shot + no-photo used bikes) => salesperson task.
  { id: "all_stock_or_none", input: { ...base, hasUnitsWithRealPhotos: false, hasUnitsNeedingPhotos: true }, kind: "salesperson_photo_task" },
  // Customer wants MORE than the posted gallery => task even though real photos exist (don't re-send).
  { id: "wants_more_has_gallery", input: { ...base, wantsAdditionalPhotos: true }, kind: "salesperson_photo_task" },
  { id: "wants_more_mixed", input: { ...base, wantsAdditionalPhotos: true, hasUnitsNeedingPhotos: true }, kind: "salesperson_photo_task" }
];
for (const r of rows) {
  assert.equal(decideVehicleMediaRequestTurn(r.input).kind, r.kind, `decide[${r.id}] expected ${r.kind}`);
}

// --- 2) Real-photo threshold: a lone stock shot is NOT a real gallery. ---
assert.equal(MIN_REAL_PHOTOS, 2, "a real gallery needs >= 2 dealer photos (1 = stock in this feed)");
assert.equal(unitHasRealPhotos({ images: ["https://x/a.jpg", "https://x/b.jpg"] } as any), true, "2 jpgs => real gallery");
assert.equal(unitHasRealPhotos({ images: ["https://x/a.jpg"] } as any), false, "1 jpg => stock, not a gallery");
assert.equal(unitHasRealPhotos({ images: [] } as any), false, "no images => not a gallery");
assert.equal(unitHasRealPhotos({ images: ["https://x/a.webp", "https://x/b.webp"] } as any), false, "webp aren't MMS photos");

// --- 3) Reply builder: attach ONLY a real gallery, link the stock/none units, pluggable closer. ---
const units = toRecommendedUnits([
  // real gallery (2 jpgs) => attach a photo
  { year: "2022", model: "Forty-Eight", color: "Vivid Black", stockId: "U121-22", url: "https://d.com/inventory/979150/forty-eight", images: ["https://cdn.x/a.jpg", "https://cdn.x/b.jpg"] } as any,
  // only a single STOCK jpg => NOT attached; linked instead
  { year: "2018", model: "Iron 1200", color: "Vivid Black", stockId: "U127-18", url: "https://d.com/inventory/1018225/iron-1200", images: ["https://cdn.x/stock.jpg"] } as any,
  // no photos, has url => linked
  { year: "2006", model: "Sportster 883 Low", stockId: "U126-06", url: "https://d.com/inventory/1017692/sportster", images: [] } as any,
  // no photo, no url => omitted (never fabricated)
  { year: "2013", model: "1200 Custom", stockId: "U119-13", url: "", images: [] } as any
]);
const built = buildRecommendedUnitsMediaReply({ firstName: "Mel", units })!;
assert.ok(built, "a result is built");
assert.deepEqual(built.mediaUrls, ["https://cdn.x/a.jpg"], "attaches only the real gallery's photo, not the stock shot");
assert.match(built.reply, /2018 Iron 1200 \(Vivid Black\): https:\/\/d\.com\/inventory\/1018225\/iron-1200/, "the stock-image bike is LINKED, not texted as a photo");
assert.match(built.reply, /2006 Sportster 883 Low: https:\/\/d\.com\/inventory\/1017692\/sportster/, "the no-photo bike is linked");
assert.ok(!built.reply.includes("Forty-Eight"), "the real-gallery bike is sent as a photo, not also linked");
assert.ok(!built.reply.includes("1200 Custom"), "a bike with no photo and no url is omitted (never fabricated)");
assert.match(built.reply, /run numbers on one of these\?/, "default closer offers the next step");
// Pluggable closer (task turns replace the CTA with the salesperson line; null omits it).
const withCloser = buildRecommendedUnitsMediaReply({ firstName: "Mel", units, closingCta: "I'll have a salesperson send you more." })!;
assert.match(withCloser.reply, /salesperson send you more\.$/, "closingCta replaces the default CTA");
assert.doesNotMatch(withCloser.reply, /run numbers/, "the default CTA is gone when overridden");
const noCloser = buildRecommendedUnitsMediaReply({ firstName: "Mel", units, closingCta: null })!;
assert.doesNotMatch(noCloser.reply, /run numbers|salesperson/, "closingCta null => no closing line");
// Nothing real to send (no gallery, no url) => null.
assert.equal(
  buildRecommendedUnitsMediaReply({ firstName: "x", units: toRecommendedUnits([{ model: "Nightster", url: "", images: ["https://x/one.jpg"] } as any]) }),
  null,
  "a lone stock shot with no url => nothing to send (=> the caller makes a task)"
);
// MMS cap: at most 3 photos even with many real galleries.
const many = toRecommendedUnits(Array.from({ length: 6 }, (_, i) => ({ model: `M${i}`, images: [`https://cdn.x/${i}a.jpg`, `https://cdn.x/${i}b.jpg`] } as any)));
assert.equal(buildRecommendedUnitsMediaReply({ units: many })!.mediaUrls.length, 3, "MMS photo count is capped");

// --- 4) Salesperson ack + task summary. ---
const photoAck = buildSalespersonPhotoAckReply({ firstName: "Melanie" });
assert.match(photoAck, /Melanie/, "ack greets by name");
assert.match(photoAck, /salesperson/i, "ack hands it to a salesperson");
assert.doesNotMatch(photoAck, /bike in the back|in the back/i, "ack never invents a 'bike in the back'");
assert.doesNotMatch(photoAck, /\b(shortly|soon|today|right (?:back|away)|momentarily|asap|right now)\b/i, "ack makes no reply-time promise");
assert.match(buildSalespersonPhotoAckReply({ firstName: null }), /Happy to help/, "ack degrades gracefully with no name");

const taskSummary = buildSalespersonPhotoTaskSummary({
  units: toRecommendedUnits([{ year: "2006", model: "Sportster 883 Low" } as any, { year: "2018", model: "Iron 1200" } as any]),
  inboundText: "can i see photos of the 2006 sportster? and the iron 1200"
});
assert.match(taskSummary, /^Send customer photos/i, "task label reads 'Send customer photos …' (the flag Joe asked for)");
assert.match(taskSummary, /2006 Sportster 883 Low/, "task names the units for the rep");
assert.match(taskSummary, /2018 Iron 1200/, "task names the second unit");
assert.match(taskSummary, /can i see photos/i, "task carries the customer's ask");
const additionalTask = buildSalespersonPhotoTaskSummary({ units: [], inboundText: "any other pics?", additional: true });
assert.match(additionalTask, /ADDITIONAL\/real photos/, "additional-photos task says the posted photos aren't enough");

// --- 5) Parser contract (referenced units + wants-additional). ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.match(llm, /export async function parseVehicleMediaRequestWithLLM/, "media-request parser exported");
assert.match(llm, /VEHICLE_MEDIA_REQUEST_JSON_SCHEMA/, "strict schema exists");
assert.match(llm, /LLM_VEHICLE_MEDIA_REQUEST_PARSER_ENABLED/, "parser is flag-gated");
assert.match(llm, /wants_additional_photos/, "schema carries the wants-additional-photos signal");
assert.match(llm, /referenced_units/, "schema carries the referenced units");

// --- 6) Source guards: resolution + decision + both paths + live-only task + dedup. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.equal(
  (api.match(/resolveRecommendedUnitsMediaReply\(conv,/g) ?? []).length >= 2,
  true,
  "the media resolver runs in BOTH the live and regenerate paths"
);
// Resolves the named bikes against the LIVE feed (works even when recommendedUnits is empty).
assert.match(api, /for \(const ref of referenced\.slice\(0, 4\)\)/, "the resolver resolves the customer's referenced units");
assert.match(api, /findInventoryMatches\(\{ year: ref\.year/, "referenced units are matched against the live inventory feed");
assert.match(api, /unitHasRealPhotos\(u\)/, "the resolver classifies real gallery vs stock/none");
assert.match(api, /kind === "send_and_task"/, "the resolver handles the mixed send+task arm");
assert.match(api, /buildSalespersonPhotoAckReply\(/, "the resolver returns the salesperson ack on task turns");
// The photo task is LIVE-only (regen never creates tasks) and deduped.
assert.match(api, /if \(scope !== "live"\) return;/, "the salesperson photo task is created LIVE-only");
assert.match(api, /addTodo\(\s*conv,\s*"other",\s*buildSalespersonPhotoTaskSummary\(/, "the resolver creates the send-customer-photos task");
assert.match(api, /alreadyHasPhotoTask/, "a repeated photo ask does not stack duplicate tasks (dedup)");
assert.match(api, /recordRouteOutcome\(scope, "vehicle_media_request_salesperson_photo_task"/, "the photo-task outcome is recorded");
assert.match(api, /recordRouteOutcome\(scope, "vehicle_media_request_send_and_task"/, "the send+task outcome is recorded");

// --- 7) Persist the quoted unit on the finance/pricing estimate arm (both paths) — unchanged. ---
assert.match(api, /function persistDiscussedUnit\(conv: any, item: InventoryFeedItem/, "discussed-unit persist helper exists");
const persistCalls = (api.match(/persistDiscussedUnit\(conv, item\)/g) ?? []).length;
assert.ok(persistCalls >= 3, `the estimate arms must persist the quoted unit in both paths (found ${persistCalls})`);

console.log("PASS vehicle media request eval (send / send+task / task decision + real-photo threshold + referenced-unit resolution + parser + both paths)");
