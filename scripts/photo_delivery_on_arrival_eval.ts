/**
 * Photo-delivery-on-arrival eval (Phase 3, DARK — Joe 2026-07-28).
 *
 * When a photo request couldn't be fulfilled (no real gallery => a "send customer photos" task), the
 * discussed units are recorded on conv.pendingPhotoDelivery with their image-set fingerprint AT
 * REQUEST TIME. A background pass watches those units; when REAL dealer photos land (the fingerprint
 * changes AND the unit now has a real gallery), it auto-DELIVERS them as a suggest-mode DRAFT and
 * CLOSES the task. Ships DARK behind PHOTO_DELIVERY_ON_ARRIVAL_ENABLED (default off) => merging
 * changes nothing; nothing is recorded and the pass no-ops.
 *
 * Pins: the flag helper, the worker-task registration, the conv field, and the wiring invariants
 * (record on task-create behind the flag / not for wants-additional; the pass fires only on a genuine
 * photo UPDATE that is now a real gallery; DRAFT-only; closes the task; clears the pending record;
 * skips closed/opted-out/human-owned). In ci:eval.
 * Run: npx tsx scripts/photo_delivery_on_arrival_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { photoDeliveryOnArrivalEnabled } from "../services/api/src/domain/inventoryRecommender.ts";
import { WORKER_TICK_TASKS, isWorkerTickTask } from "../services/api/src/domain/workerTasks.ts";

// --- 1) Flag helper (dark by default). ---
{
  const prev = process.env.PHOTO_DELIVERY_ON_ARRIVAL_ENABLED;
  delete process.env.PHOTO_DELIVERY_ON_ARRIVAL_ENABLED;
  assert.equal(photoDeliveryOnArrivalEnabled(), false, "unset => off (dark by default)");
  process.env.PHOTO_DELIVERY_ON_ARRIVAL_ENABLED = "0";
  assert.equal(photoDeliveryOnArrivalEnabled(), false, "0 => off");
  process.env.PHOTO_DELIVERY_ON_ARRIVAL_ENABLED = "1";
  assert.equal(photoDeliveryOnArrivalEnabled(), true, "1 => on");
  if (prev === undefined) delete process.env.PHOTO_DELIVERY_ON_ARRIVAL_ENABLED; else process.env.PHOTO_DELIVERY_ON_ARRIVAL_ENABLED = prev;
}

// --- 2) Worker task registered. ---
assert.ok(WORKER_TICK_TASKS.includes("photo-delivery" as any), "photo-delivery is a registered worker tick task");
assert.equal(isWorkerTickTask("photo-delivery"), true, "photo-delivery passes the worker-task guard");

// --- 3) The conversation field exists. ---
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
assert.match(store, /pendingPhotoDelivery\?: \{/, "Conversation carries pendingPhotoDelivery");
assert.match(store, /requestedImageHash: string/, "each watched unit stores its request-time image fingerprint");

// --- 4) Wiring invariants (source guards). ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
// Recorded on task-create ONLY behind the flag and NOT for a wants-additional ask.
assert.match(api, /if \(photoDeliveryOnArrivalEnabled\(\) && !parse\.wantsAdditionalPhotos\) \{/, "records the pending delivery only when the flag is on and it's not a 'wants additional' ask");
assert.match(api, /conv\.pendingPhotoDelivery = \{ units: watchUnits, requestedAt:/, "stores the watched units + timestamp");
assert.match(api, /requestedImageHash: imageSetHash\(u\.images\)/, "captures the image fingerprint at request time");
// The pass is dispatched + interval-scheduled.
assert.match(api, /"photo-delivery": \(\) => processPendingPhotoDeliveries\(\)/, "the pass is in the worker dispatch map");
assert.match(api, /runBackgroundTask\("photo-delivery", processPendingPhotoDeliveries\)/, "the pass runs on the in-process interval too");
// The pass itself: flag-gated, fires only on a genuine update that is now a real gallery, DRAFT-only,
// closes the task, clears the record, and skips closed/opted-out/human-owned.
assert.match(api, /async function processPendingPhotoDeliveries\(\)/, "the background pass exists");
assert.match(api, /if \(!photoDeliveryOnArrivalEnabled\(\)\) return;/, "the pass no-ops when the flag is off");
assert.match(api, /imageSetHash\(mapped\.images\) !== wu\.requestedImageHash && unitHasRealPhotos\(mapped\)/, "delivers ONLY on a genuine photo update that is now a real gallery");
assert.match(api, /appendOutbound\(conv, "salesperson", to, built\.reply, "draft_ai"/, "delivery is a suggest-mode DRAFT, never an auto-send");
assert.match(api, /if \(!built \|\| !built\.mediaUrls\.length\) continue;/, "only delivers when there are real photos to attach");
assert.match(api, /markTodoDone\(conv\.id, t\.id\)/, "closes the open 'send customer photos' task");
assert.match(api, /conv\.pendingPhotoDelivery = undefined;/, "clears the pending record after delivery");
assert.match(api, /if \(conv\.mode === "human"\) continue;/, "skips human-owned threads (staff own it)");
assert.match(api, /conv\.status === "closed" \|\| \(phone && isSuppressed\(phone\)\)/, "skips closed / opted-out conversations");
assert.match(api, /recordRouteOutcome\("live", "photo_delivery_on_arrival"/, "records the delivery outcome");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(String(pkg.scripts?.["ci:eval"] ?? "").includes("photo_delivery_on_arrival:eval"), "photo_delivery_on_arrival:eval is wired into ci:eval");

console.log("PASS photo-delivery-on-arrival eval (flag + worker task + conv field + record/pass wiring: update-only, draft-only, closes task, dark)");
