/**
 * Voice-feedback summary-join eval. Production fixture: American Harley voice
 * report counted withVoiceSummary=0 while 423 voice_summary messages existed.
 * Root cause: the miner found each voice_transcript, then searched FORWARD only
 * for its summary — but the runtime writes the summary BEFORE the transcript
 * (index.ts ~60665 appends "voice_summary", then pushes "voice_transcript"
 * later), so after the ascending time-sort the summary sits earlier and was
 * never matched. The join must key on the shared providerMessageId (call SID)
 * regardless of time order, without cross-linking distinct calls. Until now
 * voice_feedback had no eval in ci:eval at all, so the regression shipped
 * silently — this is that missing gate.
 */
import assert from "node:assert/strict";
import { findSummaryForTranscript } from "./voice_feedback_mine.ts";

const toMs = (s: string) => Date.parse(s);

// Mirror the miner's ascending time-sort so the fixture exercises the exact
// ordering the bug depends on (summary BEFORE transcript).
function sortAndJoin(messages: any[]) {
  const sorted = [...messages].sort((a, b) => toMs(a.at) - toMs(b.at));
  let withVoiceSummary = 0;
  const linked: Array<{ transcriptId: string; summaryText: string | null }> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (String(sorted[i].provider).toLowerCase() !== "voice_transcript") continue;
    const m = findSummaryForTranscript(sorted, i);
    if (m?.summaryText) withVoiceSummary += 1;
    linked.push({
      transcriptId: String(sorted[i].providerMessageId ?? ""),
      summaryText: m?.summaryText ?? null
    });
  }
  return { withVoiceSummary, linked };
}

// Case 1 — the bug: summary @t, transcript @t+20s, same SID. Must link.
{
  const sid = "CAb52815f5ce";
  const messages = [
    { provider: "voice_summary", at: "2026-06-13T15:00:16.000Z", body: "Customer asked about trade value.", providerMessageId: sid },
    { provider: "voice_transcript", at: "2026-06-13T15:00:20.000Z", body: "Hi, calling about my trade...", providerMessageId: sid }
  ];
  const { withVoiceSummary, linked } = sortAndJoin(messages);
  assert.equal(withVoiceSummary, 1, "summary written before transcript with same SID must still link");
  assert.equal(linked.length, 1, "exactly one transcript row");
  assert.equal(
    linked[0].summaryText,
    "Customer asked about trade value.",
    "linked summary text must match the shared-SID summary"
  );
}

// Case 2 — negative: two distinct calls in one conversation must NOT cross-link.
{
  const sidA = "CAaaaaaaaaaa";
  const sidB = "CAbbbbbbbbbb";
  const messages = [
    { provider: "voice_summary", at: "2026-06-13T15:00:16.000Z", body: "Summary A", providerMessageId: sidA },
    { provider: "voice_transcript", at: "2026-06-13T15:00:20.000Z", body: "Transcript A", providerMessageId: sidA },
    { provider: "voice_summary", at: "2026-06-13T16:00:16.000Z", body: "Summary B", providerMessageId: sidB },
    { provider: "voice_transcript", at: "2026-06-13T16:00:20.000Z", body: "Transcript B", providerMessageId: sidB }
  ];
  const { withVoiceSummary, linked } = sortAndJoin(messages);
  assert.equal(withVoiceSummary, 2, "both calls link their own summary");
  const byId = Object.fromEntries(linked.map(l => [l.transcriptId, l.summaryText]));
  assert.equal(byId[sidA], "Summary A", "transcript A must link summary A, not summary B");
  assert.equal(byId[sidB], "Summary B", "transcript B must link summary B, not summary A");
}

// Case 3 — voicemail summary, same SID, summary-first. Must still link.
{
  const sid = "CAvm00000001";
  const messages = [
    { provider: "voice_summary", at: "2026-06-13T17:00:16.000Z", body: "Voicemail — not contacted.", providerMessageId: sid },
    { provider: "voice_transcript", at: "2026-06-13T17:00:20.000Z", body: "[voicemail audio]", providerMessageId: sid }
  ];
  const { withVoiceSummary } = sortAndJoin(messages);
  assert.equal(withVoiceSummary, 1, "voicemail summary written before transcript must link");
}

// Case 4 — regression guard: a bare-id transcript falls back forward-only and
// must NOT steal an earlier, identified call's summary.
{
  const messages = [
    { provider: "voice_summary", at: "2026-06-13T18:00:00.000Z", body: "Earlier call summary", providerMessageId: "CAearlier001" },
    { provider: "voice_transcript", at: "2026-06-13T18:30:00.000Z", body: "Bare transcript", providerMessageId: "" }
  ];
  const { withVoiceSummary, linked } = sortAndJoin(messages);
  assert.equal(withVoiceSummary, 0, "bare-id transcript must not grab an earlier SID-bearing summary");
  assert.equal(linked[0].summaryText, null, "no summary linked for the bare transcript");
}

console.log("PASS voice feedback summary-join eval");
