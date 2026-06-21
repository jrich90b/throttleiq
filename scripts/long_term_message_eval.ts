/**
 * long_term_message:eval (universal, deterministic) — runs inside ci:eval.
 *
 * Pins the shared long-term-timeline cadence message (`buildLongTermTimelineMessage`) now that
 * the live (orchestrator) and ADF/email (sendgridInbound) paths both call it instead of keeping
 * copy-pasted twins that had drifted (the sendgrid twin still said "reach out"). Locks the
 * de-corporatized canonical so neither path can regress the voice or re-introduce the tell.
 */
import assert from "node:assert/strict";

import { buildLongTermTimelineMessage } from "../services/api/src/domain/longTermMessage.ts";
import { findComputerLikePhrases } from "../services/api/src/domain/voiceBannedPhrases.ts";

// Interpolates the timeframe.
const msg = buildLongTermTimelineMessage("4-6 Months", true);
assert.ok(msg.includes("4-6 Months timeline"), `expected the timeframe to be interpolated: ${msg}`);

// De-corporatized: the charter-approved "text me", never "reach out".
assert.match(msg, /Just text me when the time is right\./, `expected the de-corped "text me" closer: ${msg}`);
assert.doesNotMatch(msg, /reach out/i, `must not re-introduce the "reach out" tell: ${msg}`);

// Clean against the computer-like denylist.
const hits = findComputerLikePhrases(msg);
assert.equal(hits.length, 0, `long-term message tripped the banned-phrase denylist: ${hits.join(", ")}`);

// hasLicense does not change the copy (both originals returned the same string either way).
assert.equal(
  buildLongTermTimelineMessage("4-6 Months", true),
  buildLongTermTimelineMessage("4-6 Months", false),
  "long-term message copy must be identical regardless of hasLicense"
);

// Missing timeframe falls back gracefully.
assert.ok(buildLongTermTimelineMessage().includes("a future timeline"), "missing timeframe should read 'a future timeline'");

console.log("long_term_message_eval passed");
