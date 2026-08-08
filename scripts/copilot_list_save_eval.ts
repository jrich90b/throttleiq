/**
 * copilot_list_save:eval — pins phase 3 (docs/console_copilot_phase3_lists.md): a described
 * marketing list SAVES as a real customer list.
 *
 * The acceptance criteria in §7 of the spec, in order:
 *  1. lead→contact resolution: phone match, email match, no-match-creates-one, and the SAME
 *     normalization the suppression check uses (a lead that IS suppressed must resolve to the same
 *     key `isSuppressed` would reject);
 *  2. the saved count EQUALS the number the user was shown — a list that quietly differs in size
 *     from its preview destroys confidence in the feature;
 *  3. a saved described list carries source "snapshot" and does NOT acquire a dynamic filter, so it
 *     can never start re-resolving;
 *  4. today's dropdown filter lists keep resolving LIVE — a regression pin, because this change
 *     touches the same store.
 *
 * Clock-independent; spends no LLM call.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Seed the stores the ENDPOINT reads, before anything can import them: each store resolves its path
// into a module-scope const at load. Without this the handler test runs against empty stores and
// every assertion about what it saved is vacuous — measured on the sibling marketing-list eval the
// same day, where a handler that dropped a filter entirely still passed.
const TMP = os.tmpdir();
const CONV_PATH = path.join(TMP, `copilot-list-save-eval-${process.pid}-conversations.json`);
process.env.CONVERSATIONS_DB_PATH = CONV_PATH;
process.env.CONTACTS_DB_PATH = path.join(TMP, `copilot-list-save-eval-${process.pid}-contacts.json`);
process.env.CONTACT_LISTS_DB_PATH = path.join(TMP, `copilot-list-save-eval-${process.pid}-lists.json`);
process.env.LLM_ENABLED = "0";
process.env.OPENAI_API_KEY ??= "eval-placeholder-never-called";
const ENDPOINT_NOW = Date.parse("2026-08-08T19:00:00.000Z");
const seedConv = (i: number, model: string) => ({
  id: `save-conv-${i}`,
  leadKey: `+1555444${String(i).padStart(4, "0")}`,
  mode: "suggest",
  createdAt: new Date(ENDPOINT_NOW - 30 * 86_400_000).toISOString(),
  updatedAt: new Date(ENDPOINT_NOW - 86_400_000).toISOString(),
  messages: [
    {
      id: `save-m-${i}`,
      direction: "in",
      from: "x",
      to: "y",
      body: "hi",
      at: new Date(ENDPOINT_NOW - 2 * 86_400_000).toISOString(),
      provider: "twilio"
    }
  ],
  lead: {
    name: `Save Lead ${i}`,
    phone: `+1555444${String(i).padStart(4, "0")}`,
    email: `save${i}@example.com`,
    source: "Dealer Website",
    vehicle: { model }
  }
});
fs.writeFileSync(
  CONV_PATH,
  JSON.stringify({
    version: 1,
    savedAt: new Date(ENDPOINT_NOW).toISOString(),
    conversations: [seedConv(1, "Street Glide"), seedConv(2, "Road Glide"), seedConv(3, "Iron 883")],
    todos: [],
    questions: []
  })
);
process.on("exit", () => {
  for (const p of [CONV_PATH, process.env.CONTACTS_DB_PATH!, process.env.CONTACT_LISTS_DB_PATH!]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
  }
});

const { saveMarketingListRowsAsContacts } = await import("../services/api/src/domain/marketingListSave.ts");
const { normalizePhone, isSuppressed } = await import("../services/api/src/domain/suppressionStore.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const row = (over: Record<string, any> = {}): any => ({
  convId: over.convId ?? `conv-${Math.abs(hash(JSON.stringify(over)))}`,
  leadKey: over.leadKey ?? over.phone ?? "lead",
  name: over.name ?? "A Lead",
  phone: over.phone ?? null,
  email: over.email ?? null,
  source: "Dealer Website",
  modelInterest: over.modelInterest ?? "Road Glide",
  lastInboundAt: null,
  status: "open",
  ...over
});
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** A fake contacts store that behaves like the real one's upsert: resolve by phone/email, else create. */
function fakeStore(seed: { id: string; phone?: string; email?: string }[]) {
  const rows = seed.map(s => ({ ...s }));
  let seq = 0;
  const created: any[] = [];
  return {
    rows,
    created,
    deps: {
      listContacts: () => rows,
      upsertContact: (input: any) => {
        seq += 1;
        const made = { id: `new-${seq}`, ...input };
        rows.push(made);
        created.push(made);
        return made;
      },
      normalizePhone
    }
  };
}

const ORIGIN = { description: "everyone interested in a used Street Glide", listName: "SG shoppers", at: "2026-08-08T19:00:00.000Z" };

// ── 1. Resolution: phone, email, and create-when-missing ──────────────────────────────────────
{
  const store = fakeStore([
    { id: "c-phone", phone: "+15551230000", email: "phone-person@example.com" },
    { id: "c-email", phone: undefined, email: "email-person@example.com" }
  ]);
  const result = saveMarketingListRowsAsContacts(
    [
      row({ phone: "+15551230000" }), // matches by phone
      row({ email: "EMAIL-PERSON@example.com" }), // matches by email, case-insensitively
      row({ phone: "+15559998888", email: "brand-new@example.com" }) // no record -> created
    ],
    store.deps,
    ORIGIN
  );
  ok(result.matched === 2, `two rows match existing contacts (got ${result.matched})`);
  ok(result.created === 1, `the unmatched row gets a contact created (got ${result.created})`);
  ok(result.total === 3, `total is matched + created (got ${result.total})`);
  ok(result.contactIds.length === 3, "every row is represented in the saved list");
  ok(result.contactIds.includes("c-phone") && result.contactIds.includes("c-email"), "the existing contacts are the ones used");
  ok(store.created.length === 1, "exactly one contact record was created");
  ok(
    String(store.created[0].leadSource ?? "").includes("SG shoppers"),
    "a created contact is stamped with the list that made it, so it can be traced back"
  );
}

// ── The normalization AGREES with the suppression check (spec §7, first bullet) ────────────────
// Different spellings of the same number must resolve to the same contact — and to the same key the
// STOP list would reject. If these ever diverged, a list could match a customer under one spelling
// while suppression reads another.
{
  const store = fakeStore([{ id: "c-1", phone: "+15551234567" }]);
  const result = saveMarketingListRowsAsContacts(
    [row({ phone: "5551234567" }), row({ phone: "(555) 123-4567" }), row({ phone: "1-555-123-4567" })],
    store.deps,
    ORIGIN
  );
  ok(result.matched === 3, `every spelling of the same number matches the one contact (got ${result.matched})`);
  ok(result.created === 0, "no duplicate contact is created for a re-spelled number");
  ok(result.contactIds.length === 1, "and the saved list holds that person exactly once");
  for (const spelling of ["5551234567", "(555) 123-4567", "1-555-123-4567", "+15551234567"]) {
    ok(normalizePhone(spelling) === "+15551234567", `${spelling} normalizes to the suppression key`);
  }
  ok(typeof isSuppressed === "function", "the suppression check this agrees with is the real one");
}

// ── A row with neither phone nor email is NOT invented into existence ──────────────────────────
{
  const store = fakeStore([]);
  const result = saveMarketingListRowsAsContacts([row({ phone: null, email: null })], store.deps, ORIGIN);
  ok(result.unresolvable === 1, "a row with no way to reach anyone is reported, not created");
  ok(result.created === 0 && store.created.length === 0, "no contactless record is padded into the address book");
  ok(result.total === 0, "and it is not counted toward the saved size");
}

// ── Two rows for the same person collapse to ONE list member ───────────────────────────────────
{
  const store = fakeStore([]);
  const result = saveMarketingListRowsAsContacts(
    [row({ phone: "+15557770000" }), row({ phone: "+15557770000" })],
    store.deps,
    ORIGIN
  );
  ok(result.contactIds.length === 1, "the same person is one member, not two");
  ok(store.created.length === 1, "and one contact record, not two — the second row matches the first's creation");
}

// ── 2/3. The saved list is a SNAPSHOT: size matches, and it never re-resolves ───────────────────
{
  const { createContactList, getContactList } = await import("../services/api/src/domain/contactListsStore.ts");
  const saved = createContactList({
    name: "SG shoppers",
    source: "snapshot",
    contactIds: ["a", "b", "c"],
    // Deliberately ALSO passing a filter: a snapshot must refuse it rather than quietly become live.
    filter: { model: "Street Glide" } as any,
    description: ORIGIN.description,
    builtAt: ORIGIN.at
  });
  ok(saved.source === "snapshot", "a described list is saved as a snapshot");
  ok(!saved.filter, "a snapshot NEVER carries a filter — it can never start re-resolving by accident");
  ok((saved.contactIds ?? []).length === 3, "the saved size is exactly what was passed in");
  ok(saved.description === ORIGIN.description, "the description rides along for provenance");
  ok(saved.builtAt === ORIGIN.at, "and when it was built");
  const readBack = getContactList(saved.id);
  ok((readBack?.contactIds ?? []).length === 3, "and it reads back the same size");

  // 4. REGRESSION PIN: an ordinary filter list still keeps its filter and stays live.
  const live = createContactList({ name: "Road Glide owners", source: "filter", filter: { model: "Road Glide" } as any });
  ok(live.source === "filter", "a dropdown list is still a filter list");
  ok(!!live.filter && live.filter.model === "Road Glide", "a filter list KEEPS its rule — it must go on re-resolving");
}

// ── THE WIRING. The domain function passing proves nothing about the endpoint. ─────────────────
// Drive the real handler and read what it actually saved. Hydration is awaited explicitly because
// the store's boot load is async and everything above here is synchronous.
{
  await (await import("../services/api/src/domain/conversationStore.ts")).reloadConversationStore();
  const { copilotMarketingListSaveHandler } = await import("../services/api/src/routes/copilot.ts");
  const { getContactList } = await import("../services/api/src/domain/contactListsStore.ts");
  const { listContacts } = await import("../services/api/src/domain/contactsStore.ts");
  const mockRes = () => {
    const r: any = { statusCode: 200, body: null };
    r.status = (c: number) => {
      r.statusCode = c;
      return r;
    };
    r.json = (b: any) => {
      r.body = b;
      return r;
    };
    return r;
  };

  const forbidden = mockRes();
  await copilotMarketingListSaveHandler(
    { user: { role: "salesperson" }, body: { name: "x", filters: { channel: "sms" } } } as any,
    forbidden as any
  );
  ok(forbidden.statusCode === 403, "saving a list is manager-only");

  const noName = mockRes();
  await copilotMarketingListSaveHandler(
    { user: { role: "manager" }, body: { filters: { channel: "sms" } } } as any,
    noName as any
  );
  ok(noName.statusCode === 400, "a list must be named");

  const badChannel = mockRes();
  await copilotMarketingListSaveHandler(
    { user: { role: "manager" }, body: { name: "x", filters: { channel: "fax" } } } as any,
    badChannel as any
  );
  ok(badChannel.statusCode === 400, "the channel is validated on save exactly as on build");

  const contactsBefore = listContacts().length;
  const saveRes = mockRes();
  await copilotMarketingListSaveHandler(
    {
      user: { role: "manager" },
      body: {
        name: "Touring shoppers",
        description: "everyone asking about touring bikes",
        filters: { channel: "sms", modelQuery: "touring" }
      }
    } as any,
    saveRes as any
  );
  ok(saveRes.statusCode === 200, `the save succeeds (got ${saveRes.statusCode})`);

  // POSITIVE FIRST: the fixture must actually produce members, or everything below is vacuous.
  ok(saveRes.body?.saved?.total > 0, "the endpoint fixture must produce members, or these assertions are vacuous");
  ok(
    saveRes.body.saved.total < 3,
    "the modelQuery must actually FILTER — a save that swept all three seeded leads proves nothing"
  );

  // THE ACCEPTANCE CRITERION: the saved list's size equals the number reported to the user.
  const savedList = getContactList(saveRes.body.list.id);
  ok(
    (savedList?.contactIds ?? []).length === saveRes.body.saved.total,
    `the saved list size (${(savedList?.contactIds ?? []).length}) must equal the reported total (${saveRes.body.saved.total})`
  );
  ok(savedList?.source === "snapshot", "the endpoint saves a snapshot");
  ok(!savedList?.filter, "the endpoint's saved list carries no filter — it cannot start re-resolving");
  ok(savedList?.description === "everyone asking about touring bikes", "the description is stored for provenance");
  ok(
    listContacts().length === contactsBefore + saveRes.body.saved.created,
    "contacts created at SAVE equals the number reported as created"
  );
  ok(
    typeof saveRes.body.excluded?.suppressed === "number",
    "the compliance exclusion counts come back with the save, as they do on the preview"
  );

  // COMPLIANCE CANNOT BE POSTED AROUND. The exclusions live in buildMarketingList, so the handler
  // rebuilds the audience server-side and must ignore any rows a client sends. Without this
  // assertion a handler that trusted `req.body.rows` would pass everything above — measured: that
  // exact sabotage went undetected until this case existed.
  const smuggled = mockRes();
  await copilotMarketingListSaveHandler(
    {
      user: { role: "manager" },
      body: {
        name: "Smuggled",
        filters: { channel: "sms", modelQuery: "touring" },
        rows: [
          { convId: "smuggled-1", leadKey: "+15550001111", name: "Not In The Audience", phone: "+15550001111", email: "smuggled@example.com", source: null, modelInterest: null, lastInboundAt: null, status: "open" }
        ]
      }
    } as any,
    smuggled as any
  );
  ok(smuggled.statusCode === 200, "the save still succeeds when a client sends rows");
  const smuggledList = getContactList(smuggled.body.list.id);
  ok(
    !listContacts().some(c => String(c.phone ?? "") === "+15550001111"),
    "a row POSTED by the client is never turned into a contact — the audience is rebuilt server-side"
  );
  ok(
    (smuggledList?.contactIds ?? []).length === saveRes.body.saved.total,
    "and the saved membership is the server-built audience, identical to the same filters without posted rows"
  );
}

console.log(`copilot_list_save_eval: PASS (${n} assertions)`);
