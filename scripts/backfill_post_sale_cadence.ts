import fs from "node:fs";
import path from "node:path";
import {
  computePostSaleDueAt,
  POST_SALE_DAY_OFFSETS
} from "../services/api/src/domain/conversationStore.ts";

type AnyObj = Record<string, any>;

function normalizePhone(input: unknown): string {
  return String(input ?? "").replace(/\D/g, "");
}

function readStore(filePath: string): { root: any; conversations: AnyObj[] } {
  const root = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(root)) return { root, conversations: root };
  return {
    root,
    conversations: Array.isArray(root?.conversations) ? root.conversations : []
  };
}

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : "";
}

function isWriteMode(): boolean {
  return process.argv.includes("--write") || process.env.WRITE === "1";
}

function isSoldLead(conv: AnyObj): boolean {
  return String(conv?.closedReason ?? "") === "sold" || !!conv?.sale?.soldAt;
}

function hasActivePostSaleCadence(conv: AnyObj): boolean {
  return String(conv?.followUpCadence?.kind ?? "") === "post_sale" &&
    String(conv?.followUpCadence?.status ?? "") === "active";
}

function targetMatches(conv: AnyObj, targetLeadRef: string, targetPhone: string): boolean {
  if (targetLeadRef) {
    const refs = [
      conv?.lead?.leadRef,
      conv?.leadRef,
      conv?.sale?.leadRef
    ].map(value => String(value ?? "").trim());
    if (!refs.includes(targetLeadRef)) return false;
  }

  if (targetPhone) {
    const phones = [
      conv?.lead?.phone,
      conv?.phone,
      conv?.leadKey
    ].map(normalizePhone);
    if (!phones.includes(targetPhone)) return false;
  }

  return true;
}

function run() {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
  const filePath = process.env.CONVERSATIONS_DB_PATH || path.join(dataDir, "conversations.json");
  const timezone = process.env.TIMEZONE || process.env.DEALER_TIMEZONE || "America/New_York";
  const write = isWriteMode();
  const targetLeadRef = String(process.env.TARGET_LEAD_REF || getArg("lead-ref")).trim();
  const targetPhone = normalizePhone(process.env.TARGET_PHONE || getArg("phone"));

  if (!fs.existsSync(filePath)) {
    console.error(`conversations.json not found: ${filePath}`);
    process.exit(1);
  }

  const { root, conversations } = readStore(filePath);
  const nowIso = new Date().toISOString();
  const fixed: AnyObj[] = [];

  for (const conv of conversations) {
    if (!isSoldLead(conv)) continue;
    if (hasActivePostSaleCadence(conv)) continue;
    if (!targetMatches(conv, targetLeadRef, targetPhone)) continue;

    const anchorAt = String(conv?.sale?.soldAt || conv?.closedAt || conv?.updatedAt || nowIso);
    const nextDueAt = computePostSaleDueAt(anchorAt, POST_SALE_DAY_OFFSETS[0], timezone);
    fixed.push({
      id: conv?.id,
      leadKey: conv?.leadKey,
      leadRef: conv?.lead?.leadRef ?? conv?.sale?.leadRef ?? null,
      phone: conv?.lead?.phone ?? null,
      name:
        conv?.lead?.name ||
        [conv?.lead?.firstName, conv?.lead?.lastName].filter(Boolean).join(" ") ||
        null,
      previousFollowUpMode: conv?.followUp?.mode ?? null,
      previousCadenceKind: conv?.followUpCadence?.kind ?? null,
      previousCadenceStatus: conv?.followUpCadence?.status ?? null,
      anchorAt,
      nextDueAt
    });

    if (!write) continue;

    conv.followUp = {
      mode: "active",
      reason: "post_sale",
      updatedAt: nowIso
    };
    conv.followUpCadence = {
      status: "active",
      anchorAt,
      nextDueAt,
      stepIndex: 0,
      kind: "post_sale",
      scheduleInviteCount: 0,
      scheduleMuted: false
    };
    conv.updatedAt = nowIso;
  }

  if (write && fixed.length > 0) {
    fs.writeFileSync(filePath, `${JSON.stringify(root, null, 2)}\n`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: write ? "write" : "dry_run",
        filePath,
        timezone,
        targetLeadRef: targetLeadRef || null,
        targetPhone: targetPhone || null,
        scanned: conversations.length,
        fixedCount: fixed.length,
        fixed
      },
      null,
      2
    )
  );
}

run();
