import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type PromptName =
  | "orchestrator"
  | "qualifier"
  | "inventory_specialist"
  | "commitment_extractor"
  | "followup_generator"
  | "supervisor_guardrails";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// services/api/src/domain -> repo root -> packages/ai/prompts
const PROMPTS_DIR = path.resolve(__dirname, "../../../../packages/ai/prompts");

export async function loadSystemPrompt(name: PromptName): Promise<string> {
  return readFile(path.join(PROMPTS_DIR, `${name}.system.md`), "utf8");

}
