import { rankWebSearchHitsForQuestion, type WebSearchHit } from "../services/api/src/domain/webFallback.ts";

function hit(url: string, title: string, snippet = "Official Harley-Davidson information."): WebSearchHit {
  const parsed = new URL(url);
  return {
    title,
    snippet,
    url,
    domain: parsed.hostname.replace(/^www\./, "")
  };
}

function expectTop(args: {
  name: string;
  question: string;
  hits: WebSearchHit[];
  expectedUrl: RegExp;
  profile?: Parameters<typeof rankWebSearchHitsForQuestion>[2];
}) {
  const ranked = rankWebSearchHitsForQuestion(args.question, args.hits, args.profile);
  const top = ranked[0]?.url ?? "";
  if (!args.expectedUrl.test(top)) {
    console.error(JSON.stringify({ name: args.name, question: args.question, top, ranked }, null, 2));
    throw new Error(`Unexpected top web fallback hit for ${args.name}.`);
  }
  console.log(`PASS ${args.name}: ${top}`);
}

expectTop({
  name: "prefer customer Harley page over insurance article",
  question: "What does Harley-Davidson say about things to do?",
  hits: [
    hit(
      "https://www.insurance.harley-davidson.com/resources/things-to-do-following-motorcycle-accident",
      "Things to do after a motorcycle accident"
    ),
    hit("https://www.harley-davidson.com/us/en/experiences/things-to-do.html", "Things to Do")
  ],
  expectedUrl: /www\.harley-davidson\.com\/us\/en\/experiences\/things-to-do\.html/
});

expectTop({
  name: "prefer customer Harley page over investor release",
  question: "What Harley-Davidson private events information is available?",
  hits: [
    hit(
      "https://investor.harley-davidson.com/news/news-details/2026/Harley-Davidson-Inc--to-Host-Audio-Webcast/default.aspx",
      "Investor discussion"
    ),
    hit("https://www.harley-davidson.com/us/en/experiences/events/privateevents.html", "Private Events")
  ],
  expectedUrl: /www\.harley-davidson\.com\/us\/en\/experiences\/events\/privateevents\.html/
});

expectTop({
  name: "keep insurance page for insurance question",
  question: "Does Harley-Davidson offer motorcycle insurance coverage?",
  hits: [
    hit("https://www.harley-davidson.com/us/en/experiences/museum", "Harley-Davidson Museum"),
    hit("https://www.insurance.harley-davidson.com/coverage", "Motorcycle Insurance Coverage")
  ],
  expectedUrl: /insurance\.harley-davidson\.com\/coverage/
});

expectTop({
  name: "prefer dealer site when dealer profile matches",
  question: "Do you have current finance specials?",
  profile: {
    website: "https://www.americanharley-davidson.com/"
  },
  hits: [
    hit("https://www.harley-davidson.com/us/en/tools/offers.html", "Harley-Davidson Offers"),
    hit("https://www.americanharley-davidson.com/current-promotions", "American Harley-Davidson Promotions")
  ],
  expectedUrl: /americanharley-davidson\.com\/current-promotions/
});
