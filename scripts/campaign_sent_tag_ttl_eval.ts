/**
 * Campaign-sent tag TTL eval (Joe, 2026-07-21: fade the inbox "Campaign sent" pill after 14 days).
 *
 * The pill means "this contact got a blast and hasn't replied." Context decays: replies land in
 * the first days and blasts run ~monthly (each blast re-stamps lastSentAt, re-arming the pill).
 * This pins the pure predicate (isCampaignSentTagFresh) and the InboxSection wiring.
 *
 * Run: npx tsx scripts/campaign_sent_tag_ttl_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
const { isCampaignSentTagFresh, CAMPAIGN_SENT_TAG_TTL_DAYS } = await import(
  "../apps/web/src/app/lib/campaignTag.ts"
);

let n = 0;
const T = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-07-21T12:00:00.000Z");
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

T(CAMPAIGN_SENT_TAG_TTL_DAYS === 14, "TTL is 14 days (Joe, 7/21)");

// Fresh blast → visible.
T(isCampaignSentTagFresh({ lastSentAt: iso(1 * DAY) }, now), "1 day old: visible");
// Just inside the window → visible.
T(isCampaignSentTagFresh({ lastSentAt: iso(13.5 * DAY) }, now), "13.5 days old: visible");
// Exactly at the boundary → still visible (<=).
T(isCampaignSentTagFresh({ lastSentAt: iso(14 * DAY) }, now), "exactly 14 days: visible");
// Past the window → hidden.
T(!isCampaignSentTagFresh({ lastSentAt: iso(14 * DAY + 60_000) }, now), "just past 14 days: hidden");
T(!isCampaignSentTagFresh({ lastSentAt: iso(45 * DAY) }, now), "45 days old: hidden");
// A RE-BLAST re-arms the pill: stale firstSentAt, fresh lastSentAt → visible.
T(
  isCampaignSentTagFresh({ firstSentAt: iso(90 * DAY), lastSentAt: iso(2 * DAY) }, now),
  "re-blast (fresh lastSentAt, old firstSentAt): visible"
);
// lastSentAt missing → falls back to firstSentAt.
T(!isCampaignSentTagFresh({ firstSentAt: iso(30 * DAY) }, now), "firstSentAt-only, 30d: hidden");
T(isCampaignSentTagFresh({ firstSentAt: iso(3 * DAY) }, now), "firstSentAt-only, 3d: visible");
// FAIL DIRECTION: records with no/unparseable stamps keep today's behavior (visible) — never
// silently hide context on a legacy record.
T(isCampaignSentTagFresh({}, now), "no timestamps: visible (status quo)");
T(isCampaignSentTagFresh(null, now), "no campaignThread: visible (status quo)");
T(isCampaignSentTagFresh({ lastSentAt: "not-a-date" }, now), "unparseable stamp: visible (status quo)");

// --- Wiring: the InboxSection pill consults the predicate (and reply still wins first). ---
const inbox = fs.readFileSync("apps/web/src/app/components/InboxSection.tsx", "utf8");
assert.match(
  inbox,
  /!campaignReply &&\s*\n\s*isCampaignSentTagFresh\(c\.campaignThread, nowMs\)/,
  "InboxSection campaignSent pill is gated by isCampaignSentTagFresh (after the reply check)"
);
assert.match(inbox, /import \{ isCampaignSentTagFresh \} from "\.\.\/lib\/campaignTag"/, "helper imported");
n += 2;

console.log(`PASS campaign-sent tag TTL eval (${n} assertions)`);
