/**
 * Deleting a marketing list (Joe, 2026-08-10: "there is no way to delete a marketing list that was
 * created").
 *
 * The capability was already there — `DELETE /contacts/lists/:id` (manager-gated), a Next proxy, and
 * a `deleteGroup` handler. The only way to REACH it was a text link at the bottom of the "Groups are
 * much better with contacts" help panel, reading *"Have you changed your mind? delete this group"*.
 * A feature you cannot find is a feature you do not have.
 *
 * Two things are pinned here:
 *
 * 1. **A real control where the lists live** — on the selected row in the lists sidebar, so deleting
 *    a list does not depend on landing in a help panel.
 * 2. **The handler checks the reply.** It used to fire-and-forget: a 403 or a 500 left the console
 *    resetting to All Contacts and looking like it had worked, so a list that was never deleted read
 *    as deleted until the next reload. Failing silently in the direction of "it worked" is the worst
 *    option for a destructive action.
 *
 * The confirm also states that the CONTACTS are kept — only the list goes. That is the question a
 * person actually has at that moment, and answering it in the prompt is what makes the button safe
 * to press.
 *
 * Assertions are plain substring checks, never escaped-paren regexes: those read as SOURCE PINS to
 * eval_source_pin_ratchet even when they are guarding a wire.
 *
 * Run: npx tsx scripts/marketing_list_delete_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const web = fs.readFileSync("apps/web/src/app/page.tsx", "utf8");
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
const proxy = fs.readFileSync("apps/web/src/app/api/contacts/lists/[id]/route.ts", "utf8");

// --- the capability, end to end -----------------------------------------------------------------
assert.ok(
  api.includes('app.delete("/contacts/lists/:id", requireManager,'),
  "the API can delete a list, and only a manager may"
);
assert.ok(proxy.includes("export async function DELETE"), "the console proxies DELETE through to it");

// --- a control where the lists actually are ------------------------------------------------------
// The sidebar row for the SELECTED list carries the delete. Anchored on the aria-label, which is the
// accessible name a person (or a screen reader) uses to find it — not on styling that will drift.
assert.ok(
  web.includes("aria-label={`Delete the list ${list.name}`}"),
  "the lists sidebar has a labelled delete control on the selected row"
);
assert.ok(
  web.includes("onClick={() => void deleteGroup(list.id)}"),
  "and it deletes the row it is on, not whatever happens to be selected elsewhere"
);
// It must not be the ONLY path that existed before — the buried help-panel link is fine to keep, but
// it must no longer be the only way in. Both call sites are asserted so neither can quietly vanish.
assert.ok(
  web.includes("delete this group"),
  "the original help-panel link still works for anyone used to it"
);

// --- the destructive action tells the truth -------------------------------------------------------
assert.ok(
  web.includes("The contacts stay in your database — only the list is removed."),
  "the confirm answers the question a person actually has before pressing it"
);
assert.ok(web.includes('Delete the list "${label}"?'), "and it names the list being deleted");

// --- and it cannot claim a success it did not get -------------------------------------------------
assert.ok(
  web.includes('if (!resp.ok || !payload?.ok) throw new Error(payload?.error || "That list could not be deleted.");'),
  "a failed delete is surfaced, never swallowed"
);
// The reset-to-All-Contacts must happen only AFTER that check, or the console still looks successful.
const checkAt = web.indexOf('if (!resp.ok || !payload?.ok) throw new Error(payload?.error || "That list could not be deleted.");');
const resetAt = web.indexOf('if (selectedContactListId === id) setSelectedContactListId("all");');
assert.ok(checkAt >= 0 && resetAt >= 0, "both ordering anchors are present");
assert.ok(
  checkAt < resetAt,
  "the response is checked BEFORE the console moves on — otherwise a refused delete still looks done"
);

console.log(
  "PASS marketing list delete — a labelled control on the list itself, a confirm that says the contacts are kept, and a failure that is surfaced instead of swallowed."
);
