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

// ── The row shows the interest that ANSWERED the query, not just the lead's first one. ──
// Found 2026-08-06 verifying the trike-scope fix against live data: +17163163226 earns a
// "street glide" list through a watch on a two-wheel Street Glide, but his lead vehicle is a
// Street Glide 3 Limited — and the row displayed the TRIKE. Membership was right; the label
// read exactly like the bug that was just fixed. +15136149740 is the mirror: a genuine trike
// watcher (two Road Glide 3 watches) labelled with his two-wheel Road Glide lead vehicle.
const mixedInterest = lead({
  vehicle: { year: "2025", make: "Harley-Davidson", model: "Street Glide 3 Limited" },
  watches: [{ make: "Harley-Davidson", model: "Street Glide", status: "active" }]
});
const mixedSg = buildMarketingList([mixedInterest], {
  filters: { channel: "sms", modelQuery: "street glide" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.equal(mixedSg.rows.length, 1, "the two-wheel watch still earns a place on a Street Glide list");
assert.equal(
  mixedSg.rows[0]!.modelInterest,
  "Harley-Davidson Street Glide",
  "the row names the two-wheeler that matched — never the trike sitting beside it"
);
const mixedTrike = buildMarketingList([mixedInterest], {
  filters: { channel: "sms", modelQuery: "trike" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.equal(mixedTrike.rows.length, 1, "the same lead also belongs on a trike list");
assert.equal(
  mixedTrike.rows[0]!.modelInterest,
  "2025 Harley-Davidson Street Glide 3 Limited",
  "on the trike list the row names the TRIKE — the label follows the query, not the record order"
);
// No query means nothing to explain: the first known interest, exactly as before.
const noQuery = buildMarketingList([mixedInterest], {
  filters: { channel: "sms" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.equal(
  noQuery.rows[0]!.modelInterest,
  "2025 Harley-Davidson Street Glide 3 Limited",
  "with no model query the row keeps the lead's first interest"
);

// ── A TRIKE is not its two-wheel namesake (Joe, 2026-08-06). ──
// "anyone who inquired about a new Street Glide in the last 90 days" came back carrying Street
// Glide 3 Limited buyers, because that label literally contains "street glide". On the live store
// that day, 22 of the 97 matched leads were trikes. Same class line the watch engine scopes on
// (modelFamily.trikeClassConflict) — Joe: "This should probably use the same logic as the watches."
const { audienceModelMatches } = await import("../services/api/src/domain/marketingLists.ts");
const twoWheeler = lead({ vehicle: { year: "2026", make: "Harley-Davidson", model: "Street Glide Special" } });
const trike = lead({ vehicle: { year: "2026", make: "Harley-Davidson", model: "Street Glide 3 Limited" } });
const cvoTrike = lead({ vehicle: { year: "2026", make: "Harley-Davidson", model: "CVO Street Glide 3 Limited" } });
const trikeWatcher = lead({ watches: [{ model: "Street Glide Trike", status: "active" }] });
const sgList = buildMarketingList([twoWheeler, trike, cvoTrike, trikeWatcher], {
  filters: { channel: "sms", modelQuery: "street glide" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.deepEqual(
  sgList.rows.map(r => r.convId),
  [twoWheeler.id],
  "a Street Glide list carries the two-wheeler and NO trike — not the 3 Limited, not the CVO 3 Limited, not a Street Glide Trike watch"
);

// The mirror direction: a trike query must not collect two-wheelers.
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Street Glide 3 Limited", "street glide 3"),
  true,
  "the trike itself still matches a trike query"
);
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Street Glide Special", "street glide 3"),
  false,
  "a two-wheeler is not swept into a trike query"
);

// ── Asking for the CLASS finds the trikes by class, not by name (Joe, 2026-08-06). ──
// "anyone interested in a trike" used to return nobody: no trike label contains the word.
const classList = buildMarketingList([twoWheeler, trike, cvoTrike, trikeWatcher], {
  filters: { channel: "sms", modelQuery: "trike" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.deepEqual(
  classList.rows.map(r => r.convId).sort(),
  [trike.id, cvoTrike.id, trikeWatcher.id].sort(),
  "a trike audience collects every trike — including labels with no 'trike' in the name — and no two-wheeler"
);
for (const phrasing of ["trike", "trikes", "a new trike"]) {
  assert.equal(
    audienceModelMatches("2026 Harley-Davidson Street Glide 3 Limited", phrasing),
    true,
    `class request "${phrasing}" reaches a trike whose name never says trike`
  );
  assert.equal(
    audienceModelMatches("2026 Harley-Davidson Street Glide Special", phrasing),
    false,
    `class request "${phrasing}" does not collect a two-wheeler`
  );
}
// The class lane must never fire on a specific MODEL that happens to carry the word.
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Street Glide Trike", "street glide trike"),
  true,
  "naming a specific trike model still matches it by name"
);
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Tri Glide Ultra", "street glide trike"),
  false,
  "a specific-model query is NOT widened into the whole class"
);
// The cross-listing trap this deliberately does NOT open: family words other than trike keep
// matching by name, because 62 of the catalog's 278 codes sit in more than one family (FLTRT is
// in TOURING *and* TRIKE), so a "touring" class lane would drag the trikes straight back in.
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Street Glide 3 Limited", "touring"),
  false,
  "'touring' stays a name match — a family lane there would re-introduce the trike bug"
);

// FAIL DIRECTION: the class read can only ever NARROW. Anything that fails to resolve to a class
// on BOTH sides falls through to the substring behaviour that shipped before this change.
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Street Glide Special", "street glide"),
  true,
  "a same-class pair is unaffected"
);
assert.equal(
  audienceModelMatches("Some Unlisted Custom Build", "custom"),
  true,
  "an unresolvable label still matches on substring — never narrower than before"
);
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Street Glide 3 Limited", "harley"),
  true,
  "an unresolvable QUERY still matches on substring — the guard needs both sides to resolve"
);
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Road Glide", "street glide"),
  false,
  "a plain non-match is still a non-match"
);
assert.equal(audienceModelMatches("anything at all", ""), true, "an empty query filters nothing");

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

console.log("PASS console copilot marketing list eval (compliance order + audience filters + trike-class scope both directions + matched-interest labelling)");
