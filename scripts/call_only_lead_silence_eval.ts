/**
 * call_only_lead_silence:eval — pins Joe's 2026-07-09 ruling (+17163804680, Steven Horton):
 * a CALL-ONLY (phone-preferred) lead gets NO auto SMS/email draft in ANY mode — including
 * suggest — and a "call customer" task instead. Before this, the phone-preferred gates in
 * sendgridInbound.ts were skipped in suggest mode, so the ADF pipeline still published an
 * SMS draft the operator had to notice and discard.
 *
 * Source-guard pins (same style as dealer_ride_initial_draft:eval):
 *  1. publishAdfDraftForPreferredContact suppresses on prefersPhoneOnly UNCONDITIONALLY
 *     (no `systemMode !== "suggest"` escape) and adds the call todo.
 *  2. The initial-ADF early return fires on prefersPhoneOnly unconditionally and adds the
 *     EXPLICIT call todo (maybeAddInitialCallTodo alone skips boilerplate day-one tasks).
 *  3. Fail-direction: both sites create a call task — silence never means "dropped".
 */
import fs from "node:fs";
import path from "node:path";

type Check = { id: string; actual: unknown; expected: unknown };
const check = (id: string, actual: unknown, expected: unknown): Check => ({ id, actual, expected });

const route = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");

// --- 1. the publish gate ---
const publishStart = route.indexOf("const publishAdfDraftForPreferredContact");
const publishBlock = publishStart >= 0 ? route.slice(publishStart, publishStart + 2400) : "";
const publishGateUnconditional =
  /if \(prefersPhoneOnly\) \{\s*\n\s*addCallTodoIfMissing\(conv, "Preferred contact method is phone\. Call customer \(no auto text\/email\)\."\);\s*\n\s*return \{ ok: false, reason: "phone_preferred" \};/.test(
    publishBlock
  );
const publishGateHasNoModeEscape = !publishBlock.includes('prefersPhoneOnly && systemMode !== "suggest"');

// --- 2. the initial-ADF early return ---
const earlyStart = route.indexOf("if (isInitialAdf && prefersPhoneOnly)");
const earlyBlock = earlyStart >= 0 ? route.slice(earlyStart, earlyStart + 900) : "";
const earlyReturnUnconditional = earlyStart >= 0 && !route.includes('isInitialAdf && prefersPhoneOnly && systemMode !== "suggest"');
const earlyReturnAddsExplicitCallTodo =
  earlyBlock.includes("maybeAddInitialCallTodo()") &&
  earlyBlock.includes('addCallTodoIfMissing(conv, "Preferred contact method is phone. Call customer (no auto text/email).")') &&
  earlyBlock.includes('note: "preferred_contact_phone_no_auto_reply"');

// --- 3. fail-direction: no remaining mode-conditioned phone-preferred gate anywhere ---
const noModeConditionedPhoneGateLeft = !/prefersPhoneOnly && systemMode/.test(route);

const checks: Check[] = [
  check("publish_gate_suppresses_phone_preferred_in_every_mode", publishGateUnconditional, true),
  check("publish_gate_has_no_suggest_mode_escape", publishGateHasNoModeEscape, true),
  check("initial_adf_early_return_is_mode_independent", earlyReturnUnconditional, true),
  check("initial_adf_early_return_creates_explicit_call_task", earlyReturnAddsExplicitCallTodo, true),
  check("no_mode_conditioned_phone_preferred_gate_remains", noModeConditionedPhoneGateLeft, true)
];

const failures = checks.filter(c => JSON.stringify(c.actual) !== JSON.stringify(c.expected));
if (failures.length) {
  console.error("FAIL call_only_lead_silence eval:");
  for (const f of failures) console.error(`  - ${f.id}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
  process.exit(1);
}
console.log(`PASS call-only lead silence eval (${checks.length} assertions) — phone-preferred leads get a call task, never an auto draft, in every mode`);
