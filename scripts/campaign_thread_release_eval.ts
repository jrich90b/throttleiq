/**
 * Campaign-thread release eval — a blast tag must not hide a brand-new web lead.
 *
 * THE MISS THIS GUARDS (Joe, 2026-08-22, verbatim): *"That lead was buried in campaigns which is
 * confusing to find."* Matt Weiser `+17165072289`. A `Trade Accelerator - Trade In` lead (ref 11822,
 * 2007 FXDWG Dyna Wide Glide) arrived 2026-08-21 14:55 onto a thread that the "250 Years Of Freedom
 * SMS" blast had tagged `status: "campaign"` on 2026-07-16 — so the console's working Inbox skipped
 * it (`page.tsx:7893`) and the lead only appeared under Campaigns. A draft was composed 6 seconds
 * after the lead landed and was never sent.
 *
 * The cause is one line in `hasInboundCampaignReplyAfter` (index.ts): `if (provider ===
 * "sendgrid_adf") continue;`. That is CORRECT for its own question — an ADF is not a reply to your
 * campaign text — but it was the only gate on visibility, so the strongest evidence a thread is
 * alive could not free it. The fix adds a SECOND predicate and leaves the first untouched; this eval
 * pins both halves of that.
 *
 * Measured 2026-08-22: 151 threads carry `status: "campaign"` (all from that one send to All
 * contacts); 2 have since received a new web lead. Exposure 151, realized harm 2.
 *
 * Clock-safe: every timestamp is a fixed literal; nothing reads the wall clock.
 *
 * Run: npx tsx scripts/campaign_thread_release_eval.ts
 */
import assert from "node:assert/strict";

const { resolveCampaignThreadOnNewLead } = await import("../services/api/src/domain/campaignThreadRelease.ts");

const BLAST = {
  status: "campaign",
  campaignId: "camp_8d52e4a1c92bb_1784241267977",
  campaignName: "250 Years Of Freedom SMS",
  listId: "all",
  listName: "All contacts",
  firstSentAt: "2026-07-16T22:36:41.089Z",
  lastSentAt: "2026-07-16T22:36:41.089Z"
};
const LEAD_AT = "2026-08-21T14:55:32.000Z"; // Matt Weiser's real ADF timestamp

// ---------------------------------------------------------------------------
// 1. THE REAL CASE — it must release.
// ---------------------------------------------------------------------------
const released = resolveCampaignThreadOnNewLead({
  campaignThread: BLAST,
  isNewWebLead: true,
  leadReceivedAtIso: LEAD_AT
});
assert.equal(released.changed, true, "a new web lead after the blast must release the thread");
assert.equal(released.campaignThread?.status, "linked_open", "released to the status the design already uses for 'campaign-tagged but shown in the Inbox'");
assert.match(String(released.reason), /new web lead arrived/i, "and it says why, in plain words, for the route trace");

// CAMPAIGN ATTRIBUTION MUST SURVIVE. Releasing is a VISIBILITY change; losing the campaign id would
// silently corrupt campaign reporting, which is a worse bug than the one being fixed.
for (const k of ["campaignId", "campaignName", "listId", "listName", "firstSentAt", "lastSentAt"] as const) {
  assert.equal(
    (released.campaignThread as any)?.[k],
    (BLAST as any)[k],
    `releasing must preserve ${k} — this is a visibility change, not an un-tagging`
  );
}

// ---------------------------------------------------------------------------
// 2. FAIL DIRECTION — everything unproven leaves the thread exactly as it is.
// ---------------------------------------------------------------------------
const noChange = [
  ["a non-lead inbound (a plain SMS reply) is not this predicate's job", { campaignThread: BLAST, isNewWebLead: false, leadReceivedAtIso: LEAD_AT }],
  ["a lead that PREDATES the blast is the history it was tagged onto", { campaignThread: BLAST, isNewWebLead: true, leadReceivedAtIso: "2026-04-21T14:52:55.000Z" }],
  ["a lead exactly AT the send instant is not strictly after it", { campaignThread: BLAST, isNewWebLead: true, leadReceivedAtIso: BLAST.firstSentAt }],
  ["an undatable lead proves nothing", { campaignThread: BLAST, isNewWebLead: true, leadReceivedAtIso: "not a date" }],
  ["a missing lead timestamp proves nothing", { campaignThread: BLAST, isNewWebLead: true, leadReceivedAtIso: null }],
  ["a thread with no campaign tag has nothing to release", { campaignThread: null, isNewWebLead: true, leadReceivedAtIso: LEAD_AT }],
  ["an undatable blast cannot establish a boundary", { campaignThread: { ...BLAST, firstSentAt: null, lastSentAt: null }, isNewWebLead: true, leadReceivedAtIso: LEAD_AT }]
] as const;
for (const [why, args] of noChange) {
  const d = resolveCampaignThreadOnNewLead(args as any);
  assert.equal(d.changed, false, why);
  assert.equal(d.reason, null, `${why} — and it claims nothing`);
  assert.equal(d.campaignThread, (args as any).campaignThread ?? null, `${why} — the value is handed back untouched`);
}

// ---------------------------------------------------------------------------
// 3. ONLY the HIDDEN status is released — never a later, deliberate state.
//
// `linked_open` is already visible, so releasing it is a no-op that would churn the record;
// `passed` is set by maybeMarkCampaignThreadPassed when a human routes the thread to a department,
// and walking that back would undo somebody's decision.
// ---------------------------------------------------------------------------
for (const status of ["linked_open", "passed", "", "CAMPAIGNED", "none"]) {
  const d = resolveCampaignThreadOnNewLead({
    campaignThread: { ...BLAST, status },
    isNewWebLead: true,
    leadReceivedAtIso: LEAD_AT
  });
  assert.equal(d.changed, false, `status "${status}" is not the hidden state and must be left alone`);
}
// …and the hidden status is matched case/whitespace-insensitively, because it is read off a store.
for (const status of ["campaign", "Campaign", "  CAMPAIGN  "]) {
  assert.equal(
    resolveCampaignThreadOnNewLead({ campaignThread: { ...BLAST, status }, isNewWebLead: true, leadReceivedAtIso: LEAD_AT }).changed,
    true,
    `"${status}" is the hidden state however the store spells it`
  );
}

// ---------------------------------------------------------------------------
// 4. THE EXCLUSION THAT CAUSED THIS MUST STAY. `hasInboundCampaignReplyAfter` answers a DIFFERENT
// question ("did they reply to the campaign?") and its ADF skip is correct — deleting it would
// inflate campaign response rates. The fix is a second predicate, not an edit to the first.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
const indexSrc = fs.readFileSync(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "services/api/src/index.ts"),
  "utf8"
);
const fnStart = indexSrc.indexOf("function hasInboundCampaignReplyAfter");
assert.ok(fnStart > 0, "hasInboundCampaignReplyAfter must still exist");
const fnBody = indexSrc.slice(fnStart, fnStart + 900);
assert.ok(
  fnBody.includes('provider === "sendgrid_adf"') && fnBody.includes("continue"),
  "the ADF exclusion in hasInboundCampaignReplyAfter must REMAIN — it answers 'did they reply to the campaign?', and removing it would count web leads as campaign replies"
);

// ---------------------------------------------------------------------------
// 5. The release is actually WIRED into the ADF landing path (a correct resolver nobody calls
// changes nothing — cf. the inert-fix trap).
// ---------------------------------------------------------------------------
const inboundSrc = fs.readFileSync(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "services/api/src/routes/sendgridInbound.ts"),
  "utf8"
);
assert.ok(
  inboundSrc.includes("resolveCampaignThreadOnNewLead("),
  "the ADF inbound path must CALL the resolver"
);
assert.ok(
  /isNewWebLead:\s*event\.provider === "sendgrid_adf"/.test(inboundSrc),
  "…and pass the real ADF signal, not a hardcoded true"
);
assert.ok(
  /leadReceivedAtIso:\s*event\.receivedAt/.test(inboundSrc),
  "…and the real receive time, so the after-the-blast test means something"
);

// ---------------------------------------------------------------------------
// 6. The INSTANCE repair must run too. The live fix is forward-only, so the threads already buried
// stay buried without the backfill — and `tsc` does not cover scripts/, so only EXECUTING it proves
// it still works. Its --self-test drives the same resolver against the real Matt Weiser shape.
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const selfTest = spawnSync("npx", ["tsx", path.join(repoRoot, "scripts", "backfill_campaign_thread_release.ts"), "--self-test"], {
  encoding: "utf8",
  cwd: repoRoot
});
assert.equal(
  Number(selfTest.status ?? 1),
  0,
  `the instance-repair backfill must still RUN (a forward-only fix leaves the buried leads buried)\n${selfTest.stdout}${selfTest.stderr}`
);
assert.match(String(selfTest.stdout), /--self-test: PASS/, "…and report its own pass");

console.log("campaign_thread_release_eval: PASS — a new web lead un-hides a blast-tagged thread, attribution kept, and the campaign-reply predicate is untouched");
