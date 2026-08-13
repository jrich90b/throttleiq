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

console.log("lead_identity_join_eval: PASS");
