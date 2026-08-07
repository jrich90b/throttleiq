/**
 * Console Copilot Phase 2 (docs/console_copilot_phase2.md): pins the marketing-list
 * builder's COMPLIANCE exclusions (the reason this feature is allowed to exist), the
 * audience filters, and the endpoint's gates. Lists are PRODUCED, never sent — and every
 * exclusion fails toward a SMALLER list. Clock pinned; this eval never spends an LLM call.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const nowMs = Date.parse("2026-08-05T15:00:00.000Z");

// ── Seed the conversation store BEFORE anything imports it. ──
// The endpoint assertions near the bottom call the real handler, which reads the real store via
// getAllConversations(). conversationStore resolves CONVERSATIONS_DB_PATH into a module-scope const
// at LOAD, and marketingLists pulls it in transitively — so setting the path later has no effect and
// the endpoint ran against an EMPTY store. Every "no touring bike survives the exclusion" assertion
// was then trivially true on zero rows. MEASURED 2026-08-08: 0 rows in, 0 rows out, sabotage
// undetected. Two leads — one touring, one not — so the exclusion has something to remove AND
// something to keep.
const ENDPOINT_STORE_PATH = path.join(os.tmpdir(), `copilot-marketing-list-eval-${process.pid}.json`);
const endpointSeedConv = (n: number, model: string) => ({
  id: `endpoint-conv-${n}`,
  leadKey: `+1555999${String(n).padStart(4, "0")}`,
  mode: "suggest",
  createdAt: new Date(nowMs - 30 * 86_400_000).toISOString(),
  updatedAt: new Date(nowMs - 86_400_000).toISOString(),
  messages: [
    {
      id: `endpoint-m-${n}`,
      direction: "in",
      from: "x",
      to: "y",
      body: "hi",
      at: new Date(nowMs - 2 * 86_400_000).toISOString(),
      provider: "twilio"
    }
  ],
  lead: {
    name: `Endpoint Lead ${n}`,
    phone: `+1555999${String(n).padStart(4, "0")}`,
    email: `endpoint${n}@example.com`,
    source: "Dealer Website",
    vehicle: { model }
  }
});
fs.writeFileSync(
  ENDPOINT_STORE_PATH,
  JSON.stringify({
    version: 1,
    savedAt: new Date(nowMs).toISOString(),
    conversations: [endpointSeedConv(1, "Road King"), endpointSeedConv(2, "Iron 883")],
    todos: [],
    questions: []
  })
);
process.env.CONVERSATIONS_DB_PATH = ENDPOINT_STORE_PATH;
process.on("exit", () => {
  try {
    fs.unlinkSync(ENDPOINT_STORE_PATH);
  } catch {
    /* best effort */
  }
});

const { buildMarketingList } = await import("../services/api/src/domain/marketingLists.ts");
const { isTouringClassModel } = await import("../services/api/src/domain/modelFamily.ts");

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
// ── TOURING is the second class lane (Joe, 2026-08-06: "so there is no way to exclude touring?").
// It is supportable ONLY because both of its contaminations are measured and handled:
//   * TRIKE overlap — 2 codes (FLTRT Road Glide 3, FLHTCUTG Tri Glide Ultra). Trike wins.
//   * SOFTAIL overlap — exactly 1 code, FLHC (Heritage Classic). A Softail is not a touring bike.
// The CVO overlap is deliberately kept: a CVO Street Glide IS a touring bike.
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Street Glide", "touring"),
  true,
  "a Street Glide is touring even though its label never says 'touring'"
);
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Road King", "touring"),
  true,
  "a Road King is touring"
);
assert.equal(
  audienceModelMatches("2026 Harley-Davidson CVO Road Glide ST", "touring"),
  true,
  "a CVO touring bike is touring — the CVO overlay never disqualifies"
);
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Street Glide 3 Limited", "touring"),
  false,
  "a trike is never in a touring audience"
);
// These two are the trikes that ACTUALLY exercise the trike guard: FLTRT and FLHTCUTG are the
// only codes filed under both TOURING and TRIKE, so they are the only models that reach the
// touring test still looking like touring bikes. Street Glide 3 Limited does not — its code is
// not cross-listed, so it would be excluded even with the guard removed. Asserting only on it
// left the guard untested (caught by sabotage, 2026-08-06).
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Road Glide 3", "touring"),
  false,
  "Road Glide 3 (FLTRT — cross-listed TOURING+TRIKE) is a trike, not a touring bike"
);
assert.equal(
  audienceModelMatches("2019 Harley-Davidson Tri Glide Ultra", "touring"),
  false,
  "Tri Glide Ultra (FLHTCUTG — the other cross-listed code) is a trike, not a touring bike"
);
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Heritage Classic", "touring"),
  false,
  "a Heritage Classic is a SOFTAIL — the one code the catalog cross-lists into TOURING"
);
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Fat Boy", "touring"),
  false,
  "a Softail with no touring code is not touring"
);
assert.equal(
  audienceModelMatches("2022 Harley-Davidson Iron 883", "touring"),
  false,
  "a Sportster is not touring"
);
// A THIRD class must not appear by accident: an unmeasured family word stays a NAME match.
assert.equal(
  audienceModelMatches("2026 Harley-Davidson Breakout", "softail"),
  false,
  "'softail' is not a supported class lane — it stays a name match and finds nothing by that name"
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

// ── excludeModelQuery: "everyone in the last 90 days EXCEPT touring bikes" (Joe, 2026-08-06). ──
const sgLead = lead({ vehicle: { year: "2026", make: "Harley-Davidson", model: "Street Glide" } });
const sportsterLead = lead({ vehicle: { year: "2022", make: "Harley-Davidson", model: "Iron 883" } });
const trikeLead = lead({ vehicle: { year: "2026", make: "Harley-Davidson", model: "Street Glide 3 Limited" } });
const exTouring = buildMarketingList([sgLead, sportsterLead, trikeLead], {
  filters: { channel: "sms", excludeModelQuery: "touring" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.deepEqual(
  exTouring.rows.map(r => r.convId).sort(),
  [sportsterLead.id, trikeLead.id].sort(),
  "excluding touring drops the Street Glide and keeps the Sportster and the trike"
);
// Both filters at once: "street glides but not trikes" — the reason exclusion runs AFTER modelQuery.
const sgNotTrikes = buildMarketingList([sgLead, trikeLead, sportsterLead], {
  filters: { channel: "sms", modelQuery: "street glide", excludeModelQuery: "trike" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.deepEqual(
  sgNotTrikes.rows.map(r => r.convId),
  [sgLead.id],
  "include and exclude compose"
);
// ANY matching interest disqualifies — an exclusion asks whether this is a touring customer AT ALL.
const bothInterests = lead({
  vehicle: { year: "2022", make: "Harley-Davidson", model: "Iron 883" },
  watches: [{ make: "Harley-Davidson", model: "Road Glide", status: "active" }]
});
const exTouring2 = buildMarketingList([bothInterests], {
  filters: { channel: "sms", excludeModelQuery: "touring" },
  isPhoneSuppressed: NO_SUPPRESSION,
  nowMs
});
assert.equal(
  exTouring2.rows.length,
  0,
  "one touring interest is enough to exclude, even when another interest is not touring"
);
// FAIL DIRECTION: an exclusion can only ever SHRINK. Absent or empty changes nothing.
for (const ex of [undefined, null, ""] as const) {
  const noEx = buildMarketingList([sgLead, sportsterLead], {
    filters: { channel: "sms", excludeModelQuery: ex },
    isPhoneSuppressed: NO_SUPPRESSION,
    nowMs
  });
  assert.equal(noEx.rows.length, 2, `excludeModelQuery=${JSON.stringify(ex)} filters nothing`);
}

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

// The store this handler reads was seeded at the TOP of this file, before any import could load it.
// Await hydration explicitly: the boot load is ASYNC, and everything above here is synchronous, so
// without this the endpoint section reaches the handler before the seed has landed and reads an
// empty store — the same vacuum, arriving by a different route. reloadConversationStore() chains
// after any in-flight boot load by design, so awaiting it is the documented way to be sure.
await (await import("../services/api/src/domain/conversationStore.ts")).reloadConversationStore();
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

// ── The NAME on the row (2026-08-07). ──
// The builder read `lead.name` alone. Measured on the live americanharley store: `lead.name` is
// populated on 563 of 822 conversations, `firstName` on 814 and `lastName` on 803 — so about a
// THIRD of every list came out as bare phone numbers with no name beside them, including all four
// rows of the first real list a manager pulled. A list a human cannot read is not a list.
{
  const { resolveMarketingListName } = await import("../services/api/src/domain/marketingLists.ts");

  // The real shape that broke it: firstName/lastName present, `name` absent.
  const split = lead({});
  split.lead.name = undefined;
  split.lead.firstName = "Maya";
  split.lead.lastName = "Iversen";
  assert.equal(resolveMarketingListName(split), "Maya Iversen", "first+last is the display name");

  // First name only — still a usable row, and this is the live shape for several leads.
  const firstOnly = lead({});
  firstOnly.lead.name = undefined;
  firstOnly.lead.firstName = "igor";
  firstOnly.lead.lastName = undefined;
  assert.equal(resolveMarketingListName(firstOnly), "igor", "a first name alone is still a name");

  // Legacy `name` still works, and still wins when it is the only thing we hold.
  const legacy = lead({});
  legacy.lead.firstName = undefined;
  legacy.lead.lastName = undefined;
  legacy.lead.name = "Legacy Lead";
  assert.equal(resolveMarketingListName(legacy), "Legacy Lead", "the legacy field is not dropped");

  // firstName/lastName WIN over a stale `name` — the split fields are the ones the ADF keeps current.
  const both = lead({});
  both.lead.name = "Stale Name";
  both.lead.firstName = "Fresh";
  both.lead.lastName = "Name";
  assert.equal(resolveMarketingListName(both), "Fresh Name", "split fields outrank the legacy field");

  // Nothing at all => null, and the row is still LISTED. A contactable lead with no name on file is
  // a real lead; dropping it would be a silent, compliance-invisible loss of audience.
  const nameless = lead({});
  nameless.lead.name = undefined;
  nameless.lead.firstName = undefined;
  nameless.lead.lastName = undefined;
  assert.equal(resolveMarketingListName(nameless), null, "no name on file reads null, not a crash");
  const namelessList = buildMarketingList([nameless], { filters: { channel: "sms" }, isPhoneSuppressed: NO_SUPPRESSION, nowMs });
  assert.equal(namelessList.rows.length, 1, "a nameless lead is still on the list");
  assert.equal(namelessList.rows[0].name, null);

  // Whitespace-only is not a name.
  const blank = lead({});
  blank.lead.name = "   ";
  blank.lead.firstName = "  ";
  blank.lead.lastName = "";
  assert.equal(resolveMarketingListName(blank), null, "whitespace is not a name");

  // END-TO-END through the builder itself — the bug was in the row construction, not the helper.
  const wired = lead({});
  wired.lead.name = undefined;
  wired.lead.firstName = "Savannah";
  wired.lead.lastName = "Reed";
  const wiredList = buildMarketingList([wired], { filters: { channel: "sms" }, isPhoneSuppressed: NO_SUPPRESSION, nowMs });
  assert.equal(wiredList.rows.length, 1);
  assert.equal(wiredList.rows[0].name, "Savannah Reed", "buildMarketingList must USE the resolver, not lead.name");
}

// The exclusion reaches the builder THROUGH the endpoint — a field the parser fills but the
// handler drops would leave a filter that quietly does nothing (the wiring trap).
const exclusionThroughEndpoint = mockRes();
await copilotMarketingListHandler(
  { user: { role: "manager" }, body: { filters: { channel: "sms", excludeModelQuery: "touring" } } } as any,
  exclusionThroughEndpoint as any
);
assert.equal(exclusionThroughEndpoint.statusCode, 200, "the endpoint accepts an exclusion filter");
assert.equal(
  exclusionThroughEndpoint.body?.filters?.excludeModelQuery,
  "touring",
  "the endpoint echoes the exclusion back, so the console can show what it built"
);
// POSITIVE FIRST: the same endpoint, WITHOUT the exclusion, must return a touring row — otherwise
// the negative assertion below passes on an empty result and proves nothing (see the seed above).
const noExclusionThroughEndpoint = mockRes();
await copilotMarketingListHandler(
  { user: { role: "manager" }, body: { filters: { channel: "sms" } } } as any,
  noExclusionThroughEndpoint as any
);
const touringRows = (r: any) =>
  (r.body?.result?.rows ?? []).filter((x: any) => isTouringClassModel(x.modelInterest) === true).length;
assert.ok(
  touringRows(noExclusionThroughEndpoint) > 0,
  "the endpoint fixture must CONTAIN a touring bike, or the exclusion assertion is vacuous"
);
assert.ok(
  exclusionThroughEndpoint.body.result.rows.length > 0,
  "the exclusion must SHRINK the list, not empty it — a non-touring lead still belongs"
);
assert.equal(
  touringRows(exclusionThroughEndpoint),
  0,
  "no touring bike survives an excludeModelQuery=touring list built through the endpoint"
);

// The plain-English lane must be ABLE to produce an exclusion: the field is required by the
// schema (so the model always answers it) and survives into the parser's typed result.
const copilotSrc = fs.readFileSync("services/api/src/domain/copilotLLM.ts", "utf8");
assert.ok(
  /required:\s*\[[^\]]*"excludeModelQuery"/s.test(copilotSrc),
  "excludeModelQuery is a REQUIRED schema field — an optional one gets silently omitted"
);
assert.ok(
  /excludeModelQuery:\s*\n?\s*typeof parsed\.excludeModelQuery === "string"/.test(copilotSrc),
  "the parser maps excludeModelQuery into its typed result"
);
assert.ok(
  /-\s*excludeModelQuery:/.test(copilotSrc),
  "the prompt tells the model when to fill it"
);

console.log(
  "PASS console copilot marketing list eval (compliance order + audience filters + trike/touring class lanes both directions + exclusions + matched-interest labelling + row name fallback)"
);
