/**
 * inventory_note_reply_fallback:eval — a promotion typed onto the MODEL has to reach a customer
 * asking about that model, not only the one whose record points at the exact unit it was typed on.
 *
 * THE MISS (Joe, 2026-08-08: "The agent should check the notes on the inventory page as well").
 * Measured on the live americanharley store the same night. Joe entered, on 2026-08-01T16:10-16:12Z
 * with `expiresAt` 2026-08-31 (still live):
 *
 *     "$1,000 Credit from Harley with a dealer match. So it's a $2,000 savings"
 *
 * on SIX stock numbers — T12-26, T13-26, T37-26, T44-26, T45-26, T48-26 — every one of which
 * resolves in `inventory_snapshot.json` to a new 2026 Street Glide. Four days later TWO Street
 * Glide customers were drafted without it and staff typed it in by hand, twice, two minutes apart:
 *   - `+17165600980` — year 2026, model null, stockId "" and vin "": no unit to key on at all.
 *   - `+17165981862` — 2026 Street Glide, stockId T10-26, which carries NO note and is no longer
 *     even in the feed.
 * Neither is a comprehension miss. Both are lookup misses: the reply path called
 * `getInventoryNote(stockId, vin)` and stopped, while the PRICE path ten screens above it already
 * fell back to a year+model feed match. This pins the parity.
 *
 * THE SCOPE POLICY IS NOT NEW AND IS NOT DECIDED HERE. Borrowing a note from a unit we cannot prove
 * is the lead's own is exactly what Joe ruled on 2026-08-01 (+17736151296, Mark Walsh), and
 * `resolveInventoryNoteForReply` delegates to `collectCadenceInventoryNotes` so both that ruling and
 * the 2026-07-27 cross-year ruling keep ONE home. What this file pins is that the reply path now
 * ASKS, and that asking did not loosen either ruling.
 *
 * Fixture values are the REAL ones — the real note text, the real stock numbers, the real years —
 * written into a temp data dir so the eval is hermetic and never reads the live store.
 *
 * Deterministic throughout: this reads feed fields and a staff-entered note, never customer text.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err?.message ?? err}`);
  }
}

console.log("inventory_note_reply_fallback:eval");

/** Verbatim from the live store, 2026-08-01. */
const CREDIT_NOTE = "$1,000 Credit from Harley with a dealer match. So it's a $2,000 savings";
const EXPIRED_NOTE = "$4,000 off list price";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inv-note-reply-eval-"));
await fs.writeFile(
  path.join(dir, "inventory_notes.json"),
  JSON.stringify({
    notes: {
      // The six 2026 Street Glides Joe tagged (two are enough to prove the fallback).
      "t12-26": { notes: [{ id: "n1", label: "$1,000 Credit", note: CREDIT_NOTE, updatedAt: "2026-08-01T16:10:17.161Z", expiresAt: "2026-08-31" }], updatedAt: "2026-08-01T16:10:17.161Z" },
      "t13-26": { notes: [{ id: "n2", label: "$1,000 Credit", note: CREDIT_NOTE, updatedAt: "2026-08-01T16:10:31.581Z" }], updatedAt: "2026-08-01T16:10:31.581Z" },
      // An EXPIRED promo on another unit — must never surface through the fallback.
      "s9-25": { notes: [{ id: "n3", label: "2025 Promotion", note: EXPIRED_NOTE, updatedAt: "2026-05-21T23:56:24.334Z", expiresAt: "2026-06-30" }], updatedAt: "2026-05-21T23:56:24.334Z" }
    },
    savedAt: "2026-08-01T16:12:33.805Z"
  })
);
process.env.DATA_DIR = dir;

const { resolveInventoryNoteForReply, getInventoryNote } = await import("../services/api/src/domain/inventoryNotes.js");

/** The feed rows for "2026 Street Glide", shaped as `findInventoryMatches` returns them. */
const SG_2026 = [
  { stockId: "T12-26", vin: null, year: "2026", condition: "new" },
  { stockId: "T13-26", vin: null, year: "2026", condition: "new" }
];
const BREAKOUT_2025 = [{ stockId: "S9-25", vin: null, year: "2025", condition: "new" }];

await check("BASELINE: the bare per-unit read still misses it — this is the bug, not a strawman", async () => {
  const own = await getInventoryNote("T10-26", "1HD1KB716TB605253");
  assert.equal(own, null, "T10-26 carries no note, which is exactly why the reply path found nothing");
});

await check("THE FIX: a 2026 Street Glide lead whose own unit has no note now gets the model's promo", async () => {
  const note = await resolveInventoryNoteForReply({
    stockId: "T10-26",
    vin: "1HD1KB716TB605253",
    fallbackItems: SG_2026,
    model: "Street Glide",
    leadYear: "2026",
    leadCondition: null
  });
  assert.equal(note, CREDIT_NOTE, "the same-year, no-condition-conflict case reads plain");
});

await check("the lead's OWN unit still wins outright — no attribution, no borrowing", async () => {
  const note = await resolveInventoryNoteForReply({
    stockId: "T12-26",
    vin: null,
    fallbackItems: SG_2026,
    model: "Street Glide",
    leadYear: "2026",
    leadCondition: null
  });
  assert.equal(note, CREDIT_NOTE, "unchanged behavior when the note is on the lead's own unit");
});

await check("FAIL-SAFE: no model resolved => no promo, which is the +17165600980 shape", async () => {
  const note = await resolveInventoryNoteForReply({
    stockId: "",
    vin: "",
    fallbackItems: [],
    model: null,
    leadYear: "2026",
    leadCondition: null
  });
  assert.equal(note, null, "with no model we cannot know which promo applies; stay silent");
});

await check("FAIL-SAFE: an empty feed match — any feed hiccup — yields no note, never a guess", async () => {
  const note = await resolveInventoryNoteForReply({
    stockId: "T10-26",
    vin: null,
    fallbackItems: [],
    model: "Street Glide",
    leadYear: "2026",
    leadCondition: null
  });
  assert.equal(note, null, "no feed rows means nothing to borrow from");
});

await check("Joe 2026-07-27 + 2026-08-01 SURVIVE: a 2019 lead does not read the 2026 credit as its own", async () => {
  const note = await resolveInventoryNoteForReply({
    stockId: null,
    vin: null,
    fallbackItems: SG_2026,
    model: "Street Glide",
    leadYear: "2019",
    leadCondition: "used"
  });
  assert.ok(note, "the promo is real and worth sending — Joe ruled attribute, not drop");
  assert.ok(
    String(note).includes("2026"),
    `a borrowed discount must state the model year it is on; got ${JSON.stringify(note)}`
  );
  assert.notEqual(note, CREDIT_NOTE, "it must NOT read as the customer's own 2019 bike");
});

await check("a condition conflict is attributed too — a used lead is not quietly given a new-unit credit", async () => {
  const note = await resolveInventoryNoteForReply({
    stockId: null,
    vin: null,
    fallbackItems: SG_2026,
    model: "Street Glide",
    leadYear: "2026",
    leadCondition: "used"
  });
  assert.ok(String(note ?? "").includes("new"), `the borrowed note must name the NEW unit; got ${JSON.stringify(note)}`);
});

await check("an EXPIRED promo never surfaces through the fallback", async () => {
  const note = await resolveInventoryNoteForReply({
    stockId: null,
    vin: null,
    fallbackItems: BREAKOUT_2025,
    model: "Breakout",
    leadYear: "2025",
    leadCondition: null
  });
  assert.equal(note, null, "expiresAt 2026-06-30 is past; a stale discount is a money misstatement");
});

// ---------------------------------------------------------------------------------------------
// WIRING. A passing resolver proves nothing if the reply path never calls it — and no ratchet can
// see that (the un-stack loop has been burned five times by exactly this). Read the call site.
// ---------------------------------------------------------------------------------------------
await check("WIRING: the reply path calls the resolver, and hands it a real year+model fallback", async () => {
  const src = await fs.readFile(new URL("../services/api/src/domain/orchestrator.ts", import.meta.url), "utf8");
  const at = src.indexOf("const inventoryNote = await resolveInventoryNoteForReply");
  assert.ok(at > 0, "the reply path must call resolveInventoryNoteForReply, not getInventoryNote alone");
  const callSite = src.slice(at, at + 700);
  assert.ok(callSite.includes("fallbackItems"), "the reply call site must pass fallbackItems");
  assert.ok(
    callSite.includes("findInventoryMatches"),
    "fallbackItems must come from a real year+model feed lookup, not an empty literal"
  );
  assert.ok(callSite.includes("isUnknownModel"), "an unknown model must not be looked up");
  assert.ok(callSite.includes("leadCondition"), "the condition must reach the attribution ruling");
  assert.ok(callSite.includes("leadYear"), "the year must reach the cross-year ruling");
});

await fs.rm(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\ninventory_note_reply_fallback:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("inventory_note_reply_fallback:eval passed");
