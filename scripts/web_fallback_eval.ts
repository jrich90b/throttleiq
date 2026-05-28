import { searchGoogleCse } from "../services/api/src/domain/webFallback.ts";

const question = process.env.WEB_FALLBACK_EVAL_QUESTION || "how much is a hog membership?";

async function main() {
  const search = await searchGoogleCse({
    query: question,
    profile: {
      website: "https://www.americanharley-davidson.com/",
      webSearch: {
        referenceUrls: ["https://www.harley-davidson.com/us/en/content/hog/membership-benefits.html"]
      }
    },
    maxResults: 3,
    timeoutMs: 6000
  });
  const hits = search?.hits ?? [];
  const hogHit = hits.find(hit => /harley-davidson\.com$/i.test(hit.domain) && /\$59|59\/year|59 per year/i.test(hit.snippet));
  if (!hogHit) {
    console.error(JSON.stringify({ question, hits }, null, 2));
    throw new Error("Expected enriched H.O.G. membership search snippet to include $59/year.");
  }
  console.log(`PASS web fallback search enriched H.O.G. snippet from ${hogHit.url}`);

  if (process.env.LLM_ENABLED === "1" && process.env.OPENAI_API_KEY) {
    const { generateWebFallbackReplyWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
    const reply = await generateWebFallbackReplyWithLLM({
      question,
      results: hits.map(hit => ({ title: hit.title, snippet: hit.snippet, url: hit.url })),
      history: []
    });
    const text = String(reply?.reply ?? "");
    if (!reply?.answerable || !/\$59|59/.test(text)) {
      console.error(JSON.stringify({ question, hits, reply }, null, 2));
      throw new Error("Expected web fallback LLM reply to answer with the $59 H.O.G. membership price.");
    }
    console.log(`PASS web fallback LLM reply: ${text}`);
  }
}

main().catch(err => {
  console.error(err?.stack ?? err?.message ?? err);
  process.exit(1);
});
