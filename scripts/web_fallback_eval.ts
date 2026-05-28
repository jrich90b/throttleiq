import { searchGoogleCse } from "../services/api/src/domain/webFallback.ts";

type EvalCase = {
  id: string;
  question: string;
  expectedUrl?: RegExp;
  snippetPattern?: RegExp;
  replyPattern?: RegExp;
};

const envQuestion = process.env.WEB_FALLBACK_EVAL_QUESTION;

const evalCases: EvalCase[] = envQuestion
  ? [
      {
        id: "custom",
        question: envQuestion
      }
    ]
  : [
      {
        id: "hog_membership_price",
        question: "how much is a hog membership?",
        expectedUrl: /\/content\/(?:hog\/membership-benefits|membership)\.html/i,
        snippetPattern: /\$59|59\/year|59 per year/i,
        replyPattern: /\$59|59/i
      },
      {
        id: "king_baggers_schedule",
        question: "do you have the king of the baggers schedule?",
        expectedUrl: /\/content\/event-calendar\/king-of-baggers\.html/i,
        snippetPattern:
          /King of the Baggers|Harley-Davidson Racing Schedules|Daytona|Road America|Laguna|Mid-Ohio|March|September/i,
        replyPattern: /King of the Baggers|Daytona|Road America|Laguna|Mid-Ohio|schedule|dates/i
      }
    ];

async function main() {
  for (const testCase of evalCases) {
    const search = await searchGoogleCse({
      query: testCase.question,
      profile: {
        website: "https://www.americanharley-davidson.com/",
        webSearch: {
          referenceUrls: [
            "https://www.harley-davidson.com/us/en/content/hog/membership-benefits.html",
            "https://www.harley-davidson.com/us/en/content/event-calendar/king-of-baggers.html"
          ]
        }
      },
      maxResults: 3,
      timeoutMs: 6000
    });
    const hits = search?.hits ?? [];
    const expectedHit = hits.find(hit => {
      const urlOk = testCase.expectedUrl ? testCase.expectedUrl.test(hit.url) : true;
      const snippetOk = testCase.snippetPattern ? testCase.snippetPattern.test(hit.snippet) : true;
      return /harley-davidson\.com$/i.test(hit.domain) && urlOk && snippetOk;
    });
    if (!expectedHit) {
      console.error(JSON.stringify({ id: testCase.id, question: testCase.question, search }, null, 2));
      throw new Error(`Expected enriched official Harley search snippet for ${testCase.id}.`);
    }
    console.log(`PASS ${testCase.id} web fallback search from ${search?.provider}: ${expectedHit.url}`);

    if (process.env.LLM_ENABLED === "1" && process.env.OPENAI_API_KEY && testCase.replyPattern) {
      const { generateWebFallbackReplyWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
      const reply = await generateWebFallbackReplyWithLLM({
        question: testCase.question,
        results: hits.map(hit => ({ title: hit.title, snippet: hit.snippet, url: hit.url })),
        history: []
      });
      const text = String(reply?.reply ?? "");
      if (!reply?.answerable || !testCase.replyPattern.test(text)) {
        console.error(JSON.stringify({ id: testCase.id, question: testCase.question, hits, reply }, null, 2));
        throw new Error(`Expected web fallback LLM reply to answer ${testCase.id}.`);
      }
      console.log(`PASS ${testCase.id} web fallback LLM reply: ${text}`);
    }
  }
}

main().catch(err => {
  console.error(err?.stack ?? err?.message ?? err);
  process.exit(1);
});
