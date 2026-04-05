import fs from "node:fs";
import path from "node:path";

type AnyObj = Record<string, any>;

function asArray(input: unknown): AnyObj[] {
  return Array.isArray(input) ? (input as AnyObj[]) : [];
}

function toText(input: unknown): string {
  return String(input ?? "");
}

function normalizeText(input: unknown): string {
  return toText(input).replace(/\s+/g, " ").trim();
}

function parseStore(filePath: string): { conversations: AnyObj[] } {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) return { conversations: raw as AnyObj[] };
  return { conversations: asArray((raw as AnyObj)?.conversations) };
}

function leadName(lead: AnyObj | undefined): string | null {
  const full = normalizeText(lead?.name);
  if (full) return full;
  const first = normalizeText(lead?.firstName);
  const last = normalizeText(lead?.lastName);
  const joined = normalizeText(`${first} ${last}`);
  return joined || null;
}

function run() {
  const cwd = process.cwd();
  const dataDir = process.env.DATA_DIR || path.resolve(cwd, "data");
  const conversationsPath =
    process.env.CONVERSATIONS_DB_PATH || path.join(dataDir, "conversations.json");

  if (!fs.existsSync(conversationsPath)) {
    console.error(`conversations.json not found: ${conversationsPath}`);
    process.exit(1);
  }

  const runtimeRoot = path.resolve(path.dirname(conversationsPath), "..");
  const defaultChangedPath = path.join(runtimeRoot, "reports", "changed_messages_all.json");
  const changedPath = process.env.CHANGED_MESSAGES_PATH || defaultChangedPath;

  const { conversations } = parseStore(conversationsPath);
  const rows: AnyObj[] = [];

  for (const conv of conversations) {
    const messages = asArray(conv?.messages);
    const convId = toText(conv?.id).trim();
    if (!convId) continue;
    const lead = (conv?.lead ?? {}) as AnyObj;
    const base = {
      convId,
      leadRef: lead?.leadRef ?? null,
      name: leadName(lead),
      phone: lead?.phone ?? null
    };

    for (const msg of messages) {
      if (toText(msg?.direction) !== "out") continue;
      const generated = toText(msg?.originalDraftBody);
      const final = toText(msg?.body);
      if (!generated || !final) continue;
      if (normalizeText(generated) === normalizeText(final)) continue;

      rows.push({
        ...base,
        at: toText(msg?.at).trim() || new Date().toISOString(),
        provider: msg?.provider ?? null,
        generated,
        final
      });
    }
  }

  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const out = {
    generatedAt: new Date().toISOString(),
    conversationsPath,
    count: rows.length,
    rows
  };

  fs.mkdirSync(path.dirname(changedPath), { recursive: true });
  fs.writeFileSync(changedPath, JSON.stringify(out, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        changedPath,
        count: rows.length
      },
      null,
      2
    )
  );
}

run();

