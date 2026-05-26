import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

type Provider = "twilio" | "sendgrid_adf";
type Verdict = "candidate_safe" | "review" | "expected_no_response" | "no_response" | "error";

type ReplayArgs = {
  dataDir: string;
  envFile?: string;
  provider: "all" | Provider;
  limit: number;
  sinceDays: number;
  outDir: string;
  twilioTo: string;
  keepTemp: boolean;
  caseNumbers: number[];
};

type ConversationMessage = {
  id?: string;
  direction?: "in" | "out";
  from?: string;
  to?: string;
  body?: string;
  at?: string;
  provider?: string;
  providerMessageId?: string;
};

type Conversation = {
  id: string;
  status?: string;
  closedReason?: string;
  leadKey?: string;
  messages?: ConversationMessage[];
  lead?: any;
  latestLead?: any;
  classification?: any;
  followUp?: any;
  appointment?: any;
  inventoryWatch?: any;
  inventoryWatches?: any;
  lastDecision?: any;
};

type Candidate = {
  id: string;
  provider: Provider;
  conversationId: string;
  leadKey?: string;
  customerName?: string;
  messageIndex: number;
  messageId?: string;
  messageAt?: string;
  from: string;
  to: string;
  body: string;
};

type ReplayCaseResult = Candidate & {
  status: "completed" | "failed";
  responseStatus?: number;
  responseBodySnippet?: string;
  draft: string | null;
  twilioDeliveryDryRun?: boolean;
  twilioDeliveredMessageCount?: number;
  verdict: Verdict;
  reviewReasons: string[];
  router: {
    intent?: string | null;
    stage?: string | null;
    classificationBucket?: string | null;
    classificationCta?: string | null;
    followUpMode?: string | null;
    followUpReason?: string | null;
    dialogState?: string | null;
    conversationMode?: string | null;
    debugFlow?: any;
  };
  dataSources: string[];
  error?: string;
};

function usage(): never {
  console.error(`Usage:
  npm run inbound_shadow:replay -- --data-dir <DATA_DIR> [--provider all|twilio|adf] [--limit 20]

Options:
  --data-dir <path>       Source API data directory. Required.
  --env-file <path>       Optional API env file to load for the temporary process.
  --provider <name>       all, twilio, or adf. Default: all.
  --limit <n>             Max replay cases. Default: 20.
  --since-days <n>        Only consider inbound messages newer than this. Default: 14.
  --out-dir <path>        Report directory. Default: reports/inbound-shadow.
  --twilio-to <phone>     Fallback dealer Twilio number for replay. Default: +17164032516.
  --case-numbers <list>   Optional 1-based case numbers after filtering, e.g. 5,25,38.
  --keep-temp             Keep temporary copied data folders for inspection.
`);
  process.exit(1);
}

function parseArgs(argv: string[]): ReplayArgs {
  const out: ReplayArgs = {
    dataDir: "",
    provider: "all",
    limit: 20,
    sinceDays: 14,
    outDir: "reports/inbound-shadow",
    twilioTo: "+17164032516",
    keepTemp: false,
    caseNumbers: []
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) usage();
      return value;
    };
    if (arg === "--data-dir") out.dataDir = next();
    else if (arg === "--env-file") out.envFile = next();
    else if (arg === "--provider") {
      const raw = next().toLowerCase();
      if (raw === "adf") out.provider = "sendgrid_adf";
      else if (raw === "twilio" || raw === "sendgrid_adf" || raw === "all") out.provider = raw as any;
      else usage();
    } else if (arg === "--limit") out.limit = Math.max(1, Number.parseInt(next(), 10) || 20);
    else if (arg === "--since-days") out.sinceDays = Math.max(1, Number.parseInt(next(), 10) || 14);
    else if (arg === "--out-dir") out.outDir = next();
    else if (arg === "--twilio-to") out.twilioTo = next();
    else if (arg === "--case-numbers") {
      out.caseNumbers = next()
        .split(",")
        .map(part => Number.parseInt(part.trim(), 10))
        .filter(num => Number.isFinite(num) && num > 0);
      if (!out.caseNumbers.length) usage();
    }
    else if (arg === "--keep-temp") out.keepTemp = true;
    else usage();
  }
  if (!out.dataDir) usage();
  out.dataDir = path.resolve(out.dataDir);
  out.outDir = path.resolve(out.outDir);
  if (out.envFile) out.envFile = path.resolve(out.envFile);
  return out;
}

async function readJson<T = any>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: any): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeProvider(raw?: string | null): Provider | null {
  const provider = String(raw ?? "").trim().toLowerCase();
  if (provider === "twilio") return "twilio";
  if (provider === "sendgrid_adf") return "sendgrid_adf";
  return null;
}

function normalizePhone(raw?: string | null): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+") && digits.length >= 10) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return text;
}

function leadDisplayName(conv: Conversation): string | undefined {
  const lead = conv.latestLead ?? conv.lead ?? {};
  const name = String(lead.name ?? [lead.firstName, lead.lastName].filter(Boolean).join(" ")).trim();
  return name || undefined;
}

function extractField(body: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function extractInquiry(body: string): string {
  const match = body.match(/(?:^|\n)Inquiry:\s*\n?([\s\S]*)$/i);
  const text = (match?.[1] ?? body).trim();
  return text.replace(/\n(?:View lead|Lead)$/i, "").trim();
}

function stripControlChars(text: string): string {
  return String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
}

function xmlEscape(text: string): string {
  return stripControlChars(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cdata(text: string): string {
  return stripControlChars(text).replace(/\]\]>/g, "]]]]><![CDATA[>");
}

function adfXmlForCandidate(candidate: Candidate, conv: Conversation): string {
  const lead = conv.latestLead ?? conv.lead ?? {};
  const vehicle = lead.vehicle ?? {};
  const body = candidate.body;
  const inquiry = extractInquiry(body) || String(lead.inquiry ?? "");
  const leadRef = extractField(body, "Ref") || String(lead.leadRef ?? "");
  const source = extractField(body, "Source") || String(lead.source ?? "LeadRider shadow replay");
  const name = extractField(body, "Name") || String(lead.name ?? leadDisplayName(conv) ?? "Shadow Customer");
  const [firstFallback, ...lastParts] = name.split(/\s+/);
  const first = String(lead.firstName ?? firstFallback ?? "Shadow").trim();
  const last = String(lead.lastName ?? lastParts.join(" ") ?? "Customer").trim();
  const phone = normalizePhone(extractField(body, "Phone") || lead.phone || candidate.from).replace(/^\+1/, "");
  const email = extractField(body, "Email") || String(lead.email ?? "");
  const year = extractField(body, "Year") || String(vehicle.year ?? "");
  const make = String(vehicle.make ?? "HARLEY-DAVIDSON");
  const model =
    extractField(body, "Vehicle").replace(/^HARLEY-DAVIDSON\s+/i, "").trim() ||
    String(vehicle.model ?? vehicle.description ?? "Full Line");
  const stock = extractField(body, "Stock") || String(vehicle.stockId ?? "");
  const vin = extractField(body, "VIN") || String(vehicle.vin ?? "");
  const color = String(vehicle.color ?? "");
  const requestDate = candidate.messageAt || new Date().toISOString();
  const commentLines = [
    inquiry,
    lead.preferredDate ? `Preferred date: ${lead.preferredDate}` : "",
    lead.preferredTime ? `Preferred time: ${lead.preferredTime}` : "",
    lead.walkInComment ? `Customer Comments: ${lead.walkInComment}` : ""
  ].filter(Boolean);

  return `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
  <prospect>
    <requestdate>${xmlEscape(requestDate)}</requestdate>
    <id sequence="1" source="Traffic Log Pro">${xmlEscape(leadRef || `shadow-${Date.now()}`)}</id>
    <vehicle interest="buy" status="NEW">
      <year>${xmlEscape(year)}</year>
      <make>${xmlEscape(make)}</make>
      <model>${xmlEscape(model)}</model>
      <stock>${xmlEscape(stock)}</stock>
      <vin>${xmlEscape(vin)}</vin>
      <price currency="USD">${vehicle.listPrice ? xmlEscape(String(vehicle.listPrice)) : "0.00"}</price>
      <colorcombination><exteriorcolor>${xmlEscape(color)}</exteriorcolor></colorcombination>
    </vehicle>
    <customer>
      <contact>
        <name part="first">${xmlEscape(first)}</name>
        <name part="last">${xmlEscape(last)}</name>
        <email>${xmlEscape(email)}</email>
        <phone type="cellphone">${xmlEscape(phone)}</phone>
        <comment><![CDATA[${cdata(commentLines.join("\n"))}]]></comment>
      </contact>
    </customer>
    <vendor>
      <vendorname>American Harley-Davidson</vendorname>
    </vendor>
    <provider>
      <name part="full" type="individual">${xmlEscape(source)}</name>
    </provider>
  </prospect>
</adf>`;
}

function isValidInboundBody(body: string): boolean {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length < 3) return false;
  if (/^(yes|no|ok|okay|thanks?|thank you|👍|👎)$/i.test(text)) return false;
  return true;
}

function selectCandidates(snapshot: any, args: ReplayArgs): Candidate[] {
  const conversations: Conversation[] = Array.isArray(snapshot.conversations) ? snapshot.conversations : [];
  const cutoffMs = Date.now() - args.sinceDays * 24 * 60 * 60 * 1000;
  const candidates: Candidate[] = [];
  for (const conv of conversations) {
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.direction !== "in") continue;
      const provider = normalizeProvider(message.provider);
      if (!provider) continue;
      if (args.provider !== "all" && provider !== args.provider) continue;
      const body = String(message.body ?? "").trim();
      if (!isValidInboundBody(body)) continue;
      const atMs = Date.parse(String(message.at ?? ""));
      if (Number.isFinite(atMs) && atMs < cutoffMs) continue;
      const from =
        provider === "twilio"
          ? normalizePhone(message.from) || normalizePhone(conv.lead?.phone) || normalizePhone(conv.leadKey)
          : String(message.from ?? conv.lead?.email ?? conv.lead?.phone ?? conv.leadKey ?? "").trim();
      const to = provider === "twilio" ? normalizePhone(message.to) || args.twilioTo : String(message.to ?? "dealership");
      if (!from || !body) continue;
      candidates.push({
        id: `${provider}_${conv.id}_${message.id ?? index}`.replace(/[^a-zA-Z0-9_.:-]/g, "_"),
        provider,
        conversationId: conv.id,
        leadKey: conv.leadKey,
        customerName: leadDisplayName(conv),
        messageIndex: index,
        messageId: message.id,
        messageAt: message.at,
        from,
        to,
        body
      });
    }
  }
  return candidates
    .sort((a, b) => Date.parse(b.messageAt ?? "") - Date.parse(a.messageAt ?? ""))
    .slice(0, args.limit);
}

async function loadEnvFile(envFile?: string): Promise<Record<string, string>> {
  if (!envFile) return {};
  const raw = await fs.readFile(envFile, "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]!] = value;
  }
  return env;
}

function caseMode(provider: Provider): "suggest" | "autopilot" {
  return provider === "twilio" ? "autopilot" : "suggest";
}

async function prepareCaseData(args: ReplayArgs, candidate: Candidate, rootDir: string): Promise<{
  caseDir: string;
  dataDir: string;
  jobsPath: string;
  convBefore: Conversation;
  adfXml?: string;
}> {
  const caseDir = await fs.mkdtemp(path.join(rootDir, `${candidate.provider}-`));
  const dataDir = path.join(caseDir, "data");
  await fs.cp(args.dataDir, dataDir, { recursive: true });

  const conversationsPath = path.join(dataDir, "conversations.json");
  const snapshot = await readJson<any>(conversationsPath);
  const conversations: Conversation[] = Array.isArray(snapshot.conversations) ? snapshot.conversations : [];
  const conv = conversations.find(c => c.id === candidate.conversationId);
  if (!conv) throw new Error(`conversation not found in temp data: ${candidate.conversationId}`);
  const originalConv = JSON.parse(JSON.stringify(conv)) as Conversation;
  conv.messages = (conv.messages ?? []).slice(0, candidate.messageIndex);
  conv.updatedAt = candidate.messageAt ?? conv.updatedAt;

  const selectedAtMs = Date.parse(candidate.messageAt ?? "");
  if (Array.isArray(snapshot.todos) && Number.isFinite(selectedAtMs)) {
    snapshot.todos = snapshot.todos.filter((todo: any) => {
      if (todo?.convId !== candidate.conversationId) return true;
      const createdMs = Date.parse(String(todo?.createdAt ?? todo?.updatedAt ?? ""));
      return !Number.isFinite(createdMs) || createdMs < selectedAtMs;
    });
  }
  await writeJson(conversationsPath, snapshot);
  await writeJson(path.join(dataDir, "settings.json"), {
    version: 1,
    savedAt: new Date().toISOString(),
    mode: caseMode(candidate.provider)
  });

  let adfXml: string | undefined;
  if (candidate.provider === "sendgrid_adf") {
    adfXml = adfXmlForCandidate(candidate, originalConv);
  }
  return {
    caseDir,
    dataDir,
    jobsPath: path.join(dataDir, "twilio_inbound_jobs_shadow.json"),
    convBefore: originalConv,
    adfXml
  };
}

async function findFreePort(): Promise<number> {
  await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 150)));
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port assigned"))));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(port: number, child: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`temporary API exited early (${child.exitCode}): ${logs.slice(-20).join("\n")}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`temporary API did not become healthy: ${logs.slice(-20).join("\n")}`);
}

function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

async function startApi(args: {
  dataDir: string;
  jobsPath: string;
  envFileVars: Record<string, string>;
  port: number;
}): Promise<{ child: ChildProcessWithoutNullStreams; logs: string[] }> {
  const root = repoRoot();
  const entry = path.join(root, "services/api/dist/index.js");
  try {
    await fs.access(entry);
  } catch {
    throw new Error("services/api/dist/index.js is missing. Run `npm --workspace @throttleiq/api run build` first.");
  }
  const logs: string[] = [];
  const env = {
    ...process.env,
    ...args.envFileVars,
    NODE_ENV: "shadow",
    PORT: String(args.port),
    DATA_DIR: args.dataDir,
    SETTINGS_DB_PATH: path.join(args.dataDir, "settings.json"),
    TWILIO_INBOUND_JOBS_PATH: args.jobsPath,
    TWILIO_INBOUND_JOBS_MAX_ROWS: "200",
    ASYNC_TWILIO_WEBHOOK_ENABLED: "1",
    ASYNC_TWILIO_WEBHOOK_SUGGEST_ONLY: "0",
    ASYNC_TWILIO_AUTOPILOT_DELIVERY_ENABLED: "1",
    ASYNC_TWILIO_AUTOPILOT_DELIVERY_DRY_RUN: "1",
    ASYNC_TWILIO_WEBHOOK_MAX_ATTEMPTS: "1",
    ASYNC_TWILIO_INTERNAL_URL: `http://127.0.0.1:${args.port}/webhooks/twilio`,
    GOOGLE_KEEPALIVE_ENABLED: "false",
    SUPPORT_MAIL_AUTO_POLL_ENABLED: "false",
    PERSONAL_MAIL_AUTO_POLL_ENABLED: "false",
    CLAUDE_AGENT_ENABLED: "false",
    AUTH_DISABLED: "1",
    // The API constructs the OpenAI client at module load. A real env file should
    // be supplied for production-quality shadow runs; this fallback only allows
    // local deterministic smoke tests to boot.
    OPENAI_API_KEY: args.envFileVars.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "shadow-replay-no-live-key"
  };
  const child = spawn(process.execPath, ["--import", "./dist/domain/sentryInit.js", "dist/index.js"], {
    cwd: path.join(root, "services/api"),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const collect = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) logs.push(line.slice(0, 1000));
    }
    if (logs.length > 300) logs.splice(0, logs.length - 300);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  await waitForHealth(args.port, child, logs);
  return { child, logs };
}

async function stopApi(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 4000;
  while (child.exitCode == null && Date.now() < deadline) await sleep(100);
  if (child.exitCode == null) child.kill("SIGKILL");
}

function extractTwimlBody(xml: string): string | null {
  const match = String(xml ?? "").match(/<Message\b[^>]*>([\s\S]*?)<\/Message>/i);
  if (!match) return null;
  return match[1]!
    .replace(/<Media\b[^>]*>[\s\S]*?<\/Media>/gi, "")
    .replace(/<Body\b[^>]*>([\s\S]*?)<\/Body>/i, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

async function submitTwilio(port: number, candidate: Candidate): Promise<{
  responseStatus: number;
  responseBodySnippet: string;
  providerMessageId: string;
}> {
  const providerMessageId = `SMshadow${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const body = new URLSearchParams();
  body.set("From", normalizePhone(candidate.from));
  body.set("To", normalizePhone(candidate.to) || "+17164032516");
  body.set("Body", candidate.body);
  body.set("MessageSid", providerMessageId);
  body.set("SmsSid", providerMessageId);
  body.set("NumMedia", "0");
  const res = await fetch(`http://127.0.0.1:${port}/webhooks/twilio`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const text = await res.text();
  return {
    responseStatus: res.status,
    responseBodySnippet: text.slice(0, 500),
    providerMessageId
  };
}

async function waitForTwilioJob(jobsPath: string, providerMessageId: string): Promise<any | null> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const rows = await readJson<any[]>(jobsPath);
      const hit = Array.isArray(rows) ? rows.find(row => row.providerMessageId === providerMessageId) : null;
      if (hit?.status === "completed" || hit?.status === "failed") return hit;
    } catch {
      // keep waiting
    }
    await sleep(400);
  }
  return null;
}

async function submitAdf(port: number, candidate: Candidate, adfXml: string): Promise<{
  responseStatus: number;
  responseBodySnippet: string;
  draft: string | null;
  intent?: string | null;
  stage?: string | null;
  bucket?: string | null;
  cta?: string | null;
}> {
  const body = new URLSearchParams();
  body.set("text", adfXml);
  body.set("from", "shadow-replay@leadrider.ai");
  body.set("to", "crm@americanharley.leadrider.ai");
  body.set("MessageID", `adf_shadow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  body.set("subject", `ADF shadow replay ${candidate.conversationId}`);
  const res = await fetch(`http://127.0.0.1:${port}/crm/leads/adf/sendgrid`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {
    responseStatus: res.status,
    responseBodySnippet: text.slice(0, 500),
    draft: typeof parsed?.draft === "string" ? parsed.draft : null,
    intent: parsed?.intent ?? null,
    stage: parsed?.stage ?? null,
    bucket: parsed?.bucket ?? null,
    cta: parsed?.cta ?? null
  };
}

async function readConversation(dataDir: string, conversationId: string): Promise<Conversation | null> {
  const snapshot = await readJson<any>(path.join(dataDir, "conversations.json"));
  const conversations: Conversation[] = Array.isArray(snapshot.conversations) ? snapshot.conversations : [];
  return conversations.find(conv => conv.id === conversationId) ?? null;
}

function latestOutboundAfter(conv: Conversation | null, beforeCount: number): ConversationMessage | null {
  const messages = conv?.messages ?? [];
  const added = messages.slice(beforeCount);
  return [...added].reverse().find(message => message.direction === "out") ?? null;
}

function isExpectedNoCustomerReply(inbound: string): boolean {
  const text = inbound.replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return false;
  if (/^(ok|okay|cool|great|perfect|sounds good|thank you|thanks|ty|👍)[.!?\s]*$/i.test(text)) return true;
  const hasQuestion = /\?|\b(can|could|would|do|does|did|is|are|will|what|when|where|why|how)\b/i.test(text);
  if (hasQuestion) return false;
  if (/\b(thanks?|thank you|appreciate|have a great day|sounds good|perfect|ok|okay)\b/i.test(text)) return true;
  if (/\b(i'?ll be there|i will be there|be there by then|see you then|talk soon|touch base)\b/i.test(text)) return true;
  if (
    /\b(let me (?:do some figuring out|figure|find|check)|i(?:'|’)ll (?:let|give) you (?:know|a time|a timeframe|a time frame)|give you a time\s*frame|let you know soon)\b/i.test(
      text
    )
  ) {
    return true;
  }
  return false;
}

function isDealerLeadAppOutcomeAdf(provider: Provider, inbound: string): boolean {
  if (provider !== "sendgrid_adf") return false;
  return /\b(?:dealer lead app|demo bikes ridden|marketing questions:)\b/i.test(inbound);
}

function isWrongNumberInbound(inbound: string): boolean {
  return /\b(wrong\s+number|you\s+(?:have|got)\s+the\s+wrong\s+number|not\s+(?:me|mine|this\s+person)|who\s+is\s+this)\b/i.test(
    inbound
  );
}

function classifyDraft(provider: Provider, inbound: string, draft: string | null, conv?: Conversation | null): {
  verdict: Verdict;
  reasons: string[];
} {
  const reasons: string[] = [];
  const inboundLower = inbound.toLowerCase();
  const draftText = String(draft ?? "").trim();
  const draftLower = draftText.toLowerCase();
  if (!draftText) {
    if (isDealerLeadAppOutcomeAdf(provider, inbound)) {
      return {
        verdict: "expected_no_response",
        reasons: ["Dealer Lead App outcome/task ADF has no customer-facing auto-reply by design"]
      };
    }
    if (
      isWrongNumberInbound(inbound) &&
      (String(conv?.status ?? "").toLowerCase() === "closed" ||
        String(conv?.closedReason ?? "").toLowerCase() === "wrong_number")
    ) {
      return {
        verdict: "expected_no_response",
        reasons: ["wrong-number suppression closed the conversation"]
      };
    }
    if (String((conv as any)?.mode ?? "").toLowerCase() === "human") {
      return {
        verdict: "expected_no_response",
        reasons: ["human mode suppresses customer-facing auto replies by design"]
      };
    }
    if (isExpectedNoCustomerReply(inbound)) {
      return {
        verdict: "expected_no_response",
        reasons: ["acknowledgement/signoff where no customer-facing reply is expected"]
      };
    }
    return { verdict: "no_response", reasons: ["no customer-facing draft/reply produced"] };
  }
  const riderCourseInquiry =
    /\b(msf|riding academy|rider academy|riding course|rider course|motorcycle class|motorcycle course|your course|course and price)\b/i.test(
      inboundLower
    ) ||
    /\b(course|class)\b[\s\S]{0,80}\b(?:get|getting|obtain|earn)\s+(?:my\s+|a\s+)?(?:motorcycle\s+)?(?:license|licence|endorsement|permit)\b/i.test(
      inboundLower
    ) ||
    /\b(?:motorcycle\s+)?(?:license|licence|endorsement|permit)\b[\s\S]{0,80}\b(course|class)\b/i.test(
      inboundLower
    );
  const draftHandsOff =
    /\b(i don'?t want to guess|i'?ll have (the )?(team|manager|finance)|confirm .*follow up|verify .*follow up)\b/i.test(
      draftText
    );
  if (draftText.length < 12) reasons.push("very short draft");
  if (/\b(and|or|to|the|when|if|with|for|can|could|would|should|will)$/i.test(draftText)) {
    reasons.push("draft appears truncated");
  }
  if (draftHandsOff && !riderCourseInquiry) {
    reasons.push("draft hands off instead of answering directly");
  }
  if (draftHandsOff && riderCourseInquiry) {
    reasons.push("rider-course pricing/availability needs configured answer");
  }
  if (
    !riderCourseInquiry &&
    /\b(apr|interest|finance|financing|payment|monthly|credit|approved|approval|co-?sign|price|out the door|otd)\b/i.test(
      inboundLower
    )
  ) {
    reasons.push("finance/pricing-sensitive inbound");
  }
  if (riderCourseInquiry && /\b(payment|monthly|down|term|street 750|bike|motorcycle|finance|financing)\b/i.test(draftLower)) {
    reasons.push("rider-course inquiry drifted to vehicle/payment response");
  }
  if (/\bthe the\b/i.test(draftText)) {
    reasons.push("draft contains duplicate article");
  }
  if (/\b(rider\s*(to|2)\s*rider|r2r|private seller|another dealer|dealer trade)\b/i.test(inboundLower)) {
    reasons.push("policy-sensitive rider-to-rider/dealer-trade inbound");
  }
  if (/\b(service|inspection|parts?|warranty|recall|repair)\b/i.test(inboundLower)) {
    reasons.push("department routing-sensitive inbound");
  }
  if (/\b(appointment|schedule|available|availability|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s*(am|pm))\b/i.test(inboundLower)) {
    reasons.push("scheduling-sensitive inbound");
  }
  if (/\b(open|closed|hours?)\b/i.test(inboundLower) && /\bwould\s+\d{1,2}(:\d{2})?\s*(am|pm)?\s+work\b/i.test(inboundLower) && /\bhave that time noted\b/i.test(draftLower)) {
    reasons.push("accepted time without answering hours/open question");
  }
  if (/\b(let me (figure|find|check)|i'?ll (let|give) you (know|a time)|time frame)\b/i.test(inboundLower) && /\bwhat time|works best|what day\b/i.test(draftLower)) {
    reasons.push("asks for time after customer said they will provide it");
  }
  if (provider === "sendgrid_adf" && /\(open view lead|open view lead for full details\)/i.test(inboundLower)) {
    reasons.push("ADF body may be missing full lead context");
  }
  return {
    verdict: reasons.length ? "review" : "candidate_safe",
    reasons
  };
}

function dataSourcesFor(candidate: Candidate, conv: Conversation | null): string[] {
  const out = new Set<string>();
  out.add(candidate.provider === "twilio" ? "Twilio webhook replay" : "SendGrid ADF route replay");
  if (conv?.lead) out.add("conversation lead profile");
  if (conv?.latestLead) out.add("latest ADF lead profile");
  if (conv?.inventoryWatch || conv?.inventoryWatches) out.add("inventory watch state");
  if (conv?.appointment) out.add("appointment state");
  if (conv?.followUp) out.add("follow-up state");
  return [...out];
}

async function replayOne(
  args: ReplayArgs,
  envFileVars: Record<string, string>,
  rootTempDir: string,
  candidate: Candidate
): Promise<ReplayCaseResult> {
  let caseData: Awaited<ReturnType<typeof prepareCaseData>> | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let logs: string[] = [];
  try {
    caseData = await prepareCaseData(args, candidate, rootTempDir);
    const port = await findFreePort();
    const started = await startApi({
      dataDir: caseData.dataDir,
      jobsPath: caseData.jobsPath,
      envFileVars,
      port
    });
    child = started.child;
    logs = started.logs;

    const beforeCount = candidate.messageIndex;
    let responseStatus: number | undefined;
    let responseBodySnippet: string | undefined;
    let draft: string | null = null;
    let twilioDeliveryDryRun: boolean | undefined;
    let twilioDeliveredMessageCount: number | undefined;
    let adfRouter: Partial<ReplayCaseResult["router"]> = {};

    if (candidate.provider === "twilio") {
      const postResult = await submitTwilio(port, candidate);
      responseStatus = postResult.responseStatus;
      responseBodySnippet = postResult.responseBodySnippet;
      const job = await waitForTwilioJob(caseData.jobsPath, postResult.providerMessageId);
      if (!job) throw new Error("timed out waiting for Twilio shadow job");
      if (job.status === "failed") throw new Error(job.lastError || "Twilio shadow job failed");
      draft = extractTwimlBody(job.responseBody ?? "");
      twilioDeliveryDryRun = job.deliveryDryRun === true;
      twilioDeliveredMessageCount = draft ? 1 : 0;
      responseStatus = job.responseStatus ?? responseStatus;
      responseBodySnippet = String(job.responseBodySnippet ?? responseBodySnippet ?? "");
    } else {
      const adfXml = caseData.adfXml;
      if (!adfXml) throw new Error("ADF XML could not be generated");
      const postResult = await submitAdf(port, candidate, adfXml);
      responseStatus = postResult.responseStatus;
      responseBodySnippet = postResult.responseBodySnippet;
      draft = postResult.draft;
      adfRouter = {
        intent: postResult.intent ?? null,
        stage: postResult.stage ?? null,
        classificationBucket: postResult.bucket ?? null,
        classificationCta: postResult.cta ?? null
      };
    }

    await sleep(250);
    const convAfter = await readConversation(caseData.dataDir, candidate.conversationId);
    if (!draft) {
      const outbound = latestOutboundAfter(convAfter, beforeCount);
      draft = outbound?.body?.trim() || null;
    }
    const classification = classifyDraft(candidate.provider, candidate.body, draft, convAfter);
    return {
      ...candidate,
      status: "completed",
      responseStatus,
      responseBodySnippet,
      draft,
      twilioDeliveryDryRun,
      twilioDeliveredMessageCount,
      verdict: classification.verdict,
      reviewReasons: classification.reasons,
      router: {
        intent: adfRouter.intent ?? convAfter?.lastDecision?.intent ?? null,
        stage: adfRouter.stage ?? null,
        classificationBucket: adfRouter.classificationBucket ?? convAfter?.classification?.bucket ?? null,
        classificationCta: adfRouter.classificationCta ?? convAfter?.classification?.cta ?? null,
        followUpMode: convAfter?.followUp?.mode ?? null,
        followUpReason: convAfter?.followUp?.reason ?? null,
        dialogState: convAfter ? (convAfter as any).dialogState?.name ?? (convAfter as any).dialogState ?? null : null,
        conversationMode: (convAfter as any)?.mode ?? null,
        debugFlow: convAfter?.lastDecision ?? null
      },
      dataSources: dataSourcesFor(candidate, convAfter)
    };
  } catch (err: any) {
    return {
      ...candidate,
      status: "failed",
      draft: null,
      verdict: "error",
      reviewReasons: ["shadow replay failed"],
      router: {},
      dataSources: dataSourcesFor(candidate, caseData?.convBefore ?? null),
      error: `${err?.message ?? err}${logs.length ? `\nRecent API logs:\n${logs.slice(-20).join("\n")}` : ""}`
    };
  } finally {
    if (child) await stopApi(child);
    if (caseData && !args.keepTemp) {
      await fs.rm(caseData.caseDir, { recursive: true, force: true });
    }
  }
}

function truncate(text: string | null | undefined, max = 220): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function mdEscape(text: string | null | undefined): string {
  return truncate(text, 180).replace(/\|/g, "\\|");
}

function buildMarkdownReport(report: any): string {
  const lines: string[] = [];
  lines.push(`# Inbound Shadow Replay`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Source data: \`${report.sourceDataDir}\``);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- Cases replayed: ${report.summary.total}`);
  lines.push(`- Candidate safe: ${report.summary.candidateSafe}`);
  lines.push(`- Needs review: ${report.summary.review}`);
  lines.push(`- Expected no response: ${report.summary.expectedNoResponse}`);
  lines.push(`- No response: ${report.summary.noResponse}`);
  lines.push(`- Errors: ${report.summary.error}`);
  lines.push("");
  lines.push(`## Cases`);
  lines.push("");
  lines.push(`| Verdict | Provider | Customer | Inbound | Draft / Would-send | Reasons |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const row of report.cases as ReplayCaseResult[]) {
    lines.push(
      `| ${row.verdict} | ${row.provider} | ${mdEscape(row.customerName ?? row.leadKey ?? row.conversationId)} | ${mdEscape(row.body)} | ${mdEscape(row.draft ?? row.error)} | ${mdEscape(row.reviewReasons.join("; "))} |`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceSnapshot = await readJson<any>(path.join(args.dataDir, "conversations.json"));
  const allCandidates = selectCandidates(sourceSnapshot, args);
  const candidates = args.caseNumbers.length
    ? args.caseNumbers.map(num => allCandidates[num - 1]).filter((candidate): candidate is Candidate => !!candidate)
    : allCandidates;
  if (!candidates.length) {
    console.log("No inbound candidates matched the replay filters.");
    return;
  }
  const envFileVars = await loadEnvFile(args.envFile);
  const rootTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lr-inbound-shadow-"));
  const cases: ReplayCaseResult[] = [];
  try {
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i]!;
      console.log(
        `[${i + 1}/${candidates.length}] shadow replay ${candidate.provider} ${candidate.customerName ?? candidate.leadKey ?? candidate.conversationId}`
      );
      cases.push(await replayOne(args, envFileVars, rootTempDir, candidate));
    }
  } finally {
    if (!args.keepTemp) await fs.rm(rootTempDir, { recursive: true, force: true });
  }

  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const summary = {
    total: cases.length,
    candidateSafe: cases.filter(row => row.verdict === "candidate_safe").length,
    review: cases.filter(row => row.verdict === "review").length,
    expectedNoResponse: cases.filter(row => row.verdict === "expected_no_response").length,
    noResponse: cases.filter(row => row.verdict === "no_response").length,
    error: cases.filter(row => row.verdict === "error").length
  };
  const report = {
    generatedAt,
    sourceDataDir: args.dataDir,
    provider: args.provider,
    limit: args.limit,
    sinceDays: args.sinceDays,
    summary,
    cases
  };
  await fs.mkdir(args.outDir, { recursive: true });
  const jsonPath = path.join(args.outDir, `inbound-shadow-${stamp}.json`);
  const mdPath = path.join(args.outDir, `inbound-shadow-${stamp}.md`);
  await writeJson(jsonPath, report);
  await fs.writeFile(mdPath, buildMarkdownReport(report), "utf8");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(
    `Summary: ${summary.candidateSafe} safe, ${summary.review} review, ${summary.expectedNoResponse} expected no response, ${summary.noResponse} no response, ${summary.error} error.`
  );
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err?.stack ?? err?.message ?? err);
    process.exit(1);
  });
