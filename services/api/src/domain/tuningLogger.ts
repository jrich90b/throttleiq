import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type TuningRow = {
  ts: string;
  leadKey: string;
  leadSource: string | null;
  bucket: string | null;
  cta: string | null;
  channel: string | null;
  draftId: string | null;
  draft: string | null;
  final: string;
  edited: boolean | null;
  editDistance: number | null;
  editNote?: string | null;
  twilioSid: string | null;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TUNING_PATH = path.join(REPO_ROOT, "data", "tuning.jsonl");

async function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  const prev = new Array(bLen + 1).fill(0);
  const curr = new Array(bLen + 1).fill(0);

  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= bLen; j++) prev[j] = curr[j];
  }

  return prev[bLen];
}

export async function logTuningRow(row: TuningRow): Promise<void> {
  const draft = row.draft ?? "";
  const final = row.final ?? "";

  const edited =
    row.edited ??
    (row.draft == null ? null : draft.trim() !== final.trim());

  const editDistanceValue =
    row.editDistance ??
    (row.draft == null ? null : editDistance(draft, final));

  const payload: TuningRow = {
    ...row,
    edited,
    editDistance: editDistanceValue
  };

  await ensureDirForFile(TUNING_PATH);
  await fs.appendFile(TUNING_PATH, `${JSON.stringify(payload)}\n`, "utf8");
}
