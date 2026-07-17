/**
 * Inventory dealer-scoping eval (2026-07-17) — pins the A2/A3 de-hardcode:
 * a second dealer must NEVER be served American Harley's inventory or links.
 *
 *  1) inventoryUrlResolver derives the product-link domain from the dealer
 *     profile's website (hostname, www-stripped); INVENTORY_SITE_DOMAIN env
 *     override wins when set.
 *  2) Link extraction is scoped to the derived domain: another dealer's
 *     absolute link never matches, and a foreign absolute URL's path is never
 *     absolutized onto our domain. Dealer-relative links still absolutize.
 *  3) No domain configured (no env, no profile website) => NO links
 *     (fail toward silence, never toward a wrong dealer's link).
 *  4) inventoryFeed: INVENTORY_XML_URL env always wins; a non-legacy dealer id
 *     with no env gets NO feed url and the feed loads empty; the legacy dealer
 *     id keeps its implicit default feed url (the live box relies on it).
 *
 * Assertions use fixture values (example-motorsports.com) or module-exported
 * constants — no dealer-output literals, per the eval-suite manifest guard.
 *
 * Run: npx tsx scripts/inventory_dealer_scoping_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveInventoryDomainHost,
  extractFirstInventoryUrl,
  getInventorySiteDomain,
  resolveInventoryUrlByStock
} from "../services/api/src/domain/inventoryUrlResolver.ts";
import {
  getInventoryFeed,
  LEGACY_AMERICANHARLEY_FEED_URL,
  resolveInventoryFeedUrl
} from "../services/api/src/domain/inventoryFeed.ts";

// Deterministic regardless of ambient env / .env contents.
delete process.env.INVENTORY_SITE_DOMAIN;
delete process.env.INVENTORY_LIST_URLS;
delete process.env.INVENTORY_XML_URL;
delete process.env.DEALER_ID;
delete process.env.DEALER_SLUG;

const FIXTURE_PROFILE = { dealerName: "Fixture Motorsports", website: "https://example-motorsports.com" };
const FIXTURE_HOST = "example-motorsports.com";

async function main() {
  // ── 1) Domain derivation ────────────────────────────────────────────────────
  assert.equal(deriveInventoryDomainHost(FIXTURE_PROFILE.website), FIXTURE_HOST, "profile website => hostname");
  assert.equal(
    deriveInventoryDomainHost(`https://www.${FIXTURE_HOST}/inventory?x=1`),
    FIXTURE_HOST,
    "www + path stripped"
  );
  assert.equal(deriveInventoryDomainHost(FIXTURE_HOST), FIXTURE_HOST, "bare domain accepted");
  assert.equal(deriveInventoryDomainHost(""), null, "empty => null");
  assert.equal(deriveInventoryDomainHost("   "), null, "blank => null");
  assert.equal(deriveInventoryDomainHost(undefined), null, "undefined => null");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-dealer-scoping-"));
  const profileWithWebsite = path.join(tmpDir, "profile_with_website.json");
  fs.writeFileSync(profileWithWebsite, JSON.stringify(FIXTURE_PROFILE));
  process.env.DEALER_PROFILE_PATH = profileWithWebsite;

  assert.equal(await getInventorySiteDomain(), FIXTURE_HOST, "domain derives from the fixture profile website");

  process.env.INVENTORY_SITE_DOMAIN = "https://override-powersports.example";
  assert.equal(
    await getInventorySiteDomain(),
    "override-powersports.example",
    "INVENTORY_SITE_DOMAIN env override wins over the profile website"
  );
  delete process.env.INVENTORY_SITE_DOMAIN;

  // ── 2) Link extraction is dealer-domain-scoped ──────────────────────────────
  const ownLink = `https://${FIXTURE_HOST}/inventory/123/2026-road-glide-stk777`;
  const foreignLink = "https://other-dealer.example/inventory/999/2026-street-glide-stk999";

  assert.equal(
    extractFirstInventoryUrl(`<a href="${ownLink}">unit</a>`, FIXTURE_HOST),
    ownLink,
    "own-domain absolute link matches"
  );
  assert.equal(
    extractFirstInventoryUrl(`<a href="https://www.${FIXTURE_HOST}/inventory/123/stk777">unit</a>`, FIXTURE_HOST),
    `https://www.${FIXTURE_HOST}/inventory/123/stk777`,
    "www-prefixed own-domain link matches"
  );
  assert.equal(
    extractFirstInventoryUrl(`<a href="/inventory/55/2025-heritage-stk55">unit</a>`, FIXTURE_HOST),
    `https://${FIXTURE_HOST}/inventory/55/2025-heritage-stk55`,
    "dealer-relative link absolutizes onto the dealer domain"
  );
  assert.equal(
    extractFirstInventoryUrl(`<a href="${foreignLink}">unit</a>`, FIXTURE_HOST),
    null,
    "another dealer's absolute link never matches nor gets absolutized onto our domain"
  );

  // ── 3) No domain configured => no links ─────────────────────────────────────
  const profileNoWebsite = path.join(tmpDir, "profile_no_website.json");
  fs.writeFileSync(profileNoWebsite, JSON.stringify({ dealerName: "Fixture Motorsports" }));
  process.env.DEALER_PROFILE_PATH = profileNoWebsite;

  assert.equal(await getInventorySiteDomain(), null, "no env + no profile website => no domain");
  const noDomainResult = await resolveInventoryUrlByStock("STK123");
  assert.deepEqual(
    noDomainResult,
    { ok: false, reason: "not_found" },
    "no domain => the resolver returns no link (and never fetches)"
  );

  // ── 4) Feed URL scoping ─────────────────────────────────────────────────────
  process.env.INVENTORY_XML_URL = "https://feeds.example-motorsports.com/inventory.xml";
  assert.equal(
    resolveInventoryFeedUrl(),
    "https://feeds.example-motorsports.com/inventory.xml",
    "INVENTORY_XML_URL env always wins"
  );

  delete process.env.INVENTORY_XML_URL;
  process.env.DEALER_ID = "second-dealer";
  assert.equal(resolveInventoryFeedUrl(), null, "non-legacy dealer id with no env gets NO feed url");
  const emptyFeed = await getInventoryFeed({ bypassCache: true });
  assert.deepEqual(emptyFeed, [], "no feed url => the feed loads empty (no fallback to another dealer's feed)");

  process.env.DEALER_ID = "americanharley";
  const legacyUrl = resolveInventoryFeedUrl();
  assert.equal(legacyUrl, LEGACY_AMERICANHARLEY_FEED_URL, "legacy dealer id keeps the implicit default feed url");
  assert.ok((legacyUrl ?? "").includes("/inventory/xml"), "legacy default is an inventory XML feed url");

  console.log("PASS inventory dealer-scoping eval");
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
