import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

type Check = {
  id: string;
  actual: unknown;
  expected: unknown;
};

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "contact-update-eval-"));
process.env.CONTACTS_DB_PATH = path.join(tempDir, "contacts.json");

const { upsertContact, updateContact } = await import(
  "../services/api/src/domain/contactsStore.ts"
);

function check(id: string, actual: unknown, expected: unknown): Check {
  return { id, actual, expected };
}

const emailOnly = upsertContact({
  firstName: "Email",
  lastName: "Only",
  name: "Email Only",
  email: "OLD@EXAMPLE.COM",
  leadKey: "old@example.com",
  conversationId: "old@example.com"
});

const phoneOnly = updateContact(emailOnly.id, {
  email: "",
  phone: "716-692-7200"
});

const preserveEmail = upsertContact({
  firstName: "Keep",
  email: "keep@example.com",
  phone: "7165550101",
  leadKey: "keep@example.com"
});
const renamed = updateContact(preserveEmail.id, { firstName: "Kept" });

const checks: Check[] = [
  check("converted_contact_exists", Boolean(phoneOnly), true),
  check("converted_email_cleared", phoneOnly?.email, undefined),
  check("converted_phone_normalized", phoneOnly?.phone, "+17166927200"),
  check("converted_lead_key_moves_to_phone", phoneOnly?.leadKey, "+17166927200"),
  check("unmentioned_email_preserved", renamed?.email, "keep@example.com"),
  check("unmentioned_phone_preserved", renamed?.phone, "+17165550101")
];

let passed = 0;
for (const c of checks) {
  const ok = JSON.stringify(c.actual) === JSON.stringify(c.expected);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}`);
}

if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} failures out of ${checks.length} contact update checks`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} contact update checks passed.`);
