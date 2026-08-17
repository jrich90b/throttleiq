import { promises as dns } from "node:dns";
import {
  LightsailClient,
  GetDomainCommand,
  CreateDomainEntryCommand,
  UpdateDomainEntryCommand
} from "@aws-sdk/client-lightsail";
import { getDealerSetup, updateDealerSetup, buildDealerApiDeployment, type DealerSetup } from "./dealerSetupStore.js";

/**
 * Dealer DNS plan/apply (Phase 2 hands-off onboarding, Joe 2026-08-17).
 *
 * The leadrider.ai zone is a LIGHTSAIL DNS zone (Joe's screenshot 8/17 — Lightsail
 * "Domains & DNS", account 922454075137; same awsdns machinery, different API than
 * Route53, which is why "I don't use Route 53" and the NS lookup were both right). This module turns
 * the Dealer Setup record's generated DNS records into a reviewable PLAN (dry-run default:
 * desired vs currently-resolving, per-record action) and, behind an explicit apply that is
 * ALSO flag-gated (DEALER_DNS_APPLY_ENABLED, default OFF), creates/updates them via the
 * Lightsail domain API (create-or-update per entry; Lightsail has no batch upsert).
 *
 * Guardrails:
 *  - ZONE FENCE (deterministic compliance gate): every record name must sit inside
 *    leadrider.ai. A record outside the zone fails the whole plan — this tool can never
 *    write DNS for any other domain, no matter what a record generator produces.
 *  - Plan is the default; apply is a separate handler, flag-gated and credential-gated
 *    with explicit, actionable errors when AWS is not configured.
 *  - Verify-after-apply: the API acknowledges per entry; public resolvers lag
 *    (propagation), so the step note records the change id and the plan can be re-run to
 *    watch records converge.
 */

const ZONE_NAME = (process.env.LEADRIDER_DNS_ZONE || "leadrider.ai").toLowerCase().replace(/\.$/, "");

export function isDealerDnsApplyEnabled(): boolean {
  const raw = String(process.env.DEALER_DNS_APPLY_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function awsDnsCredentialsPresent(): boolean {
  return !!(String(process.env.AWS_ACCESS_KEY_ID ?? "").trim() && String(process.env.AWS_SECRET_ACCESS_KEY ?? "").trim());
}

export type DealerDnsPlanRecord = {
  type: "A" | "CNAME";
  name: string;
  desired: string;
  purpose: string;
  current: string[];
  action: "create" | "update" | "noop";
};

export type DealerDnsPlan = {
  zone: string;
  records: DealerDnsPlanRecord[];
  changes: number;
  blocked?: string;
};

export type DnsResolver = (name: string, type: "A" | "CNAME") => Promise<string[]>;

async function defaultResolver(name: string, type: "A" | "CNAME"): Promise<string[]> {
  try {
    if (type === "A") return await dns.resolve4(name);
    return (await dns.resolveCname(name)).map(v => v.replace(/\.$/, ""));
  } catch {
    return [];
  }
}

function insideZone(name: string): boolean {
  const clean = String(name ?? "").toLowerCase().replace(/\.$/, "");
  return clean === ZONE_NAME || clean.endsWith(`.${ZONE_NAME}`);
}

export async function buildDealerDnsPlan(
  setup: Pick<DealerSetup, "slug" | "routingMode" | "appUrl" | "apiUrl">,
  resolver: DnsResolver = defaultResolver
): Promise<DealerDnsPlan> {
  const desired = buildDealerApiDeployment(setup).dnsRecords;
  // ZONE FENCE: refuse the entire plan if any generated record leaves the zone.
  const outside = desired.filter(record => !insideZone(record.name));
  if (outside.length) {
    return {
      zone: ZONE_NAME,
      records: [],
      changes: 0,
      blocked: `refusing to plan records outside ${ZONE_NAME}: ${outside.map(r => r.name).join(", ")}`
    };
  }
  const records: DealerDnsPlanRecord[] = [];
  for (const record of desired) {
    const current = await resolver(record.name, record.type);
    const desiredValue = record.value.toLowerCase().replace(/\.$/, "");
    const normalized = current.map(v => v.toLowerCase().replace(/\.$/, ""));
    const action: DealerDnsPlanRecord["action"] = !normalized.length
      ? "create"
      : normalized.includes(desiredValue)
        ? "noop"
        : "update";
    records.push({ type: record.type, name: record.name, desired: record.value, purpose: record.purpose, current, action });
  }
  return { zone: ZONE_NAME, records, changes: records.filter(r => r.action !== "noop").length };
}

// Lightsail's domain APIs live only in us-east-1, regardless of where instances run.
async function applyPlanToLightsail(plan: DealerDnsPlan): Promise<{ changeId: string; upserted: number }> {
  const client = new LightsailClient({ region: "us-east-1" });
  const domain = await client.send(new GetDomainCommand({ domainName: ZONE_NAME }));
  const entries = domain.domain?.domainEntries ?? [];
  const norm = (v?: string | null) => String(v ?? "").toLowerCase().replace(/\.$/, "");
  let upserted = 0;
  const applied: string[] = [];
  for (const record of plan.records) {
    if (record.action === "noop") continue;
    const existing = entries.find(e => norm(e.name) === norm(record.name) && String(e.type ?? "") === record.type);
    const domainEntry = {
      name: record.name,
      target: record.desired,
      type: record.type,
      ...(existing?.id ? { id: existing.id } : {})
    };
    if (existing?.id) {
      await client.send(new UpdateDomainEntryCommand({ domainName: ZONE_NAME, domainEntry }));
      applied.push(`updated ${record.name}`);
    } else {
      await client.send(new CreateDomainEntryCommand({ domainName: ZONE_NAME, domainEntry }));
      applied.push(`created ${record.name}`);
    }
    upserted += 1;
  }
  return { changeId: applied.join("; ") || "(no changes)", upserted };
}

// ---------------------------------------------------------------------------
// Express handlers (one-line wiring in index.ts — source-size ratchet).
// ---------------------------------------------------------------------------

export async function dealerDnsPlanHandler(req: any, res: any) {
  const setup = await getDealerSetup(req.params.id);
  if (!setup) return res.status(404).json({ ok: false, error: "Dealer setup not found." });
  const plan = await buildDealerDnsPlan(setup);
  return res.json({
    ok: !plan.blocked,
    enabled: isDealerDnsApplyEnabled(),
    credentialed: awsDnsCredentialsPresent(),
    plan
  });
}

export async function dealerDnsApplyHandler(req: any, res: any) {
  if (!isDealerDnsApplyEnabled()) {
    return res.status(409).json({ ok: false, error: "DNS apply is disabled (DEALER_DNS_APPLY_ENABLED)." });
  }
  if (!awsDnsCredentialsPresent()) {
    return res.status(409).json({
      ok: false,
      error: "AWS credentials are not configured (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY with Lightsail DNS access)."
    });
  }
  const setup = await getDealerSetup(req.params.id);
  if (!setup) return res.status(404).json({ ok: false, error: "Dealer setup not found." });
  const plan = await buildDealerDnsPlan(setup);
  if (plan.blocked) return res.status(400).json({ ok: false, error: plan.blocked });
  try {
    const result = await applyPlanToLightsail(plan);
    const updated = await updateDealerSetup(setup.id, {
      stage: "dns",
      status: "in_progress",
      stepId: "domains",
      stepStatus: result.upserted ? "ready_to_verify" : "done",
      stepNote: result.upserted
        ? `Lightsail DNS: ${result.changeId} (${result.upserted} entr${result.upserted === 1 ? "y" : "ies"}). Re-run the plan to watch propagation.`
        : "DNS already matches — nothing to change."
    });
    console.log(`[dealer dns] applied ${result.upserted} change(s) for ${setup.slug} (${result.changeId})`);
    return res.json({ ok: true, result, plan, setup: updated ?? setup });
  } catch (err: any) {
    return res.status(502).json({ ok: false, error: String(err?.message ?? err).slice(0, 300), plan });
  }
}
