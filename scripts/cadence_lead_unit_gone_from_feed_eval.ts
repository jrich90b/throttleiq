/**
 * cadence_lead_unit_gone_from_feed:eval (universal, deterministic) — runs inside ci:eval.
 *
 * Pins the operator report on Steven Osipovitch (+15854653751, 2026-07-25): "Cadence follow up
 * mentioned a bike we no longer have in stock." A later-step cadence touch pitched
 * "that 2016 Freewheeler would qualify for the used bike financing we have at rates starting
 * 7.29% APR with $0 down" for a unit the store no longer had.
 *
 * The value gate ALREADY suppresses a gone unit (Joe ruling 2026-07-28, Jason Roorda) — but only
 * via `leadUnitUnavailableForValueGate`, which needs a stockId/VIN on the lead to look up in the
 * hold/sold ledgers. Steven's Trade Accelerator ADF carried only "2016 / Trike Freewheeler", so
 * that read returned false and the offer fired. This eval pins the label-only half of the read.
 *
 * Everything here asserts BEHAVIOR (call the function, check the result) or ORDERING via indexOf,
 * per the eval source-pin ratchet — no source-text regexes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decideLeadModelGoneFromFeed } from "../services/api/src/domain/cadenceInventoryGuard.ts";

// (a) The production case: a specific model, a healthy feed, and nothing matching on the lot.
assert.equal(
  decideLeadModelGoneFromFeed({ hasSpecificModel: true, feedHealthy: true, modelInStock: false }),
  true,
  "Steven Osipovitch: a specific lead model that a healthy feed does not carry is GONE — do not pitch its numbers"
);

// (b) Still on the lot => unchanged behavior, the touch goes out.
assert.equal(
  decideLeadModelGoneFromFeed({ hasSpecificModel: true, feedHealthy: true, modelInStock: true }),
  false,
  "a model still in stock is not gone"
);

// (c) FAIL DIRECTION — the one that matters. An unhealthy/empty feed (no URL, fetch failure,
// timeout) is NOT evidence the bike is gone. A feed outage must never silence the cadence.
assert.equal(
  decideLeadModelGoneFromFeed({ hasSpecificModel: true, feedHealthy: false, modelInStock: false }),
  false,
  "an empty/unavailable inventory feed must NEVER be read as 'the bike is gone' (outage => send)"
);
assert.equal(
  decideLeadModelGoneFromFeed({ hasSpecificModel: false, feedHealthy: true, modelInStock: false }),
  false,
  "no specific lead model => nothing to call gone"
);
assert.equal(
  decideLeadModelGoneFromFeed({ hasSpecificModel: false, feedHealthy: false, modelInStock: false }),
  false,
  "no model and no feed => send, unchanged"
);

// (d) The decision is pure AND is genuinely a conjunction: exactly one of the eight input
// combinations may suppress. This is what stops a future edit loosening it into "feed said no".
const flags = [true, false];
let suppressing = 0;
for (const hasSpecificModel of flags) {
  for (const feedHealthy of flags) {
    for (const modelInStock of flags) {
      if (decideLeadModelGoneFromFeed({ hasSpecificModel, feedHealthy, modelInStock })) suppressing += 1;
    }
  }
}
assert.equal(suppressing, 1, "exactly one input combination may suppress: specific model + healthy feed + not in stock");

// (e) WIRING (ordering, not source text): the value gate's shared read must consult the label-only
// helper, and it must still run in BOTH paths — the live tick and the regenerate twin — so live and
// regen cannot drift (route-parity law).
const idx = readFileSync("services/api/src/index.ts", "utf8");
const guardAt = idx.indexOf("async function leadUnitUnavailableForValueGate");
const labelReadAt = idx.indexOf("leadModelGoneFromInventoryFeed(conv)", guardAt);
const guardEndAt = idx.indexOf("\n}\n", guardAt);
assert.ok(guardAt > -1, "leadUnitUnavailableForValueGate must still exist — it is the value gate's shared unavailability read");
assert.ok(
  labelReadAt > guardAt && labelReadAt < guardEndAt,
  "the label-only feed read must be consulted INSIDE leadUnitUnavailableForValueGate, not bolted onto one call site"
);

const gateFeeds = idx.split("leadUnitUnavailable: await leadUnitUnavailableForValueGate").length - 1;
assert.equal(gateFeeds, 2, "both cadence paths (live tick + regenerate) must feed the value gate the same unavailability read");

// (f) The label-only read lives in the shared domain module, so both paths get it by construction.
const guard = readFileSync("services/api/src/domain/cadenceInventoryGuard.ts", "utf8");
assert.ok(
  guard.includes("export async function leadModelGoneFromInventoryFeed"),
  "the feed read belongs in cadenceInventoryGuard alongside the sibling watch-offer guard"
);
assert.ok(
  guard.includes("hasInventoryForModelYear"),
  "it must reuse the SAME in-stock definition as the watch-offer guard so the two reads cannot drift"
);

console.log(
  "PASS cadence_lead_unit_gone_from_feed eval — a cadence value touch is suppressed when the lead's own model is absent from a HEALTHY inventory feed (+15854653751), an empty feed never counts as gone, and both paths share one read"
);
