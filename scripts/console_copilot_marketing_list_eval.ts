/**
 * Console Copilot Phase 2 (docs/console_copilot_phase2.md): pins the marketing-list
 * builder's COMPLIANCE exclusions (the reason this feature is allowed to exist), the
 * audience filters, and the endpoint's gates. Lists are PRODUCED, never sent — and every
 * exclusion fails toward a SMALLER list. Clock pinned; this eval never spends an LLM call.
 */
import assert from "node:assert/strict";

const { buildMarketingList } = await import("../services/api/src/domain/marketingLists.ts");

const nowMs = Date.parse("2026-08-05T15:00:00.000Z");
const daysAgo = (d: number) => new Date(nowMs - d * 86_400_000).toISOString();

let leadSeq = 0;
function lead(overrides: any = {}): any {
  leadSeq++;
  const phone = overrides.phone === undefined ? `+1555000${String(leadSeq).padStart(4, "0")}` : overrides.phone;
  return {
    id: `conv-${leadSeq}`,
    leadKey: phone || `lead-${leadSeq}`,
    mode: "suggest",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    messages: [
      {
        id: `m-${leadSeq}`,
        direction: "in",
        from: "x",
        to: "y",
        body: "hi",
        at: overrides.lastInboundDaysAgo != null ? daysAgo(overrides.lastInboundDaysAgo) : daysAgo(2),
        provider: "twilio"
      }
    ],
    lead: {
      name: `Lead ${leadSeq}`,
      phone,
      email: overrides.email === undefined ? `lead${leadSeq}@example.com` : overrides.email,
      source: overrides.source ?? "Dealer Website",
      smsOptIn: overrides.smsOptIn,
      emailOptIn: overrides.emailOptIn,
      vehicle: overrides.vehicle
    },
    inventoryWatches: overrides.watches,
    ...overrides.conv
  };
}

const NO_SUPPRESSION = () => false;

// ── Compliance: each excluded lead is counted under exactly one reason. ──
const eligible = lead({ vehicle: { model: "Street Glide", condition: "NEW" } });
const noPhone = lead({ phone: null });
const optedOut = lead({ smsOptIn: false });
const stopped = lead({});
const watchOptedOut = lead({ conv: { inventoryWatchOptOut: { at: daysAgo(5), reason: "all set" } } });
const sold = lead({ conv: { sale: { soldAt: daysAgo(3) } } });
const closed = lead({ conv: { status: "closed" } });

const smsList = buildMarketingList(
  [eligible, noPhone, optedOut, stopped, watchOptedOut, sold, closed],
  {
    filters: { channel: "sms" },
    isPhoneSuppressed: p => p === stopped.lead.phone,
    nowMs
  }
);
assert.deepEqual(
  smsList.excluded,
  { missingContact: 1, optedOut: 1, suppressed: 1, watchOptOut: 1 },
  "every compliance rule fires and each lead counts once"
);
assert.equal(smsList.rows.some(r => r.phone === stopped.lead.phone), false, "a STOP-listed phone NEVER makes a list");
assert.equal(smsList.rows.some(r => r.convId === optedOut.id), false, "an explicit sms opt-out NEVER makes a list");
assert.equal(smsList.rows.some(r => r.convId === watchOptedOut.id), false, "the durable stop-alerting-me flag excludes from marketing");
assert.equal(smsList.rows.some(r => r.convId === sold.id), false, "sold customers are not a prospecting audience");
assert.equal(smsList.rows.some(r => r.convId === closed.id), false, "closed leads stay off unless includeClosed");
assert.ok(smsList.rows.some(r => r.convId === eligible.id), "the clean lead is on the list");

// includeClosed opts closed leads back in — compliance still applies to them.
const withClosed = buildMarketingList([closed, lead({ conv: { status: "closed" }, smsOptIn: false })], {
  filters: { channel: "sms", includeClosed: true },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.ok(withClosed.rows.some(r => r.convId === closed.id), "includeClosed re-admits closed leads");
assert.equal(withClosed.excluded.optedOut, 1, "opt-out still excludes a closed lead");

// Email channel: email contact + email opt-in govern; a missing email is missingContact.
const emailList = buildMarketingList(
  [lead({}), lead({ email: null }), lead({ emailOptIn: false })],
  { filters: { channel: "email" }, isPhoneSuppressed: NO_SUPPRESSION, nowMs }
);
assert.equal(emailList.rows.length, 1, "email list keeps only the clean lead");
assert.deepEqual(
  emailList.excluded,
  { missingContact: 1, optedOut: 1, suppressed: 0, watchOptOut: 0 },
  "email channel counts its own opt-in, never the STOP list"
);

// ── Audience filters (misses only narrow the list, never widen it). ──
const touringWatcher = lead({ watches: [{ model: "Road Glide", status: "active" }] });
const sportster = lead({ vehicle: { model: "Sportster S", condition: "USED" } });
const modelList = buildMarketingList([touringWatcher, sportster], {
  filters: { channel: "sms", modelQuery: "road glide" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.equal(modelList.rows.length, 1, "model query narrows to matching leads");
assert.equal(modelList.rows[0]!.convId, touringWatcher.id, "watch models count as model interest");

const usedList = buildMarketingList([sportster, touringWatcher], {
  filters: { channel: "sms", condition: "used" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.equal(usedList.rows.length, 1, "condition filter narrows");
assert.equal(usedList.rows[0]!.convId, sportster.id, "USED vehicle matches the used condition");

const recent = lead({ lastInboundDaysAgo: 5 });
const stale = lead({ lastInboundDaysAgo: 120 });
const windowList = buildMarketingList([recent, stale], {
  filters: { channel: "sms", activeWithinDays: 90 },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.equal(windowList.rows.length, 1, "activity window narrows");
assert.equal(windowList.rows[0]!.convId, recent.id, "only the recent replier is inside 90 days");

// One row per LEAD: two conversations sharing a leadKey collapse to the newest.
const dupA = lead({});
const dupB = { ...lead({}), leadKey: dupA.leadKey, updatedAt: daysAgo(0.5) };
const dedupList = buildMarketingList([dupA, dupB], {
  filters: { channel: "sms" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.equal(dedupList.rows.length, 1, "one row per lead, not per conversation");
assert.equal(dedupList.rows[0]!.convId, dupB.id, "the newest conversation represents the lead");

assert.equal(dedupList.generatedAt, new Date(nowMs).toISOString(), "result stamps the pinned clock");

// ── Endpoint gates (behavior; never a real LLM call). ──
process.env.LLM_ENABLED = "0";
process.env.OPENAI_API_KEY ??= "eval-placeholder-never-called";
const { copilotMarketingListHandler } = await import("../services/api/src/routes/copilot.ts");
function mockRes() {
  return {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    }
  };
}
const salesRes = mockRes();
await copilotMarketingListHandler({ user: { role: "salesperson" }, body: { filters: { channel: "sms" } } } as any, salesRes as any);
assert.equal(salesRes.statusCode, 403, "marketing lists are manager-only");
const badChannel = mockRes();
await copilotMarketingListHandler({ user: { role: "manager" }, body: { filters: { channel: "fax" } } } as any, badChannel as any);
assert.equal(badChannel.statusCode, 400, "unknown channel is rejected");
const okRes = mockRes();
await copilotMarketingListHandler({ user: { role: "manager" }, body: { filters: { channel: "sms" } } } as any, okRes as any);
assert.equal(okRes.statusCode, 200, "manager builds a list from typed filters");
assert.ok(okRes.body?.result?.excluded, "response reports the exclusion counts");
const describeNoLlm = mockRes();
await copilotMarketingListHandler({ user: { role: "manager" }, body: { describe: "touring buyers" } } as any, describeNoLlm as any);
assert.equal(describeNoLlm.statusCode, 503, "describe path with LLM off degrades, never guesses filters");

console.log("PASS console copilot marketing list eval");
