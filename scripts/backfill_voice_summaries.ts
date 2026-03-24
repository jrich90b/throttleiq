import { summarizeVoiceTranscriptWithLLM } from "../services/api/src/domain/llmDraft.ts";
import {
  flushConversationStore,
  getAllConversations,
  reloadConversationStore,
  saveConversation
} from "../services/api/src/domain/conversationStore.ts";

type Args = {
  dryRun: boolean;
  includeNoId: boolean;
  limit: number;
};

function parseArgs(argv: string[]): Args {
  const dryRun = argv.includes("--dry-run");
  const includeNoId = argv.includes("--include-no-id");
  const limitArg = argv.find(arg => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : Number.POSITIVE_INFINITY;
  return {
    dryRun,
    includeNoId,
    limit: Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY
  };
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function isLikelyVoicemailTranscript(text: string): boolean {
  const raw = text ?? "";
  const t = raw.toLowerCase();
  if (!t.trim()) return true;
  const vmRe =
    /voicemail|voice mail|mailbox|leave (a )?message|after the (tone|beep)|at the (tone|beep)|please leave|not available|unable to (answer|take your call)|your call has been forwarded|record your message|sorry we (missed|couldn't take) your call/;
  const lines = raw
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);
  const customerLines = lines
    .filter(line => /^customer:/i.test(line))
    .map(line => line.replace(/^customer:\s*/i, "").trim().toLowerCase())
    .filter(Boolean);
  const hasNonVoicemailCustomer = customerLines.some(line => !vmRe.test(line));
  if (hasNonVoicemailCustomer) return false;
  return vmRe.test(t);
}

const args = parseArgs(process.argv.slice(2));

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_VOICE_SUMMARIZER_ENABLED !== "1") {
  console.error("LLM_ENABLED=1 and LLM_VOICE_SUMMARIZER_ENABLED=1 are required for this backfill.");
  process.exit(1);
}

await reloadConversationStore();

const convs = getAllConversations();
let created = 0;
let skipped = 0;
let processed = 0;
let touched = 0;

for (const conv of convs) {
  if (created >= args.limit) break;
  if (!conv.messages || conv.messages.length === 0) continue;

  const messages = conv.messages;
  const transcripts = messages.filter(m => m.provider === "voice_transcript");
  if (!transcripts.length) continue;

  const summaryIds = new Set(
    messages
      .filter(m => m.provider === "voice_summary" && m.providerMessageId)
      .map(m => m.providerMessageId as string)
  );

  const lastTranscript = transcripts[transcripts.length - 1] ?? null;
  let changed = false;
  const prevUpdatedAt = conv.updatedAt;

  for (const transcript of transcripts) {
    if (created >= args.limit) break;

    const body = String(transcript.body ?? "").trim();
    const isNotContacted = /^not contacted\.?$/i.test(body);
    const isVoicemail = isLikelyVoicemailTranscript(body);
    const isVoicemailSummary = isNotContacted || isVoicemail;

    const transcriptId = String(transcript.providerMessageId ?? "").trim();
    if (!transcriptId && !args.includeNoId) {
      skipped += 1;
      continue;
    }
    if (transcriptId && summaryIds.has(transcriptId)) {
      skipped += 1;
      continue;
    }

    const idx = messages.indexOf(transcript);
    if (!transcriptId && idx > 0 && messages[idx - 1]?.provider === "voice_summary") {
      skipped += 1;
      continue;
    }

    let summary = "";
    if (isVoicemailSummary) {
      summary = "Voicemail — not contacted.";
    } else {
      summary = (await summarizeVoiceTranscriptWithLLM({
        transcript: body,
        lead: conv.lead ?? undefined
      })) ?? "";
      processed += 1;
    }
    if (!summary) {
      skipped += 1;
      continue;
    }

    const summaryMsg = {
      id: makeId("msg"),
      direction: "out" as const,
      from: "system",
      to: conv.leadKey,
      body: summary,
      at: transcript.at ?? new Date().toISOString(),
      provider: "voice_summary" as const,
      providerMessageId: transcriptId || undefined
    };

    if (!args.dryRun) {
      if (idx >= 0) {
        messages.splice(idx, 0, summaryMsg);
      } else {
        messages.push(summaryMsg);
      }
      if (transcriptId) summaryIds.add(transcriptId);
      changed = true;

      if (transcript === lastTranscript && !isVoicemailSummary) {
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        conv.voiceContext = {
          summary,
          updatedAt: new Date().toISOString(),
          expiresAt,
          sourceMessageId: transcriptId || undefined,
          contacted: true
        };
      }
    }

    created += 1;
  }

  if (changed) {
    conv.updatedAt = prevUpdatedAt;
    saveConversation(conv);
    touched += 1;
  }
}

if (!args.dryRun) {
  await flushConversationStore();
}

console.log(
  JSON.stringify(
    {
      dryRun: args.dryRun,
      includeNoId: args.includeNoId,
      limit: Number.isFinite(args.limit) ? args.limit : null,
      processed,
      created,
      skipped,
      conversationsUpdated: touched
    },
    null,
    2
  )
);
