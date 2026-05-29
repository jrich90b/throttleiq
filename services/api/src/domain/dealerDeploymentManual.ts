import { buildDealerApiDeployment, type DealerSetup } from "./dealerSetupStore.js";

type ManualFormat = "markdown" | "html";

function todayLabel() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date());
}

function clean(value: unknown, fallback = "Not captured") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function mdEscape(value: unknown) {
  return String(value ?? "").replace(/\|/g, "\\|").trim();
}

function stepStatus(setup: DealerSetup, stepId: string) {
  return setup.steps.find(step => step.id === stepId)?.status ?? "pending";
}

function statusText(value: string) {
  return value.replace(/_/g, " ");
}

function table(headers: string[], rows: string[][]) {
  return [
    `| ${headers.map(mdEscape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${row.map(mdEscape).join(" | ")} |`)
  ].join("\n");
}

function bulletList(items: Array<string | undefined | null>) {
  return items.filter(Boolean).map(item => `- ${item}`).join("\n");
}

function codeBlock(value: string, language = "text") {
  return `\`\`\`${language}\n${value.trim()}\n\`\`\``;
}

function americanHarleyNotes(setup: DealerSetup) {
  if (setup.slug !== "americanharley") return "";
  return [
    "## American Harley Current Production Notes",
    "",
    "American Harley is the first client and currently runs on the clean multi-client path while retaining the original PM2 process name for continuity.",
    "",
    table(["Item", "Current value"], [
      ["Clean API checkout", "/home/ubuntu/leadrider-api/americanharley"],
      ["Runtime data", "/home/ubuntu/leadrider-runtime/americanharley/data"],
      ["Runtime env", "/home/ubuntu/leadrider-runtime/americanharley/api.env"],
      ["PM2 process", "throttleiq-api"],
      ["Public API health", "https://api.americanharley.leadrider.ai/health"],
      ["Rollback/source backup", "/home/ubuntu/throttleiq and /home/ubuntu/throttleiq-runtime are intentionally still present"]
    ]),
    "",
    "Do not remove old American Harley server folders until the clean path has been stable through a quiet production window and runtime dependencies have been audited."
  ].join("\n");
}

function buildStepRows(setup: DealerSetup) {
  const detailByStep: Record<string, string> = {
    intake: "Confirm dealer name, website, owner, legal name, DBA, address, contact, plan, and billing terms.",
    domains: "Prepare web/API subdomains and DNS records. Continue other steps while DNS waits or propagates.",
    sendgrid: "Configure sender/domain authentication, DNS records, inbound parse, and reply-to. DNS can wait in parallel.",
    twilio: "Configure number, webhooks, consent, STOP/HELP, A2P/10DLC, and routing. Approval can take days.",
    google: "Connect Gmail, support mail, calendar, users, and OAuth callbacks.",
    inventory: "Capture and validate the dealer inventory feed or export URL.",
    crm: "Confirm ADF source mappings, CRM provider behavior, owner routing, and Twilio route mapping.",
    profile: "Confirm dealer profile, tone, rules, feature flags, privacy policy, TCPA wording, and SMS consent language.",
    remote_env: "Add production secrets only on the server runtime env file.",
    api: "Prepare the clean API tenant/runtime deployment profile and rollback path.",
    vercel: "Prepare or verify the dealer web hostname and frontend settings in Vercel.",
    manual: "Generate and review the dealer deployment manual.",
    smoke: "Run web, API, provider, inventory, conversation, and webhook smoke checks.",
    launch_gate: "Review launch checklist, remote env, compliance, smoke results, rollback, and monitoring.",
    handoff: "Move to Active Clients only after go-live blockers are clear and launch is approved."
  };
  return setup.steps.map(step => [
    step.label,
    statusText(step.status),
    detailByStep[step.id] ?? "Work this setup item and update the setup record."
  ]);
}

function buildManualMarkdown(setup: DealerSetup) {
  const deployment = buildDealerApiDeployment(setup);
  const readiness = setup.deployReadiness;
  const launchRows = (setup.launchChecklist ?? []).map(item => [item.label, item.status, item.detail]);
  const envRows = (setup.remoteEnvChecklist ?? []).map(item => [
    item.category,
    item.key,
    item.required ? "Required" : "Optional",
    item.secret ? "Secret" : item.valueHint || "",
    item.description
  ]);

  const providerCallbacks = [
    ["Google OAuth", `${setup.apiUrl.replace(/\/$/, "")}/integrations/google/callback`],
    ["Twilio inbound SMS", `${setup.apiUrl.replace(/\/$/, "")}/webhooks/twilio`],
    ["SendGrid inbound ADF/email", `${setup.apiUrl.replace(/\/$/, "")}/crm/leads/adf/sendgrid`],
    ["Public widget API base", setup.apiUrl]
  ];

  const smsConsent = [
    "Lead/contact forms must show consent language before submit.",
    "Privacy Policy and Terms links must be live.",
    "Consent should mention call, text, and email contact about the inquiry.",
    "Consent is not a condition of purchase.",
    "Message/data rates may apply.",
    "Reply STOP to opt out and HELP for help.",
    "Mobile opt-in data should not be sold or shared for third-party marketing.",
    "Website consent can wait in parallel, but SMS go-live should wait until verified."
  ];

  return [
    `# ${setup.dealerName} Dealer Deployment Manual`,
    "",
    `Generated: ${todayLabel()} ET`,
    "",
    "This is the living deployment manual for this dealer setup. It is generated from the Dealer Setup record plus the current LeadRider deployment model, so new setup steps, stack changes, and launch gates should be reflected here when the setup code is updated.",
    "",
    "## Operator Summary",
    "",
    table(["Field", "Value"], [
      ["Dealer", setup.dealerName],
      ["Slug", setup.slug],
      ["Website", clean(setup.website)],
      ["LeadRider app", setup.appUrl],
      ["LeadRider API", setup.apiUrl],
      ["Command", setup.commandUrl],
      ["Owner", clean(setup.owner)],
      ["Primary contact", clean(setup.primaryContact)],
      ["Plan", clean(setup.plan)],
      ["Monthly fee", clean(setup.monthlyFee)],
      ["Setup fee", clean(setup.setupFee)],
      ["Legal name", clean(setup.legalName)],
      ["DBA", clean(setup.dbaName || setup.dealerName)],
      ["Dealer address", clean(setup.dealerAddress)]
    ]),
    "",
    americanHarleyNotes(setup),
    "",
    "## Deployment Shape",
    "",
    "LeadRider currently uses a split deployment: the dealer web UI is hosted on Vercel and the always-on API remains on Lightsail/PM2 for webhooks, runtime data, background work, and browser-runner tasks.",
    "",
    table(["Layer", "Value"], [
      ["Web hostname", deployment.webHostname],
      ["API hostname", deployment.apiHostname],
      ["API checkout", deployment.repoPath],
      ["Runtime env", deployment.envFile],
      ["Runtime data", deployment.dataDir],
      ["PM2 process", deployment.pm2Process],
      ["Health check", deployment.healthUrl],
      ["Deploy profile", deployment.deployProfileLocalPath]
    ]),
    "",
    "## Setup Flow",
    "",
    "Work the setup steps in order, but do not let slow third-party approvals stop unrelated work. DNS, SMS/A2P approval, Google OAuth, SendGrid verification, optional Meta review, and dealer website edits can wait in parallel. They block go-live, not the rest of onboarding.",
    "",
    table(["Step", "Current status", "What to do"], buildStepRows(setup)),
    "",
    "## Go-Live Gate",
    "",
    readiness
      ? table(["Readiness item", "Value"], [
          ["Status", readiness.label],
          ["Summary", readiness.summary],
          ["Can deploy API", readiness.canDeployApi ? "Yes" : "No"],
          ["Can push to Active Clients", readiness.canPushToActiveClient ? "Yes" : "No"],
          ["Still needed for go-live", (readiness.goLiveMissing ?? readiness.missing ?? []).join(", ") || "None"],
          ["Blockers", readiness.blockers.join(", ") || "None"],
          ["Warnings", readiness.warnings.join(", ") || "None"]
        ])
      : "Readiness is not available yet. Refresh the dealer setup record.",
    "",
    "## DNS Records",
    "",
    table(["Type", "Name", "Value", "Purpose"], deployment.dnsRecords.map(record => [record.type, record.name, record.value, record.purpose])),
    "",
    "## Provider URLs And Callbacks",
    "",
    table(["Provider", "URL"], providerCallbacks),
    "",
    "## SMS Consent And Privacy Gate",
    "",
    bulletList(smsConsent),
    "",
    "Suggested website form disclosure:",
    "",
    "> By submitting, you agree that the dealership may contact you at the phone number and email provided by call, text, or email about your inquiry. Consent is not a condition of purchase. Message and data rates may apply. Reply STOP to opt out or HELP for help. See our Privacy Policy and Terms of Use.",
    "",
    "## Remote API Environment",
    "",
    "Secrets must stay on the server and out of git. Use the Dealer Setup env checklist to copy the template, then fill real secret values directly in the remote env file.",
    "",
    envRows.length
      ? table(["Category", "Key", "Need", "Value hint", "Purpose"], envRows)
      : "No remote env checklist was generated yet.",
    "",
    "## API Deploy Procedure",
    "",
    "1. Confirm the code is committed and pushed.",
    "2. Confirm the remote runtime env file exists and has dealer-specific values.",
    "3. Confirm runtime data is outside the git checkout.",
    "4. Deploy with the generated profile.",
    "5. Confirm public health and run smoke tests.",
    "",
    codeBlock(`npm run deploy:api -- --profile ${deployment.deployProfileLocalPath}`, "bash"),
    "",
    "Generated deploy profile:",
    "",
    codeBlock(deployment.profileText, "bash"),
    "",
    "## Smoke Test Checklist",
    "",
    bulletList([
      "Open the dealer web UI.",
      "Open the public API health URL.",
      "Open one representative conversation.",
      "Verify inventory loads.",
      "Verify SendGrid inbound ADF/email route is configured.",
      "Verify Twilio inbound webhook points to this dealer API.",
      "Verify outbound SMS can send from the dealer number.",
      "Verify outbound email can send from the dealer sender.",
      "Verify Google calendar/users are connected where required.",
      "Verify Meta app callback and app status if Campaign Studio is enabled.",
      "Verify MDF/browser runner registration if this dealer uses portal automation."
    ]),
    "",
    "## Launch Checklist Snapshot",
    "",
    launchRows.length
      ? table(["Item", "Status", "Detail"], launchRows)
      : "No launch checklist was generated yet.",
    "",
    "## Rollback And Archive Rules",
    "",
    bulletList([
      "Every API deploy backs up the dealer runtime data directory first.",
      "Do not delete old server folders immediately after moving to a clean checkout.",
      "Keep rollback folders until the clean path has been stable through a quiet production window.",
      "Do not deploy over a dirty remote checkout during normal releases.",
      "Do not edit built production files directly except for a documented emergency hotfix.",
      "Never put API keys, Twilio tokens, SendGrid keys, Google secrets, Meta secrets, or customer data into this manual."
    ]),
    "",
    "## What To Update When The Product Changes",
    "",
    "When LeadRider adds a setup step, provider, runner, compliance requirement, or launch gate, update the Dealer Setup step model and this manual generator in the same change. The Command UI will then show the updated manual for every setup record.",
    ""
  ].join("\n");
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, c => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
    return map[c] ?? c;
  });
}

function inlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function markdownToHtml(markdown: string, setup: DealerSetup) {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  let inQuote = false;
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let i = 0;

  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      html.push("</blockquote>");
      inQuote = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code class="language-${escapeHtml(codeLang)}">${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCode = false;
        codeLang = "";
        codeLines = [];
      } else {
        closeList();
        closeQuote();
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      i += 1;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      i += 1;
      continue;
    }
    if (!line.trim()) {
      closeList();
      closeQuote();
      i += 1;
      continue;
    }
    if (/^\|.+\|$/.test(line) && /^\|[\s:-|]+\|$/.test(lines[i + 1] ?? "")) {
      closeList();
      closeQuote();
      const headers = line.split("|").slice(1, -1).map(cell => cell.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i] ?? "")) {
        rows.push((lines[i] ?? "").split("|").slice(1, -1).map(cell => cell.trim()));
        i += 1;
      }
      html.push("<table><thead><tr>");
      headers.forEach(header => html.push(`<th>${inlineMarkdown(header)}</th>`));
      html.push("</tr></thead><tbody>");
      rows.forEach(row => {
        html.push("<tr>");
        row.forEach(cell => html.push(`<td>${inlineMarkdown(cell)}</td>`));
        html.push("</tr>");
      });
      html.push("</tbody></table>");
      continue;
    }
    if (line.startsWith("# ")) {
      closeList();
      closeQuote();
      html.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      closeList();
      closeQuote();
      html.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
    } else if (/^\d+\.\s+/.test(line)) {
      closeList();
      closeQuote();
      html.push(`<p>${inlineMarkdown(line)}</p>`);
    } else if (line.startsWith("- ")) {
      closeQuote();
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
    } else if (line.startsWith("> ")) {
      closeList();
      if (!inQuote) {
        html.push("<blockquote>");
        inQuote = true;
      }
      html.push(`<p>${inlineMarkdown(line.slice(2))}</p>`);
    } else {
      closeList();
      closeQuote();
      html.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    i += 1;
  }
  closeList();
  closeQuote();

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(setup.dealerName)} Deployment Manual</title>
  <style>
    :root { color-scheme: light; --text:#111827; --muted:#4b5563; --border:#d1d5db; --accent:#f97316; --soft:#f8fafc; }
    body { margin:0; background:#e5e7eb; color:var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .toolbar { position:sticky; top:0; z-index:2; display:flex; gap:10px; align-items:center; justify-content:space-between; padding:14px 22px; background:#0b1220; color:white; box-shadow:0 8px 24px rgba(15,23,42,.18); }
    .toolbar strong { font-size:15px; }
    .toolbar div { display:flex; gap:10px; flex-wrap:wrap; }
    .toolbar button, .toolbar a { border:1px solid rgba(255,255,255,.2); border-radius:8px; padding:9px 12px; background:#f97316; color:#111827; font-weight:800; text-decoration:none; cursor:pointer; }
    .toolbar a.secondary { background:transparent; color:white; }
    main { max-width:1040px; margin:28px auto; padding:42px; background:white; border:1px solid var(--border); border-radius:10px; box-shadow:0 18px 60px rgba(15,23,42,.15); }
    h1 { margin:0 0 18px; font-size:31px; letter-spacing:-.01em; }
    h2 { margin:34px 0 12px; padding-top:12px; border-top:1px solid var(--border); font-size:20px; }
    p, li, td, th { font-size:14px; line-height:1.55; }
    p { margin:8px 0; }
    ul { margin:8px 0 14px 22px; padding:0; }
    table { width:100%; border-collapse:collapse; margin:12px 0 20px; font-size:13px; }
    th { text-align:left; background:#111827; color:white; }
    th, td { border:1px solid var(--border); padding:9px 10px; vertical-align:top; }
    tr:nth-child(even) td { background:var(--soft); }
    code { padding:2px 5px; border-radius:5px; background:#eef2f7; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:14px; border-radius:8px; background:#0f172a; color:#f8fafc; font-size:12px; line-height:1.5; }
    pre code { background:transparent; color:inherit; padding:0; }
    blockquote { margin:14px 0; padding:12px 16px; border-left:4px solid var(--accent); background:#fff7ed; color:#7c2d12; }
    @media print {
      body { background:white; }
      .toolbar { display:none; }
      main { margin:0; padding:0; max-width:none; border:0; box-shadow:none; }
      h2 { break-after:avoid; }
      table, pre, blockquote { break-inside:avoid; }
    }
  </style>
</head>
<body>
  <section class="toolbar">
    <strong>${escapeHtml(setup.dealerName)} Deployment Manual</strong>
    <div>
      <button type="button" onclick="window.print()">Print</button>
      <a href="?format=markdown&download=1">Download Markdown</a>
      <a class="secondary" href="/command/clients/new">Back to Dealer Setup</a>
    </div>
  </section>
  <main>${html.join("\n")}</main>
</body>
</html>`;
}

export function buildDealerDeploymentManual(setup: DealerSetup, format: ManualFormat = "markdown") {
  const markdown = buildManualMarkdown(setup);
  if (format === "html") return { format, body: markdownToHtml(markdown, setup) };
  return { format, body: markdown };
}
