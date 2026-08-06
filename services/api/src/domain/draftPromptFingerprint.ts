/**
 * Draft prompt fingerprint — the instrument that splits "the model sampled differently" from
 * "we handed it a different prompt".
 *
 * WHY. Measured on a frozen store snapshot 2026-08-06: replaying the SAME customer turn through the
 * SAME configuration produces a materially different reply about 7% of the time on conversational
 * turns (21% on lead forms). One run worked a price objection —
 *   "I can run numbers. What monthly payment are you trying to stay around, 60, 72, or 84 months?"
 * — and the next parked the deal —
 *   "I'll have the team review the details and follow up with the correct information."
 * Which one a customer gets is luck. Two causes, OPPOSITE fixes:
 *   - identical prompt, different reply  ⇒ model sampling. Lever: reasoning effort / best-of-k.
 *   - different prompt                   ⇒ something upstream moved. That is a BUG, fixed once.
 * Nothing in the system could tell them apart, because the draft prompt is the one big artifact we
 * never logged. Parser calls are captured ~9,900/day; the message the customer actually receives is
 * generated from a prompt that left no trace.
 *
 * WHAT IS STORED, AND WHY NOT THE PROMPT ITSELF. A fingerprint, not the text: a few hundred bytes
 * per draft instead of tens of kilobytes. The capture file is already ~134MB/day and the box has
 * run out of disk before (deploy-backups incident). A hash answers the whole question — the text
 * would only answer it more expensively.
 *
 * THE TRAP THIS IS BUILT AROUND. A single whole-prompt hash reports DRIFT on every pair, because
 * the prompt legitimately carries the clock: "Today is:", dealer hours, and appointment slots
 * computed from now. That would have made every comparison look like an upstream bug. So each
 * record carries THREE things:
 *   - `hash`        the prompt exactly as sent;
 *   - `stableHash`  the same prompt with clock-derived values masked;
 *   - `sections`    a short hash per labelled block, so a real difference says WHERE.
 * Read them together: same `hash` ⇒ sampling. `hash` differs, `stableHash` same ⇒ the clock moved.
 * `stableHash` differs ⇒ genuine upstream drift, and `sections` names the culprit.
 */
import crypto from "node:crypto";
import fs from "node:fs";

export type DraftPromptFingerprint = {
  at: string;
  kind: "draft_prompt_fingerprint";
  model: string;
  leadKey: string | null;
  leadRef: string | null;
  channel: string | null;
  /** Characters actually sent, so a truncation or a runaway context is visible on its own. */
  chars: number;
  hash: string;
  stableHash: string;
  sections: Record<string, string>;
};

const short = (text: string): string => crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * Clock-derived values, masked so that two runs minutes apart are comparable.
 *
 * These are the values that MUST differ between runs and whose difference is not a defect: ISO
 * timestamps, wall-clock times, calendar dates and weekday names — the appointment-slot block is
 * built from "now", so it moves on its own. Deliberately narrow: over-masking would hide the very
 * drift this exists to catch, so anything that is not obviously a clock stays in the hash.
 */
export function maskVolatileClockValues(prompt: string): string {
  return String(prompt ?? "")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<TS>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>")
    .replace(/\b\d{1,2}:\d{2}\s?(?:AM|PM|am|pm)\b/g, "<TIME>")
    .replace(
      /\b(?:Mon|Tue|Tues|Wed|Thu|Thurs|Fri|Sat|Sun)(?:day|nesday|rsday|urday)?\b,?/g,
      "<DAY>"
    )
    .replace(
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/g,
      "<MONTHDAY>"
    );
}

/**
 * Hash each labelled block separately, so a mismatch localises instead of just saying "different".
 * Blocks are the prompt's own `Some heading:` lines — the shape the template already uses. Content
 * before the first heading is kept as `_preamble` rather than dropped.
 */
export function hashPromptSections(prompt: string): Record<string, string> {
  const lines = String(prompt ?? "").split("\n");
  const out: Record<string, string> = {};
  let name = "_preamble";
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const key = out[name] === undefined ? name : `${name}#${Object.keys(out).length}`;
    out[key] = short(maskVolatileClockValues(buf.join("\n")));
    buf = [];
  };
  for (const line of lines) {
    const heading = /^([A-Za-z][A-Za-z0-9 /'()\-,.]{2,70}):\s*$/.exec(line);
    if (heading) {
      flush();
      name = heading[1].trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

export function buildDraftPromptFingerprint(args: {
  at: string;
  model: string;
  instructions?: string | null;
  input?: string | null;
  leadKey?: string | null;
  leadRef?: string | null;
  channel?: string | null;
}): DraftPromptFingerprint {
  // Both halves are sent, so both belong in the fingerprint — a change confined to `instructions`
  // is still a different prompt.
  const whole = `${String(args.instructions ?? "")}\n<<<INPUT>>>\n${String(args.input ?? "")}`;
  return {
    at: args.at,
    kind: "draft_prompt_fingerprint",
    model: String(args.model ?? ""),
    leadKey: args.leadKey ?? null,
    leadRef: args.leadRef ?? null,
    channel: args.channel ?? null,
    chars: whole.length,
    hash: short(whole),
    stableHash: short(maskVolatileClockValues(whole)),
    sections: hashPromptSections(whole)
  };
}

/**
 * Where records go, or null when off. Same contract as `resolveParserCaptureDir`: kill switch wins,
 * explicit dir beats REPORT_ROOT, and no configured root means off so dev machines stay clean.
 */
export function resolveDraftFingerprintDir(env: {
  DRAFT_PROMPT_FINGERPRINT_DISABLED?: string;
  DRAFT_PROMPT_FINGERPRINT_DIR?: string;
  REPORT_ROOT?: string;
}): string | null {
  if (String(env.DRAFT_PROMPT_FINGERPRINT_DISABLED ?? "") === "1") return null;
  const explicit = String(env.DRAFT_PROMPT_FINGERPRINT_DIR ?? "").trim();
  if (explicit) return explicit;
  const root = String(env.REPORT_ROOT ?? "").trim();
  if (root) return `${root}/draft_prompt_fingerprint`;
  return null;
}

export function appendDraftPromptFingerprint(record: DraftPromptFingerprint): void {
  try {
    const dir = resolveDraftFingerprintDir(process.env as any);
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const day = record.at.slice(0, 10).replace(/-/g, "") || "unknown";
    fs.appendFileSync(`${dir}/draft_prompt_fingerprint_${day}.jsonl`, `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort by design — instrumentation must never disturb a customer-facing draft
  }
}
