import fs from "fs";
import path from "path";

type Message = {
  provider?: string;
  direction?: string;
  body?: string;
};

type Conversation = {
  id?: string;
  leadKey?: string;
  messages?: Message[];
};

type DataFile = {
  conversations?: Conversation[];
};

function decodeQuotedPrintable(input: string): string {
  const softBreak = input.replace(/=\s*\r?\n/g, "");
  return softBreak.replace(/=([A-Fa-f0-9]{2})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function looksLikeMime(raw?: string | null): boolean {
  if (!raw) return false;
  return /(received:|arc-|dkim-|mime-version:|content-type:|message-id:)/i.test(raw);
}

function extractPlainTextFromMime(raw?: string | null): string | null {
  if (!raw) return null;
  const boundaryMatch =
    raw.match(/boundary="([^"]+)"/i) || raw.match(/boundary=([^\s;]+)/i);
  const boundary = boundaryMatch?.[1];
  if (!boundary) return null;
  const parts = raw.split(new RegExp(`\\r?\\n--${boundary}`));
  for (const part of parts) {
    if (!/content-type:\s*text\/plain/i.test(part)) continue;
    let bodyStart = part.indexOf("\r\n\r\n");
    if (bodyStart >= 0) bodyStart += 4;
    else {
      bodyStart = part.indexOf("\n\n");
      if (bodyStart >= 0) bodyStart += 2;
    }
    const bodyRaw = bodyStart > 0 ? part.slice(bodyStart) : part;
    const decoded = /quoted-printable/i.test(part)
      ? decodeQuotedPrintable(bodyRaw)
      : bodyRaw;
    const cleaned = decoded.replace(/\r\n/g, "\n").trim();
    if (cleaned) return cleaned;
  }
  return null;
}

function stripQuotedReply(input?: string | null): string {
  if (!input) return "";
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }
    if (/^>/.test(trimmed)) break;
    if (/^on .+wrote:$/i.test(trimmed)) break;
    if (/^-----original message-----/i.test(trimmed)) break;
    if (/^(subject|received|arc-|dkim-|mime-version|content-type|message-id|from|to):/i.test(trimmed)) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripHtml(input?: string): string | undefined {
  if (!input) return undefined;
  const withBreaks = input.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n");
  const cleaned = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || undefined;
}

function cleanInboundEmailText(textBody?: string, htmlBody?: string, emailBody?: string): string {
  const plain = textBody?.trim();
  if (plain && !looksLikeMime(plain)) return stripQuotedReply(plain);
  const mimeCandidate = emailBody || textBody || "";
  const extracted = extractPlainTextFromMime(mimeCandidate);
  if (extracted) return stripQuotedReply(extracted);
  const htmlText = stripHtml(htmlBody) ?? stripHtml(emailBody);
  return stripQuotedReply(htmlText?.trim() || plain || "");
}

async function main() {
  const dataDir = process.env.DATA_DIR || path.join("services", "api", "data");
  const filePath = path.join(dataDir, "conversations.json");
  if (!fs.existsSync(filePath)) {
    console.error(`conversations.json not found at ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw) as DataFile;
  const conversations = data.conversations ?? [];
  let changed = 0;

  for (const conv of conversations) {
    const msgs = conv.messages ?? [];
    for (const msg of msgs) {
      if (msg.provider !== "sendgrid" || msg.direction !== "in") continue;
      const original = String(msg.body ?? "");
      const cleaned = cleanInboundEmailText(original, undefined, original);
      if (cleaned && cleaned !== original) {
        msg.body = cleaned;
        changed += 1;
      }
    }
  }

  if (!changed) {
    console.log("No inbound sendgrid messages needed cleaning.");
    return;
  }

  const backupPath = `${filePath}.bak.${Date.now()}`;
  fs.writeFileSync(backupPath, raw, "utf8");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  console.log(`Cleaned ${changed} messages. Backup: ${backupPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
