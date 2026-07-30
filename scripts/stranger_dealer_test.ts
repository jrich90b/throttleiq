/**
 * STRANGER TEST — readiness-bar section 4 (Joe, 2026-07-30: "has a fresh synthetic
 * 'dealer #2' been provisioned from config alone and passed the gates cold?").
 *
 * WHY THIS EXISTS. Everything else we measure grades LeadRider at American Harley — the
 * one store where every rough edge has already been sanded down. That tells us nothing
 * about a dealer we've never met. This harness stands up a FICTIONAL dealership from
 * config alone, drives real reply-producing code as that dealer, and hard-fails if a
 * single byte of American Harley's identity reaches the output.
 *
 * The failure mode it exists to catch is the worst one this product has: dealer #2's
 * customer receiving a text signed "American Harley-Davidson". ~90 sites in
 * services/api/src read `dealerProfile?.dealerName ?? "American Harley-Davidson"`, so a
 * profile-load miss at a stranger dealer leaks OUR name into THEIR conversation.
 *
 * THREE LAYERS, deliberately (each answers a different question):
 *   A. CONFIG-ONLY PROVISIONING — write a stranger profile to disk, point
 *      DEALER_PROFILE_PATH at it, and confirm the runtime loader adopts that identity
 *      with no code change. Proves onboarding is config, not engineering.
 *   B. CUSTOMER-FACING COPY — drive the real deterministic reply builders in
 *      domain/agentVoice.ts with the stranger identity and leak-scan every string a
 *      customer would actually receive. No LLM, no cost, fully repeatable.
 *   C. FALLBACK-SITE AUDIT — enumerate every hardcoded AH literal in services/api/src
 *      and classify it by FAIL DIRECTION (AGENTS.md's migrate-vs-keep test applied to
 *      portability): an identity FALLBACK leaks our name into their message; a hardcoded
 *      MATCHER silently never fires for them. Layers A+B can only reach exported code;
 *      most fallback sites live inside index.ts request handlers, so this static pass is
 *      how they get counted and turned into a fix list.
 *   D. LIVE TURNS (--live, costs LLM calls) — run `orchestrateInbound` for canonical
 *      lead scenarios with ctx.dealerProfile set to the stranger, and leak-scan the
 *      drafts the engine actually produces. This is the end-to-end proof; it is opt-in
 *      because it is priced and nondeterministic.
 *
 * ANTI-FLATTERY (the same rule the scorecard enforces — Joe, 7/30: the score must not
 * flatter). `passed: true` is reachable ONLY from a --live run with zero leaks and zero
 * probe errors. An offline-only run reports passed:false with a detail line saying why,
 * so "we ran the cheap half" can never read as "dealer #2 works". Every probe error is
 * fail-CLOSED: an exception is a failure, never a skipped check.
 *
 * Writes {reportRoot}/stranger_test/latest.json — the file
 * scripts/rollout_readiness_report.ts reads for section 4 ({passed, at, detail}).
 *
 * Usage:
 *   npm run stranger_dealer:test                       # offline layers A-C
 *   npm run stranger_dealer:test -- --live             # + real turns (LLM cost)
 *   REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports \
 *     npm run stranger_dealer:test
 *
 * Pinned by stranger_dealer_test:eval (the harness's own logic — leak detection,
 * anti-flattery, and the report contract the scorecard depends on).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// The stranger dealer.
// ---------------------------------------------------------------------------

/**
 * A deliberately FICTIONAL dealership. Every identity field is chosen to share no
 * token with American Harley: different name, city, state, street, area code, host,
 * persona, and a different weekly schedule (closed Monday, later Saturday) so
 * hours-derived copy differs too. Not a real store — "example.com" is reserved by RFC
 * 2606 precisely so test fixtures can't point at someone's live site.
 *
 * The eval asserts this profile contains none of AH's identity tokens, so the fixture
 * can't silently rot into a passing-because-identical test.
 */
export const STRANGER_DEALER = {
  dealerName: "Great Lakes Harley-Davidson",
  agentName: "Marcus",
  phone: "(419) 555-0142",
  website: "https://greatlakesharley.example.com",
  address: {
    line1: "2210 Cedar Point Rd",
    city: "Sandusky",
    state: "OH",
    zip: "44870"
  },
  hours: {
    sales: {
      monday: { open: null, close: null },
      tuesday: { open: "10:00", close: "19:00" },
      wednesday: { open: "10:00", close: "19:00" },
      thursday: { open: "10:00", close: "19:00" },
      friday: { open: "10:00", close: "19:00" },
      saturday: { open: "10:00", close: "17:00" },
      sunday: { open: null, close: null }
    }
  }
} as const;

// ---------------------------------------------------------------------------
// Leak tokens — derived from AH's REAL profile so they track reality.
// ---------------------------------------------------------------------------

export type IdentityToken = {
  /** What kind of identity this is — drives how the scanner matches it. */
  kind: "text" | "phone";
  /** The literal to look for (lowercased for text). */
  value: string;
  /** Human label for the report ("dealer name", "persona name", …). */
  label: string;
};

/**
 * Build the leak signatures for the dealer whose identity must NOT escape.
 *
 * Sourced from the live profile file rather than hardcoded, so if AH's name, phone, or
 * address ever changes the detector follows it. `extraLiterals` carries the short forms
 * that appear in code but not in the profile ("American H-D", "americanharley") — those
 * are real leak shapes the profile alone wouldn't catch.
 *
 * Deliberately NOT tokenized: state codes ("NY"), the bare brand ("Harley-Davidson"),
 * and anything under 4 characters. Those match innocent text and a false leak would
 * make this whole test untrustworthy — the scanner has to be believable to be useful.
 */
export function buildIdentityLeakTokens(
  profile: {
    dealerName?: string | null;
    agentName?: string | null;
    phone?: string | null;
    website?: string | null;
    address?: { line1?: string | null; city?: string | null; zip?: string | null } | null;
  } | null,
  extraLiterals: string[] = ["American Harley", "American H-D", "American HD", "americanharley"]
): IdentityToken[] {
  const tokens: IdentityToken[] = [];
  const pushText = (raw: unknown, label: string) => {
    const clean = String(raw ?? "").trim();
    // 4-char floor: shorter strings ("Ave", "OH") collide with ordinary words.
    if (clean.length < 4) return;
    const lower = clean.toLowerCase();
    if (tokens.some(t => t.kind === "text" && t.value === lower)) return;
    tokens.push({ kind: "text", value: lower, label });
  };

  pushText(profile?.dealerName, "dealer name");
  pushText(profile?.agentName, "persona name");
  pushText(profile?.address?.city, "city");
  pushText(profile?.address?.zip, "zip");

  // Street line without the number/suffix noise: "1149 Erie Ave." → "erie ave".
  const line1 = String(profile?.address?.line1 ?? "").trim();
  if (line1) {
    const street = line1
      .replace(/^\s*\d+\s*/, "")
      .replace(/\.$/, "")
      .trim();
    pushText(street, "street");
  }

  // Website host only — the scheme and any path are noise.
  const site = String(profile?.website ?? "").trim();
  if (site) {
    const host = site
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./i, "")
      .trim();
    pushText(host, "website");
  }

  // Phone as bare digits so any formatting matches: (716) 692-7200, 716-692-7200,
  // +17166927200 all reduce to the same run.
  const digits = String(profile?.phone ?? "").replace(/\D+/g, "");
  if (digits.length >= 10) {
    tokens.push({ kind: "phone", value: digits.slice(-10), label: "phone" });
  }

  for (const literal of extraLiterals) pushText(literal, "known short form");
  return tokens;
}

export type IdentityLeak = {
  /** Which probe or scenario produced the leaking text. */
  source: string;
  /** The identity token that escaped. */
  token: string;
  tokenLabel: string;
  /** A short window around the hit, for the report. */
  excerpt: string;
};

/**
 * Scan one produced string for another dealer's identity.
 *
 * Text tokens match case-insensitively on the raw string. The phone token matches on the
 * digits-only reduction of the text, so formatting can't hide it.
 */
export function scanForIdentityLeaks(
  source: string,
  text: string,
  tokens: IdentityToken[]
): IdentityLeak[] {
  const leaks: IdentityLeak[] = [];
  const raw = String(text ?? "");
  if (!raw) return leaks;
  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D+/g, "");

  for (const token of tokens) {
    if (token.kind === "text") {
      const at = lower.indexOf(token.value);
      if (at < 0) continue;
      leaks.push({
        source,
        token: token.value,
        tokenLabel: token.label,
        excerpt: raw.slice(Math.max(0, at - 40), at + token.value.length + 40).trim()
      });
      continue;
    }
    if (digits.includes(token.value)) {
      leaks.push({
        source,
        token: token.value,
        tokenLabel: token.label,
        excerpt: raw.slice(0, 120).trim()
      });
    }
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// Layer C — the fallback-site audit.
// ---------------------------------------------------------------------------

export type FallbackSite = {
  file: string;
  line: number;
  /**
   * FAIL DIRECTION, the thing that makes this list actionable:
   *  - "identity_fallback": `?? "American Harley-Davidson"` — a profile miss signs a
   *    STRANGER dealer's customer message with OUR name. Fix: route through the neutral
   *    generic already in agentVoice.ts (GENERIC_DEALER_DISPLAY_NAME).
   *  - "hardcoded_matcher": an AH literal inside a pattern/allowlist — silently never
   *    fires for a stranger dealer, so a real customer signal is missed.
   *  - "pinned_identity": AH assigned to a config/identity field outright.
   *  - "pinned_url": a hardcoded AH web address. The worst-behaved class in practice —
   *    the FIRST live run of this harness caught one reaching a stranger dealer's
   *    customer as a working shopping link ("you can pick an in-stock bike:
   *    https://americanharley-davidson.com/..."). Note that the portability ratchet in
   *    rollout_readiness_report.ts CANNOT see these: it greps "american harley" with a
   *    space, and the host form has none. That is why this audit keeps its own literal
   *    set instead of reusing the ratchet's — the two counts are meant to differ.
   *  - "other": mentions the literal in some other position; needs a human read.
   */
  failDirection:
    | "identity_fallback"
    | "hardcoded_matcher"
    | "pinned_identity"
    | "pinned_url"
    | "other";
  snippet: string;
};

/** Includes the no-space host form ("americanharley") the ratchet's pattern misses. */
const AH_SOURCE_LITERAL = /american harley|north tonawanda|americanharley/i;
/** A hardcoded http(s) URL on an AH host. */
const AH_URL_LITERAL = /https?:\/\/[^\s"'`]*americanharley[^\s"'`]*/i;
/** Comment-only lines: prose about AH is not a portability defect. Mirrors the
 *  countAhHardcodes ratchet in rollout_readiness_report.ts so the two agree. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

/**
 * Is the AH literal on this line inside a real REGEX LITERAL (a matcher), rather than
 * inside prose that merely contains slashes?
 *
 * The naive `/…american harley…/` test misfires on LLM-prompt strings like
 *   "the letterhead / 'from' / 'remit to' party — never 'American Harley-Davidson'"
 * where the slashes are punctuation (mdfAssistant.ts, 2 sites). Two cheap constraints
 * kill that class without missing real matchers:
 *   1. The character right after the opening slash is not whitespace — regexes start with
 *      a pattern atom (`(`, `\b`, `[`, a letter), prose slashes are surrounded by spaces.
 *   2. The closing slash carries at least one regex flag, or is immediately applied
 *      (`.test(` / `.match(` / `.exec(`). Every matcher in this codebase does one or both.
 * A flagless, unapplied regex would fall through to "other" — the human-read bucket —
 * which is the safe direction for a classifier nobody should have to trust blindly.
 */
function isRegexLiteralMatch(text: string): boolean {
  const literal = /\/(?!\s)[^/\n]*(?:american harley|north tonawanda)[^/\n]*\/([gimsuy]*)/i;
  const match = literal.exec(text);
  if (!match) return false;
  if (match[1]) return true;
  const after = text.slice(match.index + match[0].length);
  return /^\s*\.(?:test|match|exec)\s*\(/.test(after);
}

/**
 * Walk services/api/src and classify every non-comment AH literal by fail direction.
 * Returns null when the tree isn't present (fail-closed at the caller).
 */
export function auditAhFallbackSites(root = "services/api/src"): FallbackSite[] | null {
  if (!fs.existsSync(root)) return null;
  const sites: FallbackSite[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
      lines.forEach((text, index) => {
        if (COMMENT_LINE.test(text)) return;
        if (!AH_SOURCE_LITERAL.test(text)) return;
        let failDirection: FallbackSite["failDirection"] = "other";
        if (AH_URL_LITERAL.test(text)) {
          failDirection = "pinned_url";
        } else if (/(\?\?|\|\|)\s*["'`][^"'`]*american harley/i.test(text)) {
          failDirection = "identity_fallback";
        } else if (isRegexLiteralMatch(text)) {
          failDirection = "hardcoded_matcher";
        } else if (/(?:dealerName|clientName|name)\s*:\s*["'`][^"'`]*american harley/i.test(text)) {
          failDirection = "pinned_identity";
        }
        sites.push({
          file: full,
          line: index + 1,
          failDirection,
          snippet: text.trim().slice(0, 160)
        });
      });
    }
  };

  walk(root);
  return sites;
}

// ---------------------------------------------------------------------------
// Probes.
// ---------------------------------------------------------------------------

/**
 * Env vars that PIN A DEALER. A stranger run that inherits these is measuring the host
 * dealer's configuration wearing a stranger's name — and it fails in the dangerous
 * direction, BOTH ways:
 *   - False alarm: the first live run of this harness reported an American Harley
 *     inventory link leaking into a stranger's test-ride reply. It was not a product
 *     defect. The developer `.env` sets INVENTORY_LIST_URLS to AH's list URL, and
 *     inventoryUrlResolver's env branch is (correctly) an unconditional operator
 *     override with no host filter — so the harness fed the stranger AH's own URL.
 *   - False clean: DEALER_ID is worse. With DATA_BACKEND=file, getDealerId() defaults
 *     to "americanharley", which is exactly the id inventoryFeed.ts keys its legacy
 *     feed default on — so an un-neutralized stranger run silently reads AH's
 *     inventory and would report the feed path as fine.
 * Neutralizing is therefore part of the measurement, not setup hygiene. What was
 * changed is recorded in the report so a run is reproducible and auditable.
 */
export const DEALER_PINNING_ENV_VARS = [
  "INVENTORY_LIST_URLS",
  "INVENTORY_SITE_DOMAIN",
  "INVENTORY_XML_URL",
  "DEALER_PROFILE_PATH",
  "DEALER_ID",
  "DEALER_SLUG"
] as const;

/** Slug for the stranger, so getDealerId() cannot fall through to the host dealer. */
export const STRANGER_DEALER_SLUG = "greatlakes-sandusky";

/**
 * Clear every dealer-pinning var, then set the two the stranger legitimately owns
 * (its profile path and its slug). Returns a record of what changed, for the report.
 */
export function neutralizeDealerScopedEnv(strangerProfilePath: string): {
  cleared: string[];
  set: Record<string, string>;
} {
  const cleared: string[] = [];
  for (const name of DEALER_PINNING_ENV_VARS) {
    if (process.env[name] != null && String(process.env[name]).trim() !== "") {
      cleared.push(name);
      delete process.env[name];
    }
  }
  const set: Record<string, string> = {
    DEALER_PROFILE_PATH: strangerProfilePath,
    DEALER_ID: STRANGER_DEALER_SLUG,
    DEALER_SLUG: STRANGER_DEALER_SLUG
  };
  for (const [name, value] of Object.entries(set)) process.env[name] = value;
  return { cleared, set };
}

export type Probe = {
  id: string;
  layer: "A_config" | "B_copy" | "D_live";
  label: string;
  /** The produced customer-facing text (or a description for non-text assertions). */
  produced: string;
  ok: boolean;
  error?: string;
};

/**
 * Layers A + B. Writes the stranger profile to a temp dir, proves the runtime loader
 * adopts it from config alone, then drives the real customer-facing copy builders with
 * that identity.
 *
 * Note on module caching: domain/dealerProfile.ts caches by resolved path, so setting
 * DEALER_PROFILE_PATH before the dynamic import is what makes layer A honest.
 */
export async function runOfflineProbes(): Promise<{
  probes: Probe[];
  env: { cleared: string[]; set: Record<string, string> };
}> {
  const probes: Probe[] = [];
  const record = (
    id: string,
    layer: Probe["layer"],
    label: string,
    fn: () => Promise<string> | string
  ) =>
    Promise.resolve()
      .then(fn)
      .then(produced => probes.push({ id, layer, label, produced: String(produced ?? ""), ok: true }))
      .catch(err =>
        // Fail-CLOSED: an exception is a failed probe, never a silent skip.
        probes.push({
          id,
          layer,
          label,
          produced: "",
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      );

  // --- Layer A: config-only provisioning. ---
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stranger-dealer-"));
  const profilePath = path.join(tmpDir, "dealer_profile.json");
  fs.writeFileSync(profilePath, JSON.stringify(STRANGER_DEALER, null, 2));
  // Must happen BEFORE any domain import: the host dealer's env would otherwise be
  // measured wearing the stranger's name (see DEALER_PINNING_ENV_VARS).
  const env = neutralizeDealerScopedEnv(profilePath);

  await record("env_neutralized", "A_config", "No dealer-pinning env var survives into the run", () => {
    const survivors = DEALER_PINNING_ENV_VARS.filter(name => {
      const value = String(process.env[name] ?? "").trim();
      if (!value) return false;
      // The stranger's own profile path and slug are the two we deliberately set.
      return value !== profilePath && value !== STRANGER_DEALER_SLUG;
    });
    if (survivors.length) {
      throw new Error(`host-dealer env leaked into the run: ${survivors.join(", ")}`);
    }
    return `cleared [${env.cleared.join(", ") || "none"}]; pinned to the stranger: ${Object.keys(env.set).join(", ")}`;
  });

  await record("config_load", "A_config", "Runtime loads the stranger profile from config alone", async () => {
    const { getDealerProfile } = await import("../services/api/src/domain/dealerProfile.ts");
    const loaded = await getDealerProfile();
    const name = String((loaded as any)?.dealerName ?? "");
    if (name !== STRANGER_DEALER.dealerName) {
      throw new Error(`loader returned "${name}" instead of the configured stranger dealer`);
    }
    // Serialize the whole profile so the leak scan sees every field the runtime holds.
    return JSON.stringify(loaded);
  });

  const voice = await import("../services/api/src/domain/agentVoice.ts");
  const dealer = STRANGER_DEALER.dealerName;
  const agent = STRANGER_DEALER.agentName;

  await record("agent_name_configured", "A_config", "Agent name resolves to the stranger's persona", () => {
    const resolved = voice.resolveDealerAgentName(STRANGER_DEALER);
    if (resolved !== agent) throw new Error(`expected "${agent}", got "${resolved}"`);
    return resolved;
  });

  await record("agent_name_unset", "A_config", "Missing persona falls back to the neutral generic", () => {
    const resolved = voice.resolveDealerAgentName({});
    if (resolved !== voice.GENERIC_AGENT_DISPLAY_NAME) {
      throw new Error(`expected the generic stand-in, got "${resolved}"`);
    }
    return resolved;
  });

  await record("dealer_name_unset", "A_config", "Missing dealer name falls back to the neutral generic", () => {
    const resolved = voice.buildMarketingUnsubscribeFooter(null);
    if (resolved !== voice.GENERIC_DEALER_DISPLAY_NAME) {
      throw new Error(`expected the generic stand-in, got "${resolved}"`);
    }
    return resolved;
  });

  // --- Layer B: the real customer-facing copy builders. ---
  await record("intro", "B_copy", "First-touch intro line", () => voice.buildAgentIntro("Dana", agent, dealer));
  await record("intro_phrase", "B_copy", "Intro phrase", () => voice.buildAgentIntroPhrase(agent, dealer));
  await record("unsubscribe_footer", "B_copy", "Marketing unsubscribe footer", () =>
    voice.buildMarketingUnsubscribeFooter(dealer)
  );
  await record("event_promo_ack", "B_copy", "Sweepstakes/event ack", () =>
    voice.buildEventPromoAck("Dana", agent, dealer)
  );
  await record("marketing_opt_in_ack", "B_copy", "Mailing-list opt-in ack", () =>
    voice.buildMarketingOptInAck("Dana", agent, dealer)
  );
  await record("demo_ride_soft_invite", "B_copy", "GLA demo-ride soft invite", () =>
    voice.buildDemoRideEventSoftInvite("Dana", agent, dealer, "Street Glide")
  );
  await record("non_buyer_survey_ack", "B_copy", "Non-buyer survey ack", () =>
    voice.buildNonBuyerSurveyAck("Dana", agent, dealer)
  );
  await record("buyer_survey_ack", "B_copy", "Buyer survey ack", () =>
    voice.buildBuyerSurveyAck("Dana", agent, dealer, "Road Glide")
  );
  await record("watch_available", "B_copy", "Inventory-watch in-stock reply", () =>
    voice.buildWatchAvailableReply({
      firstName: "Dana",
      bikeLabel: "2026 Harley-Davidson Road Glide",
      unitColor: "Vivid Black",
      watchedColor: "Vivid Black",
      availability: "in_stock"
    })
  );
  await record("watch_sibling_scope", "B_copy", "Watch sibling-scope ask", () =>
    voice.buildWatchSiblingScopeAsk({
      firstName: "Dana",
      watchModelLabel: "Road Glide",
      unitLabel: "2026 Harley-Davidson Road Glide Special"
    })
  );
  await record("price_objection_watch", "B_copy", "Price-objection cheaper-watch reply", () =>
    voice.buildPriceObjectionCheaperWatchReply("Road Glide")
  );

  return { probes, env };
}

/**
 * Canonical inbound scenarios for the live layer. Chosen for leak yield: location and
 * hours questions force address/schedule copy, and the first-touch cases force the
 * intro line — the three places a dealer's identity is most likely to surface.
 */
export const LIVE_SCENARIOS: { id: string; label: string; body: string; history: { direction: "in" | "out"; body: string }[] }[] = [
  { id: "new_lead_availability", label: "New lead asks if a bike is available", body: "Is the 2024 Street Glide still available?", history: [] },
  { id: "location", label: "Where are you located?", body: "Where are you guys located?", history: [] },
  { id: "hours", label: "Are you open Sunday?", body: "Are you guys open on Sunday?", history: [] },
  { id: "pricing", label: "Out-the-door price", body: "What's the out the door price on that one?", history: [{ direction: "in", body: "Is the 2024 Street Glide still available?" }] },
  { id: "test_ride", label: "Test-ride request", body: "Can I come test ride it Saturday?", history: [] },
  { id: "trade", label: "Trade-in mention", body: "I'd want to trade in my 2019 Road King", history: [] },
  { id: "service", label: "Service request", body: "My bike needs an oil change, can you get me in this week?", history: [] },
  { id: "first_time_rider", label: "First-time rider question", body: "I've never ridden before, do I need a license first?", history: [] }
];

/**
 * Layer D — real turns through the production orchestrator as the stranger dealer.
 *
 * `orchestrateInbound` takes the dealer profile in ctx and RETURNS a draft; it does not
 * persist or send. So this exercises the real engine with zero risk to American Harley's
 * store and zero possibility of texting a real customer.
 */
export async function runLiveProbes(): Promise<Probe[]> {
  const probes: Probe[] = [];
  const { orchestrateInbound } = await import("../services/api/src/domain/orchestrator.ts");

  for (const scenario of LIVE_SCENARIOS) {
    try {
      const result = await orchestrateInbound(
        {
          channel: "sms" as any,
          provider: "twilio",
          from: "+14195550188",
          to: "+14195550142",
          body: scenario.body,
          receivedAt: new Date().toISOString()
        },
        scenario.history,
        { dealerProfile: STRANGER_DEALER, agentNameOverride: STRANGER_DEALER.agentName }
      );
      probes.push({
        id: `live_${scenario.id}`,
        layer: "D_live",
        label: scenario.label,
        produced: String((result as any)?.draft ?? ""),
        ok: true
      });
    } catch (err) {
      probes.push({
        id: `live_${scenario.id}`,
        layer: "D_live",
        label: scenario.label,
        produced: "",
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return probes;
}

// ---------------------------------------------------------------------------
// Grading + the report the scorecard reads.
// ---------------------------------------------------------------------------

export type StrangerTestResult = {
  /** TRUE only from a live run with zero leaks and zero probe errors. */
  passed: boolean;
  at: string;
  detail: string;
  mode: "offline" | "live";
  probesRun: number;
  probesFailed: number;
  /** Which dealer-pinning env vars were cleared, and what the stranger was pinned to. */
  env: { cleared: string[]; set: Record<string, string> } | null;
  leaks: IdentityLeak[];
  fallbackSites: {
    total: number;
    byFailDirection: Record<string, number>;
    /** The worst class, itemized: these leak our name into a stranger's message. */
    identityFallbacks: FallbackSite[];
    /** These silently never fire for a stranger dealer. */
    hardcodedMatchers: FallbackSite[];
    /** Hardcoded AH web addresses — proven to reach a stranger's customer as a live link. */
    pinnedUrls: FallbackSite[];
  } | null;
};

/**
 * Grade a run. The anti-flattery rules live here so they are pinnable by the eval:
 *   1. Any leak  ⇒ failed.
 *   2. Any probe error ⇒ failed (fail-closed; a check that threw is not a check that passed).
 *   3. A missing source audit ⇒ failed (we cannot claim clean on unread code).
 *   4. Offline mode can NEVER pass, however clean — the live turns are the actual test.
 * The identity-fallback count does NOT by itself fail the run: those sites are latent
 * (they need a profile-load miss to bite), and letting them block would leave the
 * section stuck at FAILED with no way to distinguish "leaks today" from "leaks if
 * config hiccups". They are reported as the ranked fix list instead.
 */
export function gradeStrangerTest(args: {
  mode: "offline" | "live";
  probes: Probe[];
  leaks: IdentityLeak[];
  fallbackSites: FallbackSite[] | null;
  at: string;
  env?: { cleared: string[]; set: Record<string, string> } | null;
}): StrangerTestResult {
  const { mode, probes, leaks, fallbackSites, at } = args;
  const probesFailed = probes.filter(p => !p.ok).length;

  const byFailDirection: Record<string, number> = {};
  for (const site of fallbackSites ?? []) {
    byFailDirection[site.failDirection] = (byFailDirection[site.failDirection] ?? 0) + 1;
  }
  const identityFallbacks = (fallbackSites ?? []).filter(s => s.failDirection === "identity_fallback");
  const hardcodedMatchers = (fallbackSites ?? []).filter(s => s.failDirection === "hardcoded_matcher");
  const pinnedUrls = (fallbackSites ?? []).filter(s => s.failDirection === "pinned_url");

  const reasons: string[] = [];
  if (leaks.length) {
    const kinds = [...new Set(leaks.map(l => l.tokenLabel))].join(", ");
    reasons.push(`${leaks.length} identity leak(s) into stranger-dealer output (${kinds})`);
  }
  if (probesFailed) reasons.push(`${probesFailed} probe(s) errored`);
  if (!fallbackSites) reasons.push("source audit could not run (services/api/src not found)");
  if (mode === "offline") reasons.push("offline scan only — live turns not run, so the test is incomplete");

  const passed = reasons.length === 0;
  const cleanNote = `${probes.length} probe(s) clean`;
  const debtNote = fallbackSites
    ? `; ${identityFallbacks.length} latent identity fallback(s) + ${hardcodedMatchers.length} hardcoded matcher(s) + ${pinnedUrls.length} pinned AH URL(s) still in source`
    : "";

  return {
    passed,
    at,
    detail: passed ? `${cleanNote}${debtNote}` : `${reasons.join("; ")}${debtNote}`,
    mode,
    probesRun: probes.length,
    probesFailed,
    env: args.env ?? null,
    leaks,
    fallbackSites: fallbackSites
      ? {
          total: fallbackSites.length,
          byFailDirection,
          identityFallbacks,
          hardcodedMatchers,
          pinnedUrls
        }
      : null
  };
}

function renderMarkdown(result: StrangerTestResult): string {
  const lines: string[] = [];
  lines.push(`# Stranger test — ${result.passed ? "PASSED" : "ATTEMPTED, FAILED"}`);
  lines.push("");
  lines.push(`Ran ${result.at} in **${result.mode}** mode as "${STRANGER_DEALER.dealerName}".`);
  if (result.env) {
    lines.push("");
    lines.push(
      `Dealer-pinning env cleared: ${result.env.cleared.length ? "`" + result.env.cleared.join("`, `") + "`" : "none present"}. ` +
        "A run that inherits the host dealer's env measures the wrong dealer — in both directions."
    );
  }
  lines.push("");
  lines.push(result.detail);
  lines.push("");
  if (result.leaks.length) {
    lines.push("## Identity leaks (each one is another dealer's name reaching this dealer's output)");
    for (const leak of result.leaks) {
      lines.push(`- **${leak.source}** leaked the ${leak.tokenLabel} \`${leak.token}\` — "${leak.excerpt}"`);
    }
    lines.push("");
  }
  if (result.fallbackSites) {
    lines.push("## Source debt a stranger dealer would inherit");
    lines.push(
      `- ${result.fallbackSites.identityFallbacks.length} identity fallbacks — a profile-load miss signs their customer's text with our name`
    );
    lines.push(
      `- ${result.fallbackSites.hardcodedMatchers.length} hardcoded matchers — never fire for a dealer with a different name or city`
    );
    lines.push(
      `- ${result.fallbackSites.pinnedUrls.length} pinned AH web addresses — reach a stranger's customer as a working link`
    );
    lines.push("");
    if (result.fallbackSites.pinnedUrls.length) {
      lines.push("### Pinned AH URLs (invisible to the portability ratchet — it greps for a space)");
      for (const site of result.fallbackSites.pinnedUrls) {
        lines.push(`- \`${site.file}:${site.line}\` — \`${site.snippet}\``);
      }
      lines.push("");
    }
    if (result.fallbackSites.hardcodedMatchers.length) {
      lines.push("### Hardcoded matchers (highest value to fix — these are silent misses)");
      for (const site of result.fallbackSites.hardcodedMatchers) {
        lines.push(`- \`${site.file}:${site.line}\` — \`${site.snippet}\``);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const index = argv.indexOf(name);
    if (index >= 0) return argv[index + 1] || "";
    const prefix = `${name}=`;
    return argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || "";
  };
  const live = argv.includes("--live");
  const reportRoot = arg("--report-root") || process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const outDir = path.join(reportRoot, "stranger_test");

  // The identity that must not escape: read AH's live profile if present. Falls back to
  // the known literals alone so the scan still works off-box.
  const ahProfilePath =
    arg("--protect-profile") || path.resolve(process.cwd(), "services/api/data/dealer_profile.json");
  let ahProfile: any = null;
  try {
    ahProfile = JSON.parse(fs.readFileSync(ahProfilePath, "utf8"));
  } catch {
    ahProfile = null;
  }
  const tokens = buildIdentityLeakTokens(ahProfile);

  const { probes, env } = await runOfflineProbes();
  if (live) probes.push(...(await runLiveProbes()));

  const leaks: IdentityLeak[] = [];
  for (const probe of probes) {
    leaks.push(...scanForIdentityLeaks(`${probe.layer}/${probe.id}`, probe.produced, tokens));
  }

  const result = gradeStrangerTest({
    mode: live ? "live" : "offline",
    probes,
    leaks,
    fallbackSites: auditAhFallbackSites(),
    at: new Date().toISOString(),
    env
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "latest.md"), renderMarkdown(result) + "\n");

  console.log(
    JSON.stringify(
      {
        ok: true,
        passed: result.passed,
        mode: result.mode,
        probesRun: result.probesRun,
        probesFailed: result.probesFailed,
        leaks: result.leaks.length,
        identityFallbacks: result.fallbackSites?.identityFallbacks.length ?? null,
        hardcodedMatchers: result.fallbackSites?.hardcodedMatchers.length ?? null,
        pinnedUrls: result.fallbackSites?.pinnedUrls.length ?? null,
        outDir
      },
      null,
      2
    )
  );
}

// Only run when invoked directly — the eval imports this module for its own fixtures.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
