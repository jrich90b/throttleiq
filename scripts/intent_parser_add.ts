import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Intent = "callback" | "test_ride" | "availability" | "none";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage(): void {
  console.error(
    [
      "Usage:",
      "  npx tsx scripts/intent_parser_add.ts --text \"...\" --intent callback --explicit true [options]",
      "",
      "Options:",
      "  --id \"example_id\"",
      "  --intent-any \"callback,test_ride\"",
      "  --availability \"model=Road Glide;year=2025;color=purple;stock_id=U123-456;condition=used\"",
      "  --history '[{\"direction\":\"out\",\"body\":\"Want me to call you?\"}]'",
      "  --lead '{\"vehicle\":{\"model\":\"Street Glide\",\"year\":\"2024\"}}'",
      "  --file /path/to/intent_parser_examples.json"
    ].join("\n")
  );
}

function parseArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const eq = item.indexOf("=");
    if (eq > -1) {
      map.set(item.slice(0, eq), item.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      map.set(item, next);
      i += 1;
    } else {
      map.set(item, "true");
    }
  }
  return map;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;
  return null;
}

function parseAvailability(value: string | undefined): any | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  const out: Record<string, string> = {};
  for (const part of trimmed.split(/[;,]/)) {
    const seg = part.trim();
    if (!seg) continue;
    const [key, ...rest] = seg.split("=");
    if (!key || rest.length === 0) continue;
    out[key.trim()] = rest.join("=").trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function parseJson(value: string | undefined): any | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const args = parseArgs(process.argv.slice(2));
const text = args.get("--text") ?? "";
const intent = (args.get("--intent") ?? "") as Intent;
const explicit = parseBoolean(args.get("--explicit"));
const id = args.get("--id") ?? `${intent || "example"}_${Date.now()}`;
const intentAny = args.get("--intent-any");
const availability = parseAvailability(args.get("--availability"));
const history = parseJson(args.get("--history"));
const lead = parseJson(args.get("--lead"));
const filePath = args.get("--file") ?? path.join(__dirname, "intent_parser_examples.json");

if (!text || !intent || explicit === null) {
  usage();
  process.exit(1);
}

const validIntents: Intent[] = ["callback", "test_ride", "availability", "none"];
if (!validIntents.includes(intent)) {
  console.error(`Invalid --intent "${intent}". Use one of: ${validIntents.join(", ")}`);
  process.exit(1);
}

let intentAnyList: Intent[] | undefined;
if (intentAny) {
  intentAnyList = intentAny
    .split(",")
    .map(s => s.trim())
    .filter(Boolean) as Intent[];
  if (!intentAnyList.length || intentAnyList.some(i => !validIntents.includes(i))) {
    console.error(`Invalid --intent-any "${intentAny}".`);
    process.exit(1);
  }
}

const raw = await fs.readFile(filePath, "utf8");
const examples = JSON.parse(raw) as any[];
if (!Array.isArray(examples)) {
  console.error("Examples file is not a JSON array.");
  process.exit(1);
}
if (examples.some(ex => ex?.id === id)) {
  console.error(`Example id "${id}" already exists. Use --id to set a unique id.`);
  process.exit(1);
}

const next: any = {
  id,
  text,
  expected: {
    intent,
    explicit_request: explicit
  }
};

if (intentAnyList) next.expected.intent_any = intentAnyList;
if (availability) next.expected.availability = availability;
if (history) next.history = history;
if (lead) next.lead = lead;

examples.push(next);
await fs.writeFile(filePath, JSON.stringify(examples, null, 2) + "\n");

console.log(`Added example ${id} to ${filePath}`);
