/**
 * Pins the per-dealer voice miner's ONE load-bearing decision: which staff edits are eligible to
 * teach the agent a dealer's voice, and which must never be.
 *
 * The failure this guards against is not a crash — it is teaching the agent to INVENT FACTS. A
 * staff "edit" is two different things wearing one name: a TWEAK (the rep reworded our draft) and
 * a REPLACEMENT (the rep threw it out and typed something only a human could know — "it's an out
 * of state sale so no NYS tax"). Promote replacements as voice examples and the drafter learns to
 * assert out-of-band facts. Fail direction is therefore explicit: when in doubt, DROP.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-edit-eval-"));
const convPath = path.join(tempDir, "conversations.json");
const nowIso = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

function outbound(draft: string, sent: string, at: string) {
  return {
    direction: "out",
    provider: "twilio",
    at,
    originalDraftBody: draft,
    body: sent,
    actorUserName: "Joe Hartrich"
  };
}

const store = {
  conversations: [
    {
      // TWEAK — reworded, same meaning. This is the voice signal we want.
      id: "+17160000101",
      messages: [
        { direction: "in", provider: "twilio", at: nowIso(2), body: "Any word on that Street Glide?" },
        outbound(
          "I'll keep an eye on the 2026 FLHXSE CVO Street Glide we've got coming in and let you know as soon as it's here.",
          "I'll keep an eye on it and let you know as soon as it's here.",
          nowIso(2)
        )
      ]
    },
    {
      // REPLACEMENT — the rep knew something we cannot: tax status of an out-of-state sale.
      // Must be dropped, or the drafter learns to assert tax rules it has no basis for.
      id: "+17160000102",
      messages: [
        { direction: "in", provider: "twilio", at: nowIso(3), body: "What would my out the door be?" },
        outbound(
          "Happy to get you an out-the-door number — let me check with our finance team on the exact figure.",
          "Since it's an out of state sale there's no NYS tax, so your out the door is just the unit price plus doc fee.",
          nowIso(3)
        )
      ]
    },
    {
      // TWEAK carrying a scheduling ask — must land in the scheduling bucket, not general.
      id: "+17160000103",
      messages: [
        { direction: "in", provider: "twilio", at: nowIso(4), body: "Could I come in Saturday for a test ride?" },
        outbound(
          "If the test ride for the Road Glide is still on your list, I can absolutely get that set up quickly for you.",
          "If the test ride for the Road Glide is still on your list, I can get it set up quick.",
          nowIso(4)
        )
      ]
    },
    {
      // Outside the window — recency matters, a dealer's voice drifts.
      id: "+17160000104",
      messages: [
        { direction: "in", provider: "twilio", at: nowIso(400), body: "Still thinking about it" },
        outbound("No rush at all, take your time.", "No rush, take your time.", nowIso(400))
      ]
    },
    {
      // SHIPPED FIX — a rep typing the OLD intro back in. Joe ruled "I'd rather see over at"
      // (2026-07-29). Promoting this would put a reversal of his ruling in the draft prompt.
      id: "+17160000105",
      messages: [
        { direction: "in", provider: "twilio", at: nowIso(5), body: "Do you have the Sportster S?" },
        outbound(
          "Hey Shamsher, it's Alexandra over at American Harley-Davidson. I'm not seeing one in stock right now.",
          "Hey Shamsher, it's Alexandra at American Harley-Davidson. I'm not seeing one in stock right now.",
          nowIso(5)
        )
      ]
    },
    {
      // SHIPPED FIX — the delta changes a FACT (the model), not the phrasing. A voice edit
      // rearranges our words; it never renames the bike.
      id: "+17160000106",
      messages: [
        { direction: "in", provider: "twilio", at: nowIso(6), body: "Any word on that one?" },
        outbound(
          "Yes, they are supposed to be coming back out with the Iron 883. I'll text you when we see one.",
          "Yes, they are supposed to be coming back out with the Sportster. I'll text you when we see one.",
          nowIso(6)
        )
      ]
    }
  ],
  todos: []
};
fs.writeFileSync(convPath, JSON.stringify(store));

const scriptPath = path.join(import.meta.dirname ?? ".", "voice_edit_examples_mine.ts");
execFileSync("npx", ["tsx", scriptPath, "--since-days", "90"], {
  env: { ...process.env, CONVERSATIONS_DB_PATH: convPath, VOICE_EDIT_OUT_DIR: tempDir },
  stdio: "pipe"
});

const out = JSON.parse(
  fs.readFileSync(path.join(tempDir, "manual_reply_examples.candidates.json"), "utf8")
);
const all = Object.values(out.byIntent as Record<string, any[]>).flat();
const replies = all.map(r => r.reply);

assert.equal(out.shadow, true, "miner must declare itself shadow — it never writes the live file");
assert.equal(out.summary.editsSeen, 6, "all six edits should be counted as seen");
assert.equal(out.summary.outsideWindow, 1, "the 400-day-old edit is outside the window");

// The load-bearing assertion, both directions.
assert.ok(
  replies.some(r => r.includes("keep an eye on it")),
  "a genuine reword (TWEAK) must be eligible as a voice example"
);
assert.ok(
  !replies.some(r => r.includes("no NYS tax")),
  "a REPLACEMENT carrying out-of-band knowledge must never become a voice example"
);
assert.equal(out.summary.replacementsDropped, 1, "exactly the out-of-band reply is dropped");

// Gate 2 — a tweak can be clean by containment and still be the wrong thing to teach.
assert.ok(
  !replies.some(r => /it's Alexandra at American/i.test(r)),
  "an intro reverted off the canonical 'over at' must never become a voice example (Joe 7/29)"
);
assert.ok(
  !replies.some(r => r.includes("coming back out with the Sportster")),
  "an edit whose delta changes a FACT (the model) is a correction, not voice"
);
assert.equal(out.summary.shippedFixDropped, 2, "both shipped-fix edits are dropped");
assert.equal(out.summary.shippedFixByReason.intro_over_at, 1, "the intro reversion is named");
assert.equal(out.summary.shippedFixByReason.fact_changed, 1, "the model rename is named");

// Bucketing: a promoted example is only useful if the drafter looks in the right bucket.
assert.ok(
  (out.byIntent.scheduling ?? []).some((r: any) => r.reply.includes("get it set up quick")),
  "a scheduling tweak must land in the scheduling bucket"
);

// The cap is the prompt's budget, not a suggestion.
for (const [intent, rows] of Object.entries(out.byIntent as Record<string, any[]>)) {
  assert.ok(rows.length <= 6, `${intent} exceeded maxPerIntent`);
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(
  `voice_edit_examples:eval OK — tweak kept, out-of-band replacement dropped, buckets + cap pinned`
);
