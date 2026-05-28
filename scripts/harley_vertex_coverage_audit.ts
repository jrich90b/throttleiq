import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { searchGoogleCse } from "../services/api/src/domain/webFallback.ts";

type AuditRow = {
  url: string;
  question: string;
  bucket: string;
  provider: string | null;
  verdict: "vertex_ok" | "vertex_partial" | "no_result" | "not_customer_answer";
  matchedTarget: boolean;
  topUrl: string;
  topTitle: string;
  topSnippet: string;
};

const SITEMAPS = [
  "https://www.harley-davidson.com/us/en/sitemap.xml",
  "https://www.harley-davidson.com/us/en/store/categories.xml"
];

const EXTRA_OFFICIAL_PAGES = [
  "https://www.harley-davidson.com/us/en/content/hog/membership-benefits.html",
  "https://www.harley-davidson.com/us/en/content/membership.html",
  "https://www.harley-davidson.com/us/en/content/event-calendar/king-of-baggers.html"
];

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

async function fetchXml(url: string): Promise<string> {
  const resp = await fetch(url, { headers: { Accept: "application/xml,text/xml" } });
  if (!resp.ok) throw new Error(`Failed to fetch sitemap ${url}: ${resp.status}`);
  return resp.text();
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]!.trim()).filter(Boolean);
}

function titleFromUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const last = url.pathname
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/\.html$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return last || "Harley Davidson";
}

function bucketForUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const parts = url.pathname.split("/").filter(Boolean).slice(2);
  if (parts[0] === "shop") return parts.slice(0, 2).join("/");
  if (parts[0] === "tools") return parts.slice(0, 2).join("/");
  if (parts[0] === "customer-service") return "customer-service";
  if (parts[0] === "content") return parts.slice(0, 2).join("/");
  if (parts[0] === "experiences") return parts.slice(0, 2).join("/");
  if (parts[0] === "about-us") return parts.slice(0, 2).join("/");
  return parts.slice(0, 1).join("/") || "root";
}

function isCustomerAnswerCandidate(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  const pathName = url.pathname;
  if (/\/tools\/find-a-dealer\//.test(pathName)) return false;
  if (/\/shop\/t\//.test(pathName)) return false;
  if (/\/store\/products\.xml$/.test(pathName)) return false;
  return true;
}

function questionForUrl(rawUrl: string): string {
  const title = titleFromUrl(rawUrl);
  const pathName = new URL(rawUrl).pathname;
  if (/membership-benefits|\/membership\.html/.test(pathName)) return "How much is a HOG membership?";
  if (/king-of-baggers/.test(pathName)) return "Do you have the King of the Baggers schedule?";
  if (/motorcycle-financing/.test(pathName)) return "Where can I learn about Harley-Davidson motorcycle financing?";
  if (/private-party-financing/.test(pathName)) return "Does Harley-Davidson offer private party financing?";
  if (/service-recalls/.test(pathName)) return "How do I check Harley-Davidson service recalls?";
  if (/estimate-payment/.test(pathName)) return "Can I estimate a Harley-Davidson monthly payment online?";
  if (/learn-to-ride/.test(pathName)) return "Where can I learn to ride a Harley-Davidson motorcycle?";
  if (/rent-a-bike/.test(pathName)) return "Can I rent a Harley-Davidson motorcycle?";
  if (/shipping-and-delivery/.test(pathName)) return "What is Harley-Davidson shipping and delivery policy?";
  if (/returns-and-exchanges/.test(pathName)) return "What is Harley-Davidson returns and exchanges policy?";
  if (/faq/.test(pathName)) return "Where is the Harley-Davidson customer service FAQ?";
  if (/factorytours/.test(pathName)) return "Does Harley-Davidson offer factory tours?";
  if (/museum/.test(pathName)) return "What can I see at the Harley-Davidson Museum?";
  if (/events|calendar/.test(pathName)) return `What Harley-Davidson ${title} information is available?`;
  if (/shop\/c\//.test(pathName)) return `Where can I find Harley-Davidson ${title}?`;
  return `What does Harley-Davidson say about ${title}?`;
}

function targetMatches(resultUrl: string, targetUrl: string): boolean {
  const result = new URL(resultUrl);
  const target = new URL(targetUrl);
  const resultPath = result.pathname.replace(/\/$/, "");
  const targetPath = target.pathname.replace(/\/$/, "");
  return result.hostname.endsWith("harley-davidson.com") && resultPath === targetPath;
}

async function main() {
  const sitemapUrls: string[] = [];
  for (const sitemap of SITEMAPS) {
    const parsedLocs = locs(await fetchXml(sitemap));
    for (const loc of parsedLocs) {
      if (loc.endsWith(".xml")) {
        sitemapUrls.push(...locs(await fetchXml(loc)));
      } else {
        sitemapUrls.push(loc);
      }
    }
  }

  const allUrls = uniq([...sitemapUrls, ...EXTRA_OFFICIAL_PAGES]).filter(url =>
    url.startsWith("https://www.harley-davidson.com/us/en/")
  );
  const candidates = allUrls.filter(isCustomerAnswerCandidate);
  const infoCandidates = candidates.filter(url => !/\/shop\//.test(new URL(url).pathname));
  const shopCategorySample = candidates
    .filter(url => /\/shop\/c\//.test(new URL(url).pathname))
    .slice(0, Number(process.env.HARLEY_VERTEX_SHOP_SAMPLE ?? 25));
  const auditUrls = uniq([...infoCandidates, ...shopCategorySample]);

  const rows: AuditRow[] = [];
  for (const url of auditUrls) {
    const question = questionForUrl(url);
    const search = await searchGoogleCse({
      query: question,
      profile: {
        website: "https://www.americanharley-davidson.com/",
        webSearch: {
          referenceUrls: ["https://www.harley-davidson.com/"]
        }
      },
      maxResults: 5,
      timeoutMs: 6000
    });
    const hits = search?.hits ?? [];
    const top = hits[0] ?? null;
    const matchedTarget = hits.some(hit => targetMatches(hit.url, url));
    const anyOfficial = hits.some(hit => /harley-davidson\.com$/i.test(hit.domain));
    const verdict: AuditRow["verdict"] = matchedTarget
      ? "vertex_ok"
      : anyOfficial
        ? "vertex_partial"
        : "no_result";
    rows.push({
      url,
      question,
      bucket: bucketForUrl(url),
      provider: search?.provider ?? null,
      verdict,
      matchedTarget,
      topUrl: top?.url ?? "",
      topTitle: top?.title ?? "",
      topSnippet: String(top?.snippet ?? "").slice(0, 260)
    });
  }

  const reportDir = path.resolve("reports/harley-vertex-coverage");
  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(reportDir, `${stamp}.json`);
  const mdPath = path.join(reportDir, `${stamp}.md`);
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sitemapUrlCount: allUrls.length,
        candidateCount: candidates.length,
        auditedCount: rows.length,
        rows
      },
      null,
      2
    )
  );

  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const bucketLines = Object.entries(
    rows.reduce<Record<string, { total: number; ok: number; partial: number; noResult: number }>>((acc, row) => {
      const item = acc[row.bucket] ?? { total: 0, ok: 0, partial: 0, noResult: 0 };
      item.total += 1;
      if (row.verdict === "vertex_ok") item.ok += 1;
      if (row.verdict === "vertex_partial") item.partial += 1;
      if (row.verdict === "no_result") item.noResult += 1;
      acc[row.bucket] = item;
      return acc;
    }, {})
  )
    .sort((a, b) => b[1].total - a[1].total)
    .map(([bucket, stats]) => `| ${bucket} | ${stats.total} | ${stats.ok} | ${stats.partial} | ${stats.noResult} |`);
  const misses = rows
    .filter(row => row.verdict !== "vertex_ok")
    .slice(0, 30)
    .map(row => `| ${row.verdict} | ${row.question.replace(/\|/g, " ")} | ${row.url} | ${row.topUrl} |`);
  await writeFile(
    mdPath,
    [
      "# Harley Vertex Coverage Audit",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      `Sitemap URLs inspected: ${allUrls.length}`,
      `Customer-answer candidates: ${candidates.length}`,
      `Audited queries: ${rows.length}`,
      "",
      "## Verdict Counts",
      "",
      `- vertex_ok: ${counts.vertex_ok ?? 0}`,
      `- vertex_partial: ${counts.vertex_partial ?? 0}`,
      `- no_result: ${counts.no_result ?? 0}`,
      "",
      "## Buckets",
      "",
      "| Bucket | Total | Vertex OK | Partial | No Result |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...bucketLines,
      "",
      "## First Misses / Partials",
      "",
      "| Verdict | Question | Target URL | Top URL |",
      "| --- | --- | --- | --- |",
      ...(misses.length ? misses : ["| none | | | |"]),
      ""
    ].join("\n")
  );
  console.log(JSON.stringify({ jsonPath, mdPath, counts, auditedCount: rows.length }, null, 2));
}

main().catch(err => {
  console.error(err?.stack ?? err?.message ?? err);
  process.exit(1);
});
