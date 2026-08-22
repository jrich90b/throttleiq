/**
 * Backfill: un-hide threads a campaign blast is STILL burying, where a web lead has since arrived.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE FIX. `domain/campaignThreadRelease.ts` releases a thread when
 * a NEW web lead lands — it is forward-only. The leads that already landed are still hidden, and
 * always will be, because their ADF has been and gone. A class fix is not an instance fix.
 *
 * Measured 2026-08-22: 151 threads carry `campaignThread.status: "campaign"` from a single
 * "250 Years Of Freedom SMS" send to All contacts on 07-16. **Two** have since received a web lead
 * and are the repair set:
 *   • `+17165072289` Matt Weiser — `Trade Accelerator - Trade In` ref 11822, 2026-08-21 14:55,
 *     a 2007 FXDWG Dyna Wide Glide trade, with an unsent draft composed 6 seconds later. This is
 *     the one Joe could not find: "That lead was buried in campaigns which is confusing to find."
 *   • `+17164182738` — 2026-08-10.
 *
 * WHAT: for each conversation, find the newest inbound `sendgrid_adf` message and hand it to the
 * SAME resolver the live path uses. One decision function, so the repair cannot drift from the fix.
 * Threads with no post-blast lead are untouched, and the repair is idempotent (a released thread is
 * `linked_open`, which the resolver declines to touch).
 *
 * SAFETY: dry-run by default; `--apply` writes. Quiesce the API first (pm2 stop) and back up
 * conversations.json — the running service holds the store in memory and would clobber an in-place
 * edit — then restart so it reloads.
 *
 *   SELF-TEST: npx tsx scripts/backfill_campaign_thread_release.ts --self-test
 *   DRY RUN:   CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_campaign_thread_release.ts
 *   APPLY:     CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_campaign_thread_release.ts --apply
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { planBackfill, applyBackfill, renderBackfillReport } from "../services/api/src/domain/backfillRunner.ts";
import { resolveCampaignThreadOnNewLead } from "../services/api/src/domain/campaignThreadRelease.ts";

/** The newest inbound ADF on a conversation, or null. Same signal the live path keys on. */
function newestWebLeadAt(conv: any): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const m of conv?.messages ?? []) {
    if (m?.direction !== "in") continue;
    if (String(m?.provider ?? "").toLowerCase() !== "sendgrid_adf") continue;
    const raw = String(m?.at ?? m?.timestamp ?? "").trim();
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = raw;
  }
  return best;
}

function correct(conv: any): { summary: string; mutate: () => void } | null {
  const leadAt = newestWebLeadAt(conv);
  if (!leadAt) return null;
  const decision = resolveCampaignThreadOnNewLead({
    campaignThread: conv?.campaignThread ?? null,
    isNewWebLead: true,
    leadReceivedAtIso: leadAt
  });
  if (!decision.changed) return null;
  const name = String(conv?.lead?.name ?? conv?.latestLead?.name ?? "").trim();
  const source = String(conv?.latestLead?.source ?? conv?.lead?.source ?? "").trim();
  return {
    summary:
      `release from "${conv?.campaignThread?.campaignName ?? "campaign"}" → linked_open` +
      `${name ? ` (${name}` : " ("}${source ? `, ${source}` : ""}) — web lead ${leadAt}`,
    mutate: () => {
      conv.campaignThread = decision.campaignThread;
      conv.updatedAt = new Date().toISOString();
    }
  };
}

// ---------------------------------------------------------------------------
// SELF-TEST — executes the predicate against synthetic records, so this script cannot rot into a
// no-op unnoticed (SKILL trap 3: `tsc` does not cover scripts/, and a source-text assertion cannot
// prove a script still runs). Clock-safe: fixed literals only.
// ---------------------------------------------------------------------------
if (process.argv.includes("--self-test")) {
  const blast = {
    status: "campaign",
    campaignName: "250 Years Of Freedom SMS",
    firstSentAt: "2026-07-16T22:36:41.089Z",
    lastSentAt: "2026-07-16T22:36:41.089Z"
  };
  const buried = {
    id: "+17165072289",
    lead: { name: "Matt Weiser" },
    latestLead: { source: "Trade Accelerator - Trade In" },
    campaignThread: { ...blast },
    messages: [
      { direction: "in", provider: "sendgrid_adf", at: "2026-04-21T14:52:55.000Z" },
      { direction: "out", provider: "twilio", at: "2026-07-16T22:36:41.089Z" },
      { direction: "in", provider: "sendgrid_adf", at: "2026-08-21T14:55:32.000Z" }
    ]
  };
  const change = correct(buried);
  assert.ok(change, "the real buried thread must be proposed for release");
  assert.match(change!.summary, /Matt Weiser/, "the summary names who, so the report is actionable");
  assert.match(change!.summary, /Trade Accelerator/, "…and what kind of lead it was");
  change!.mutate();
  assert.equal(buried.campaignThread.status, "linked_open", "applying releases it");
  assert.equal(buried.campaignThread.campaignName, "250 Years Of Freedom SMS", "campaign attribution survives the repair");

  assert.equal(correct(buried), null, "IDEMPOTENT — a second pass proposes nothing");

  // A blast recipient who never came back stays hidden; that is the whole point of the tag.
  assert.equal(
    correct({ id: "+1555", campaignThread: { ...blast }, messages: [{ direction: "in", provider: "sendgrid_adf", at: "2026-04-01T00:00:00.000Z" }] }),
    null,
    "a lead PREDATING the blast must not release the thread"
  );
  assert.equal(
    correct({ id: "+1556", campaignThread: { ...blast }, messages: [{ direction: "in", provider: "twilio", at: "2026-08-01T00:00:00.000Z" }] }),
    null,
    "a plain SMS reply is not this repair's business"
  );
  assert.equal(correct({ id: "+1557", messages: [] }), null, "an untagged thread is untouched");
  assert.equal(
    correct({ id: "+1558", campaignThread: { ...blast, status: "passed" }, messages: [{ direction: "in", provider: "sendgrid_adf", at: "2026-08-21T00:00:00.000Z" }] }),
    null,
    "a thread a human already routed to a department is NOT walked back"
  );
  console.log("backfill_campaign_thread_release --self-test: PASS");
  process.exit(0);
}

const dbPath = String(process.env.CONVERSATIONS_DB_PATH ?? "").trim();
if (!dbPath) {
  console.error("Set CONVERSATIONS_DB_PATH to the conversations.json to repair (dry-run unless --apply).");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const conversations: any[] = Array.isArray(raw) ? raw : raw?.conversations ?? [];
const plan = planBackfill({ conversations, correct });
const apply = process.argv.includes("--apply");
if (apply) {
  const applied = applyBackfill(plan);
  fs.writeFileSync(dbPath, JSON.stringify(raw, null, 2));
  console.log(renderBackfillReport(plan, { title: "campaign-thread release", applied: true }));
  console.log(`wrote ${applied} change(s) to ${dbPath}`);
} else {
  console.log(renderBackfillReport(plan, { title: "campaign-thread release", applied: false }));
}
