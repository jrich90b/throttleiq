/**
 * Appointment/stop-in invite A/B eval (2026-06-14).
 *
 * Pins the cadence-invite experiment so it stays behavior-safe:
 *  1. `decideCadenceInviteArm` (routeStateReducer) is PURE, deterministic, and a
 *     ~50/50 split — the property the offline report relies on to recompute each
 *     conversation's arm with no message tagging.
 *  2. The CHALLENGER invite copy preserves the control invite's state-signal class
 *     (every string carries a `draftHasSchedulingPrompt` token so the live tick
 *     still fires `registerScheduleInviteSent`), is Voice-Charter clean, has zero
 *     em-dashes, and renders cleanly in both model-label states.
 *  3. The arm gates BOTH the live cadence tick AND the regenerate path (source
 *     pins), so live/regen can never drift to different invite copy for a lead.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { decideCadenceInviteArm } from "../services/api/src/domain/routeStateReducer.ts";
import { checkMessage } from "./voice_charter_audit.ts";

// Copy of `draftHasSchedulingPrompt` (services/api/src/index.ts) — pinned below.
const SCHEDULING_RE =
  /(what day|what time|when.*available|schedule|appointment|come in|stop by|stop in|book|reserve|test ride|demo ride|which works best)/i;

// 1) Arm assignment: pure, deterministic, ~50/50, empty -> control.
{
  assert.equal(decideCadenceInviteArm(""), "control", "empty id -> control");
  for (const id of ["conv_abc", "conv_123", "lead-xyz", "9f746123"]) {
    const a = decideCadenceInviteArm(id);
    for (let i = 0; i < 50; i++) {
      assert.equal(decideCadenceInviteArm(id), a, `arm must be stable for ${id}`);
    }
    assert.ok(a === "control" || a === "challenger", "arm is one of the two values");
  }
  let challenger = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    if (decideCadenceInviteArm(`conv_${i}_${(i * 2654435761) >>> 0}`) === "challenger") challenger++;
  }
  const share = challenger / N;
  assert.ok(share > 0.45 && share < 0.55, `split should be ~50/50, got ${(share * 100).toFixed(1)}%`);
}

// Source of truth for the banks + wiring.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

function quotedStrings(block: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) if (m[1].length >= 12) out.push(m[1]);
  return out;
}

// Slice a single `const NAME ... <endMarker>` declaration and pull its strings.
function extractDecl(name: string, endMarker: string): string[] {
  const start = apiSource.indexOf(`const ${name}`);
  assert.ok(start >= 0, `bank ${name} must exist in index.ts`);
  const end = apiSource.indexOf(endMarker, start);
  assert.ok(end > start, `bank ${name} must close with ${JSON.stringify(endMarker)}`);
  const out = quotedStrings(apiSource.slice(start, end + endMarker.length));
  assert.ok(out.length > 0, `bank ${name} must contain template strings`);
  return out;
}

function render(template: string, withLabel: boolean): string {
  const ctx: Record<string, string> = {
    name: "Sam",
    label: withLabel ? " the 2024 Road Glide" : " a model",
    labelClause: withLabel ? " about the 2024 Road Glide" : "",
    onLabelClause: withLabel ? " on the 2024 Road Glide" : "",
    forLabelClause: withLabel ? " for the 2024 Road Glide" : "",
    extraLine: "",
    a: "Saturday 10am",
    b: "Sunday 1pm"
  };
  let out = template;
  for (const [k, v] of Object.entries(ctx)) out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  return out.replace(/\s+/g, " ").trim();
}

// 2) Challenger copy quality + signal-class preservation.
const challengerStrings = [
  ...extractDecl("FOLLOW_UP_VARIANTS_WITH_SLOTS_CHALLENGER", "\n];"),
  ...extractDecl("FOLLOW_UP_VARIANTS_NO_SLOTS_CHALLENGER", "\n};"),
  ...extractDecl("FOLLOW_UP_INVITE_BASE_CHALLENGER", '";')
];
assert.ok(challengerStrings.length >= 5, "challenger banks should have several invite strings");

for (const template of challengerStrings) {
  assert.ok(!template.includes("—"), `no em-dashes in challenger invite: "${template}"`);
  for (const withLabel of [true, false]) {
    const rendered = render(template, withLabel);
    assert.ok(!rendered.includes("{"), `unrendered placeholder in: "${rendered}"`);
    assert.ok(!/\bthe the\b/i.test(rendered), `doubled article in: "${rendered}"`);
    assert.ok(
      !/\s(?:on|for)\s+(?:and|so)\s|\s(?:on|for)[?.!,]|\b(?:on|for) about\b/.test(rendered),
      `dangling clause grammar in: "${rendered}"`
    );
    assert.ok(
      SCHEDULING_RE.test(rendered),
      `challenger invite must keep its scheduling-prompt signal: "${rendered}"`
    );
    const violations = checkMessage(rendered, { firstOutbound: false, smsLike: true, staffHasSent: false });
    assert.deepEqual(violations, [], `charter violation(s) ${JSON.stringify(violations)} in: "${rendered}"`);
  }
}

// 3) Wiring pins: arm computed in BOTH cadence builders, gating each invite site.
const armUses = (apiSource.match(/decideCadenceInviteArm\(conv\.id\)/g) ?? []).length;
assert.ok(armUses >= 2, `decideCadenceInviteArm(conv.id) must be used in live + regen (found ${armUses})`);
assert.match(
  apiSource,
  /inviteArm === "challenger"\s*\n\s*\?\s*FOLLOW_UP_VARIANTS_WITH_SLOTS_CHALLENGER/,
  "live with-slots step-0 invite must be arm-gated"
);
assert.match(
  apiSource,
  /step === 4 && inviteArm === "challenger"\s*\n\s*\?\s*FOLLOW_UP_VARIANTS_NO_SLOTS_CHALLENGER\[4\]/,
  "live no-slots step-4 invite must be arm-gated"
);
assert.match(
  apiSource,
  /lastSentStep === 4 && inviteArm === "challenger"\s*\n\s*\?\s*FOLLOW_UP_VARIANTS_NO_SLOTS_CHALLENGER\[4\]/,
  "regen no-slots step-4 invite must be arm-gated"
);
assert.match(
  apiSource,
  /lastSentStep === 4 && inviteArm === "challenger"\s*\n\s*\?\s*FOLLOW_UP_INVITE_BASE_CHALLENGER/,
  "regen base-fallback step-4 invite must be arm-gated"
);

// 4) Pin the scheduling-prompt detector copy used above.
assert.match(
  apiSource,
  /function draftHasSchedulingPrompt\(text: string\): boolean \{\s*return \/\(what day\|what time\|when\.\*available\|schedule\|appointment\|come in\|stop by\|stop in\|book\|reserve\|test ride\|demo ride\|which works best\)\/i/,
  "draftHasSchedulingPrompt regex changed; update SCHEDULING_RE copy in this eval"
);

console.log(`PASS cadence invite A/B eval (${challengerStrings.length} challenger strings, ${armUses} arm sites)`);
