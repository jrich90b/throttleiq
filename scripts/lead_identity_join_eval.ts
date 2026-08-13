/**
 * Lead-identity join eval — a lead-feed placeholder must never make two customers one person.
 *
 * WHY THIS EXISTS (measured on the americanharley store, 2026-08-13). Walk-in and Traffic Log Pro
 * ADF leads arrive with a literal `Email: n/a` line, and `lead.email` kept it verbatim. The
 * conversation join matched on that string, so 11 unrelated customers were one identity ("n/a"),
 * plus 5 under "na@na.com" and 3 under "na". The join drives `stopRelatedCadences`, so the damage
 * was silent and cross-customer: FOUR conversations carried
 * `followUpCadence.stopReason === "appointment_booked"` while owning no appointment. Tom Balko
 * (+17164656440, a live trade lead) had his follow-up killed 47 seconds after a DIFFERENT customer,
 * Paul Harrigan (+17169467451), booked a test ride.
 *
 * Deterministic; no LLM. Executes the real predicate and the real join — a source-text assertion
 * could not tell a live join from a dead one.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const { isNonIdentifyingLeadEmail, resolveLeadIdentity, findRelatedConversations } = await import(
  "../services/api/src/domain/leadIdentity.ts"
);

// The same normalizePhone index.ts injects, so the eval measures the shipped behaviour.
function normalizePhone(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return trimmed;
}

// --- 1. The predicate: what a feed writes when it has no address ---
for (const placeholder of ["n/a", "N/A", " na ", "NA", "none", "unknown", "tbd", "-", ""]) {
  assert.equal(
    isNonIdentifyingLeadEmail(placeholder),
    true,
    `placeholder ${JSON.stringify(placeholder)} must not identify a customer`
  );
}
// Placeholder addresses that are well-formed but still nobody.
for (const placeholder of ["na@na.com", "NONE@none.com", "noemail@noemail.com"]) {
  assert.equal(
    isNonIdentifyingLeadEmail(placeholder),
    true,
    `${placeholder} is a filler address, not a customer`
  );
}
// Shape check catches novel wordings the deny-set never saw. "@example.com" is here because it is
// the ONLY one of these that the domain-dot check alone would wave through — a missing local part
// is a distinct failure and needs its own case, or the local-part clause tests as dead code.
for (const junk of ["no e-mail on file", "@example.com", "@nodomain", "trailing@", "dot@missing"]) {
  assert.equal(isNonIdentifyingLeadEmail(junk), true, `${junk} is not an address`);
}
// Real addresses must survive — including plus-tags and subdomains.
for (const real of ["blpricesr2@gmail.com", "Tom.Balko+hd@mail.example.co.uk", "a@b.io"]) {
  assert.equal(isNonIdentifyingLeadEmail(real), false, `${real} is a real address`);
}

// --- 2. Identity resolution drops the placeholder but keeps the phone ---
const walkIn = { id: "+17164656440", leadKey: "+17164656440", lead: { email: "n/a", phone: "7164656440" } };
const walkInIdentity = resolveLeadIdentity(walkIn, undefined, normalizePhone);
assert.equal(walkInIdentity.email, undefined, "an n/a lead has no email identity");
assert.equal(walkInIdentity.phone, "+17164656440", "the phone identity must be untouched");

// A conversation whose leadKey IS an email keeps it.
const emailLead = { id: "russ", leadKey: "r47stark@gmail.com", lead: {} };
assert.equal(
  resolveLeadIdentity(emailLead, undefined, normalizePhone).email,
  "r47stark@gmail.com",
  "an email leadKey is still an identity"
);

// --- 3. The join: the live 2026-08-11 shape ---
const store: any[] = [
  // Paul booked a test ride. Tom and Mike are different people; all three are walk-in ADFs.
  { id: "+17169467451", leadKey: "+17169467451", lead: { name: "Paul Harrigan", email: "n/a", phone: "7169467451" } },
  { id: "+17164656440", leadKey: "+17164656440", lead: { name: "Tom Balko", email: "n/a", phone: "7164656440" } },
  { id: "+17165702519", leadKey: "+17165702519", lead: { name: "Mike Marcaccio", email: "n/a", phone: "7165702519" } },
  // A genuine cross-channel pair: same real address, one email thread and one SMS thread.
  { id: "email-zeb", leadKey: "zebsolo@gmail.com", lead: { name: "Zebediah Hare", email: "zebsolo@gmail.com" } },
  { id: "+17165155413", leadKey: "+17165155413", lead: { name: "Zebediah Hare", email: "zebsolo@gmail.com", phone: "7165155413" } },
  // A genuine same-phone duplicate journey.
  { id: "dup-a", leadKey: "+17163741119", lead: { email: "n/a", phone: "7163741119" } }
];

const paul = store[0];
const paulRelated = findRelatedConversations(paul, store, undefined, normalizePhone).map(c => c.id);
assert.deepEqual(
  paulRelated,
  [],
  `a booking must not reach another customer's thread; joined: ${JSON.stringify(paulRelated)}`
);

const tomRelated = findRelatedConversations(store[1], store, undefined, normalizePhone).map(c => c.id);
assert.deepEqual(tomRelated, [], "Tom Balko is not Paul Harrigan");

// --- 4. The joins that MUST still happen (this is not a licence to stop linking people) ---
const zebEmailThread = store[3];
const zebRelated = findRelatedConversations(zebEmailThread, store, undefined, normalizePhone).map(c => c.id);
assert.deepEqual(zebRelated, ["+17165155413"], "a real shared address still links the two threads");

const zebSmsThread = store[4];
const zebBack = findRelatedConversations(zebSmsThread, store, undefined, normalizePhone).map(c => c.id);
assert.deepEqual(zebBack, ["email-zeb"], "the link is symmetric");

const dupB = { id: "dup-b", leadKey: "+17163741119", lead: { email: "n/a", phone: "7163741119" } };
const dupRelated = findRelatedConversations(dupB, [...store, dupB], undefined, normalizePhone).map(c => c.id);
assert.deepEqual(dupRelated, ["dup-a"], "same phone still joins even when both emails are placeholders");

// --- 5. A conversation with nothing identifying joins nothing ---
const anonymous = { id: "anon", leadKey: "", lead: { email: "n/a" } };
assert.deepEqual(
  findRelatedConversations(anonymous, store, undefined, normalizePhone),
  [],
  "no identity means no related conversations, never everything"
);

// --- 6. A DEALER'S OWN ADDRESS IS NOT A CUSTOMER'S (2026-08-13, Joe: "those emails should not
//        be in the customers lead") -------------------------------------------------------------
//
// Measured on the live store the day #686 shipped: `gio@<dealer-domain>` — a rep's work address,
// listed in the dealership's own staff roster — sat in `lead.email` on 18 unrelated customers fed
// by Kenect and AutoDealers.Digital. It is a real, well-formed address, so no placeholder test can
// catch it; only the dealer's own records can. 16 of the 18 were closed and 12 carried the
// `cross_channel:` fingerprint of this join firing across them.
//
// The contacts come from `collectDealerContacts` — the SAME builder the leak audit uses — so this
// asserts the shipped path, and nothing here hardcodes a dealer domain.
const { collectDealerContacts } = await import("../services/api/src/domain/crossLeadLeak.ts");

const dealerContacts = collectDealerContacts({
  // The second user is staff whose roster address is NOT on the dealer's own domain — a real shape
  // (an owner using a personal address), and the reason the roster matters at all.
  users: [{ email: "gio@examplehd.com", phone: "" }, { email: "ownerbob@outsidehost.net", phone: "" }],
  dealerProfile: { fromEmail: "sales@examplehd.com", website: "https://www.examplehd.com" }
});

const feedVictims = [
  { id: "+15550001111", leadKey: "+15550001111", lead: { email: "gio@examplehd.com", phone: "5550001111", source: "Kenect - Kenect Leads" } },
  { id: "+15550002222", leadKey: "+15550002222", lead: { email: "gio@examplehd.com", phone: "5550002222", source: "AutoDealers.Digital" } },
  { id: "+15550003333", leadKey: "+15550003333", lead: { email: "GIO@ExampleHD.com", phone: "5550003333", source: "Kenect - Kenect Leads" } },
  // a shared box nobody's roster lists — caught by the dealer's own published domain
  { id: "+15550004444", leadKey: "+15550004444", lead: { email: "finance@examplehd.com", phone: "5550004444" } },
  // a REAL customer, same store, must be untouched
  { id: "+15550005555", leadKey: "+15550005555", lead: { email: "realbuyer@gmail.com", phone: "5550005555" } },
  { id: "email-realbuyer", leadKey: "realbuyer@gmail.com", lead: { email: "realbuyer@gmail.com" } }
];

for (const victim of feedVictims.slice(0, 4)) {
  const joined = findRelatedConversations(victim, feedVictims, undefined, normalizePhone, dealerContacts).map(c => c.id);
  assert.deepEqual(
    joined,
    [],
    `a dealer address must not make ${victim.id} the same person as anyone; joined: ${JSON.stringify(joined)}`
  );
  assert.equal(
    resolveLeadIdentity(victim, undefined, normalizePhone, dealerContacts).email,
    undefined,
    `a dealer address must not IDENTIFY ${victim.id}`
  );
}

// Case must not matter — the feed writes it however it likes.
//
// MEASURED while sabotage-testing: removing the `.toLowerCase()` from `isDealerOwnedEmail`'s
// exact-address lookup does NOT fail anything, and that is correct rather than a hole in this
// eval. `collectDealerContacts` registers every roster address's DOMAIN alongside the address, so
// the domain set — which lowercases on its own — always decides first. The lowercase on the email
// lookup is redundant defence, kept because a future contacts builder that stops adding domains
// would need it. Do not "fix" this by contriving an address whose domain is absent; by
// construction there isn't one.
assert.equal(
  resolveLeadIdentity(feedVictims[2], undefined, normalizePhone, dealerContacts).email,
  undefined,
  "the dealer check is case-insensitive"
);
for (const spelling of ["ownerbob@outsidehost.net", "OwnerBob@OutsideHost.net", "OWNERBOB@OUTSIDEHOST.NET"]) {
  const staffOffDomain = { id: `staff-${spelling}`, leadKey: "+15550007777", lead: { email: spelling, phone: "5550007777" } };
  assert.equal(
    resolveLeadIdentity(staffOffDomain, undefined, normalizePhone, dealerContacts).email,
    undefined,
    `a roster address off the dealer's own domain is still the dealer's, however spelled: ${spelling}`
  );
}

// The real customer still links across their own two threads.
const realJoined = findRelatedConversations(feedVictims[4], feedVictims, undefined, normalizePhone, dealerContacts).map(c => c.id);
assert.deepEqual(realJoined, ["email-realbuyer"], "a real customer's address still links their threads");

// The COLD-BOOT state is the fail-direction promise, so it is pinned rather than assumed.
// `dealerContacts` now DEFAULTS to the live snapshot, so this passes the empty set explicitly:
// that is exactly what a cold process, a failed roster read, or a disabled refresh produces, and
// it must behave precisely as the code did before the dealer check existed — never MORE aggressive.
const { EMPTY_DEALER_CONTACTS } = await import("../services/api/src/domain/crossLeadLeak.ts");
const unguarded = findRelatedConversations(
  feedVictims[0], feedVictims, undefined, normalizePhone, EMPTY_DEALER_CONTACTS
).map(c => c.id);
assert.deepEqual(
  unguarded,
  ["+15550002222", "+15550003333"],
  "an empty snapshot (cold boot) degrades to the pre-2026-08-13 behaviour, not to something new"
);
assert.equal(
  resolveLeadIdentity(feedVictims[0], undefined, normalizePhone, EMPTY_DEALER_CONTACTS).email,
  "gio@examplehd.com",
  "with no dealer records loaded, a dealer address still identifies exactly as it used to"
);

// A customer whose address merely CONTAINS the dealer domain as a substring is still a customer.
const lookalike = { id: "+15550006666", leadKey: "+15550006666", lead: { email: "someone@notexamplehd.com.au", phone: "5550006666" } };
assert.equal(
  resolveLeadIdentity(lookalike, undefined, normalizePhone, dealerContacts).email,
  "someone@notexamplehd.com.au",
  "domain matching is exact, not substring — a lookalike domain is still a customer"
);

// --- 7. WIRING — the ratchet cannot prove this, so pin it directly -------------------------------
//
// The guarantee is NOT "every call site remembers to pass dealer contacts" — that is the kind of
// wiring that rots the moment someone adds a fourth consumer. It is that the argument DEFAULTS to
// the live snapshot, so a call site cannot forget it, and that the snapshot refreshes ITSELF so
// nothing has to be wired at boot or on the inbound paths. index.ts is deliberately untouched by
// this change; asserting on call sites there would pin the opposite of the design.
const identitySrc = readFileSync(new URL("../services/api/src/domain/leadIdentity.ts", import.meta.url), "utf8");
const DEFAULTED = "dealerContacts: DealerContacts = getDealerContactsSnapshot()";
assert.equal(
  identitySrc.split(DEFAULTED).length - 1,
  2,
  "BOTH resolveLeadIdentity and findRelatedConversations must default to the live snapshot (expected 2)"
);
assert.equal(
  identitySrc.includes("isDealerOwnedEmail(text, dealerContacts)"),
  true,
  "the dealer check must run inside the identity resolution itself"
);

const snapshotSrc = readFileSync(new URL("../services/api/src/domain/dealerContactsSnapshot.ts", import.meta.url), "utf8");
assert.equal(
  snapshotSrc.includes("if (Date.now() >= expiresAt) void refreshDealerContactsSnapshot();"),
  true,
  "a stale read must trigger its own refresh — that is what removes the need for any wiring"
);
// One definition of "the dealer's contacts", shared with the leak audit rather than re-derived.
assert.equal(
  snapshotSrc.includes('from "./crossLeadLeak.js"'),
  true,
  "the snapshot must be built by collectDealerContacts, not a second hand-rolled roster reader"
);
// Portability: nothing here may name a dealer. The contacts come from that dealer's own records.
for (const src of [identitySrc, snapshotSrc]) {
  assert.equal(
    /americanharley|harley-davidson\.com/i.test(src.replace(/^\s*\*.*$/gm, "")),
    false,
    "no dealer domain may be hardcoded in the identity path — it comes from the dealer's own records"
  );
}

console.log("lead_identity_join_eval: PASS");
