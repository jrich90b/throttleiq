import * as path from "node:path";
import type { DealerSetup } from "../services/api/src/domain/dealerSetupStore.js";

type SeedInput = {
  dealerName: string;
  slug: string;
  owner: string;
  primaryContact: string;
  legalName: string;
  dbaName: string;
  dealerAddress: string;
  website: string;
  crmProvider: string;
  leadVolume: string;
  plan: string;
  setupFee: string;
  monthlyFee: string;
  includedUsage: string;
  overageTerms: string;
  contractTerm: string;
  billingStart: string;
  notes: string;
};

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function configureDefaultStorePath() {
  if (process.env.DEALER_SETUPS_PATH?.trim()) return process.env.DEALER_SETUPS_PATH;
  const cwd = process.cwd();
  const isApiWorkspace = cwd.endsWith(path.join("services", "api"));
  const storePath = isApiWorkspace
    ? path.resolve(cwd, "data/dealer_setups.json")
    : path.resolve(cwd, "services/api/data/dealer_setups.json");
  process.env.DEALER_SETUPS_PATH = storePath;
  return storePath;
}

function buildSeedInput(): SeedInput {
  const slug = argValue("--slug") || "americanharley-sandbox";
  return {
    dealerName: argValue("--dealer-name") || "American Harley-Davidson Sandbox",
    slug,
    owner: argValue("--owner") || "Joe Hartrich",
    primaryContact: argValue("--primary-contact") || "Use live American Harley contacts only after explicit approval.",
    legalName: argValue("--legal-name") || "American Harley-Davidson, Inc.",
    dbaName: argValue("--dba-name") || "American Harley-Davidson",
    dealerAddress: argValue("--address") || "1149 Erie Ave, North Tonawanda, NY 14120",
    website: argValue("--website") || "https://americanharley-davidson.com",
    crmProvider: argValue("--crm") || "Traffic Log Pro, ADF email, Twilio SMS",
    leadVolume: argValue("--lead-volume") || "American Harley live baseline; validate before copying to a new dealer.",
    plan: argValue("--plan") || "Growth",
    setupFee: argValue("--setup-fee") || "$0 sandbox",
    monthlyFee: argValue("--monthly-fee") || "$0 sandbox",
    includedUsage: argValue("--included-usage") || "Sandbox workflow testing only. No production sends.",
    overageTerms: argValue("--overage-terms") || "Not applicable for sandbox.",
    contractTerm: argValue("--contract-term") || "Sandbox only",
    billingStart: argValue("--billing-start") || "Not applicable",
    notes: [
      "Seeded from the current American Harley baseline for multi-client setup testing.",
      "Do not deploy this sandbox without explicit approval.",
      "Do not change live American Harley DNS, Twilio, SendGrid, Google, CRM, or API env from this record.",
      "Inventory/export URL: https://americanharley-davidson.com/inventory/xml?location=127",
      "Tone: warm, direct, helpful dealership assistant; avoid over-promising availability, financing, or pricing.",
      "Rules: keep American Harley-specific copy isolated; manager verifies availability; no final vendor submissions; no credential or MFA automation; customer-facing replies stay on parser/router/orchestrator/publisher path.",
      "Compliance: verify privacy policy, SMS consent, TCPA wording, and STOP/HELP language before any production launch."
    ].join("\n")
  };
}

function findExisting(setups: DealerSetup[], input: SeedInput) {
  return setups.find(setup => setup.slug === input.slug);
}

async function main() {
  const input = buildSeedInput();
  const storePath = configureDefaultStorePath();
  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify({ ok: true, dryRun: true, storePath, input }, null, 2));
    return;
  }
  const { addDealerSetup, listDealerSetups, updateDealerSetup } = await import("../services/api/src/domain/dealerSetupStore.js");

  const existing = findExisting(await listDealerSetups(500), input);
  const setup = existing
    ? await updateDealerSetup(existing.id, input)
    : await addDealerSetup(input);
  if (!setup) throw new Error("Dealer setup could not be seeded.");

  console.log(JSON.stringify({
    ok: true,
    action: existing ? "updated" : "created",
    id: setup.id,
    dealerName: setup.dealerName,
    slug: setup.slug,
    appUrl: setup.appUrl,
    apiUrl: setup.apiUrl,
    dataDir: setup.apiDeployment?.dataDir,
    envFile: setup.apiDeployment?.envFile,
    storePath,
    manualUrl: `/api/dealer-setups/${encodeURIComponent(setup.id)}/manual?format=html`,
    nextStep: "Open Command > Dealer Setup, select the sandbox record, and run the guided workflow. Do not deploy."
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
