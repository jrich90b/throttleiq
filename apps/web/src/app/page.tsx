"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InboxSection } from "./components/InboxSection";
import { TaskInboxSection } from "./components/TaskInboxSection";
import { useInboxSectionData } from "./hooks/useInboxSectionData";
import { useTaskInboxData } from "./hooks/useTaskInboxData";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionCtorLike = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtorLike | null {
  if (typeof window === "undefined") return null;
  return (
    (window as any).SpeechRecognition ??
    (window as any).webkitSpeechRecognition ??
    null
  );
}

const BOOKING_LINK_RE =
  /(Book here|You can choose a time here|You can book an appointment here):\s*(https?:\/\/[^\s<]+)/i;
const BOOKING_LABEL_ONLY_RE =
  /\b(Book here|You can choose a time here|You can book an appointment here)\b/i;
const INBOUND_EMAIL_HEADER_RE =
  /^(from|to|cc|bcc|subject|date|sent|reply-to|message-id|mime-version|content-type|content-transfer-encoding|received|arc-|dkim-signature|authentication-results):/i;
const INBOUND_EMAIL_BREAK_RE =
  /^(>+|on .+wrote:|-{2,}\s*original message\s*-{2,}|_{5,})/i;

function renderBookingLinkLine(line: string) {
  const match = line.match(BOOKING_LINK_RE);
  if (!match) return line;
  const label = match[1];
  const url = match[2];
  const idx = match.index ?? 0;
  const before = line.slice(0, idx);
  const after = line.slice(idx + match[0].length);
  const prefix = String(label).replace(/\s*here$/i, "").trim();
  const prefixWithSpace = prefix.length ? `${prefix} ` : "";
  return (
    <>
      {before}
      {prefixWithSpace}
      <a className="underline" href={url} target="_blank" rel="noreferrer">
        here
      </a>
      {after}
    </>
  );
}

function renderLinkifiedLine(line: string) {
  const urlRe = /(https?:\/\/[^\s<]+)/gi;
  const parts: Array<string | { url: string }> = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(line)) !== null) {
    const idx = match.index;
    const url = match[0];
    if (idx > lastIdx) {
      parts.push(line.slice(lastIdx, idx));
    }
    parts.push({ url });
    lastIdx = idx + url.length;
  }
  if (lastIdx < line.length) {
    parts.push(line.slice(lastIdx));
  }
  if (!parts.length) return line;
  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <span key={i}>{part}</span>
        ) : (
          <a key={i} className="underline break-all" href={part.url} target="_blank" rel="noreferrer">
            {part.url}
          </a>
        )
      )}
    </>
  );
}

function renderMessageBody(text?: string | null) {
  if (!text) return null;
  const lines = text.split("\n");
  return lines.map((line, idx) => (
    <span key={idx}>
      {renderLinkifiedLine(line)}
      {idx < lines.length - 1 ? <br /> : null}
    </span>
  ));
}

function hasInboundEmailNoise(text: string) {
  return (
    /(^|\n)\s*(from|to|cc|bcc|subject|date|sent|reply-to):\s+/i.test(text) ||
    /(^|\n)\s*(mime-version|content-type|content-transfer-encoding|received|dkim-signature|arc-|authentication-results):/i.test(
      text
    ) ||
    /(^|\n)\s*>/.test(text) ||
    /(^|\n)\s*on .+wrote:\s*$/i.test(text) ||
    /-{2,}\s*original message\s*-{2,}/i.test(text)
  );
}

function cleanInboundEmailForDisplay(text?: string | null) {
  if (!text) return "";
  const normalized = String(text).replace(/\r\n/g, "\n").trim();
  if (!normalized || !hasInboundEmailNoise(normalized)) return normalized;

  const lines = normalized.split("\n");
  const out: string[] = [];
  let inHeaderBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!inHeaderBlock && out.length && out[out.length - 1] !== "") out.push("");
      inHeaderBlock = false;
      continue;
    }
    if (INBOUND_EMAIL_BREAK_RE.test(trimmed)) break;
    if (INBOUND_EMAIL_HEADER_RE.test(trimmed)) {
      inHeaderBlock = true;
      continue;
    }
    if (inHeaderBlock && /^\s/.test(line)) continue;
    if (inHeaderBlock) inHeaderBlock = false;
    if (/^-{5,}$/.test(trimmed)) continue;
    out.push(line);
  }

  const cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || normalized;
}

function cleanAdfLeadForDisplay(text?: string | null) {
  if (!text) return "";
  const raw = String(text).replace(/\r\n/g, "\n").trim();
  if (!raw) return "";
  if (!/web lead\s*\(adf\)/i.test(raw)) return raw;

  const inquiryIdx = raw.toLowerCase().lastIndexOf("inquiry:");
  let inquiry = inquiryIdx >= 0 ? raw.slice(inquiryIdx + "inquiry:".length).trim() : "";
  inquiry = inquiry
    .replace(/\s*>\s*>+\s*/g, " ")
    .replace(
      /\s*(?:can we contact you via (?:email|phone|text)\?:|client_id\s*:|hdmc-campaign-tracking code\s*:|lead captured date\s*:|event name\s*:|\/\/\/customer information\/\/\/|inventory year\s*:|inventory stock id\s*:|vin\s*:|first name\s*:|last name\s*:|phone\s*:|email\s*:).*/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!inquiry) {
    return "WEB LEAD (ADF)\nInquiry: (open View lead for full details)";
  }
  return `WEB LEAD (ADF)\nInquiry:\n${inquiry}`;
}

function maskBookingLink(text?: string | null) {
  if (!text) return "";
  return text.replace(BOOKING_LINK_RE, (m, label) => {
    const prefix = String(label).replace(/\s*here$/i, "").trim();
    const prefixWithSpace = prefix.length ? `${prefix} ` : "";
    return `${prefixWithSpace}here`;
  });
}

function extractBookingUrl(text?: string | null) {
  if (!text) return null;
  const match = text.match(BOOKING_LINK_RE);
  return match?.[2] ?? null;
}

function injectBookingUrl(body: string, url: string) {
  if (BOOKING_LINK_RE.test(body)) return body;
  if (BOOKING_LABEL_ONLY_RE.test(body)) {
    return body.replace(BOOKING_LABEL_ONLY_RE, (label) => `${label}: ${url}`);
  }
  return `${body}\n\nYou can book an appointment here: ${url}`;
}

function getMediaUrlInfo(url: string): { isImage: boolean; isPdf: boolean; fileName: string } {
  const fallback = { isImage: false, isPdf: false, fileName: "attachment" };
  if (!url) return fallback;
  try {
    const parsed = new URL(url, "https://local");
    const pathName = parsed.pathname || "";
    const fileName = decodeURIComponent(pathName.split("/").pop() || "attachment");
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    const isImage = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg"].includes(ext);
    const isPdf = ext === "pdf";
    return { isImage, isPdf, fileName };
  } catch {
    return fallback;
  }
}

function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CADENCE_ALERT_WINDOW_HOURS = 24;
const COMMON_REFERENCE_SITES: Array<{ label: string; value: string }> = [
  { label: "Harley-Davidson", value: "https://www.harley-davidson.com" },
  { label: "LiveWire", value: "https://www.livewire.com" },
  { label: "Triumph", value: "https://www.triumphmotorcycles.com" },
  { label: "Indian", value: "https://www.indianmotorcycle.com" },
  { label: "Honda Powersports", value: "https://powersports.honda.com" },
  { label: "Yamaha Motorsports", value: "https://www.yamahamotorsports.com" },
  { label: "Kawasaki", value: "https://www.kawasaki.com" },
  { label: "Suzuki Cycles", value: "https://suzukicycles.com" },
  { label: "Ducati", value: "https://www.ducati.com" },
  { label: "KTM", value: "https://www.ktm.com" },
  { label: "BMW Motorrad", value: "https://www.bmw-motorrad.com" },
  { label: "Can-Am", value: "https://can-am.brp.com" },
  { label: "Sea-Doo", value: "https://sea-doo.brp.com" },
  { label: "Polaris", value: "https://www.polaris.com" },
  { label: "CFMOTO", value: "https://www.cfmotousa.com" },
  { label: "Aprilia", value: "https://www.aprilia.com" },
  { label: "Moto Guzzi", value: "https://www.motoguzzi.com" },
  { label: "Vespa", value: "https://www.vespa.com" },
  { label: "Piaggio", value: "https://www.piaggio.com" },
  { label: "Zero Motorcycles", value: "https://www.zeromotorcycles.com" }
];

const CALENDAR_COLORS = [
  { id: "1", label: "White", bg: "#FFFFFF", border: "#D1D5DB", text: "#111827" },
  { id: "2", label: "Black", bg: "#000000", border: "#111827", text: "#FFFFFF" },
  { id: "3", label: "Purple", bg: "#800080", border: "#6B006B", text: "#FFFFFF" },
  { id: "4", label: "Coral", bg: "#FF7F50", border: "#F26B3A", text: "#111827" },
  { id: "5", label: "Gold", bg: "#FFD700", border: "#E6C200", text: "#111827" },
  { id: "6", label: "Navy", bg: "#000080", border: "#000066", text: "#FFFFFF" },
  { id: "7", label: "Aqua", bg: "#00FFFF", border: "#00C8C8", text: "#111827" },
  { id: "8", label: "Gray", bg: "#808080", border: "#6B7280", text: "#FFFFFF" },
  { id: "9", label: "Blue", bg: "#0000FF", border: "#0000CC", text: "#FFFFFF" },
  { id: "10", label: "Lime", bg: "#00FF00", border: "#00D400", text: "#111827" },
  { id: "11", label: "Red", bg: "#FF0000", border: "#D10000", text: "#FFFFFF" }
];

function getCalendarColor(colorId?: string | null) {
  if (!colorId) return null;
  return CALENDAR_COLORS.find(c => c.id === colorId) ?? null;
}

function normalizeWatchCondition(raw?: string | null): string {
  const t = String(raw ?? "").toLowerCase().trim();
  if (!t) return "";
  if (/(pre|used|pre-owned|preowned|owned)/.test(t)) return "used";
  if (/new/.test(t)) return "new";
  return t;
}

function isGenericWatchModelPlaceholder(raw?: string | null): boolean {
  const text = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (text === "harley davidson") return true;
  if (/^(?:harley davidson )?(?:full line|other|unknown|none)$/.test(text)) return true;
  if (/^(?:n\/a|na)$/.test(text)) return true;
  return false;
}

function formatCadenceDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatWatchLabel(watch?: {
  year?: number | string;
  yearMin?: number;
  yearMax?: number;
  make?: string;
  model?: string;
  trim?: string;
  color?: string;
  condition?: string;
}) {
  if (!watch) return "Inventory watch";
  const yearText =
    watch.year ??
    (watch.yearMin && watch.yearMax ? `${watch.yearMin}-${watch.yearMax}` : undefined);
  const parts = [yearText, watch.make, watch.model, watch.trim].filter(Boolean).join(" ");
  const colorText = watch.color ? ` in ${watch.color}` : "";
  const condition = normalizeWatchCondition(watch.condition);
  const conditionText = condition ? ` (${condition})` : "";
  return `${parts || "Inventory watch"}${colorText}${conditionText}`;
}

function formatWatchDate(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function isoToLocalDateTimeInput(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (v: number) => String(v).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const minute = pad(d.getMinutes());
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function formatMotorcycleOfInterest(contact?: {
  vehicleDescription?: string;
  year?: string;
  make?: string;
  model?: string;
  vehicle?: string;
  trim?: string;
  color?: string;
  stockId?: string;
  vin?: string;
} | null): string {
  if (!contact) return "—";
  const freeText = String(contact.vehicleDescription ?? "").trim();
  if (freeText) return freeText;
  const model = String(contact.model ?? contact.vehicle ?? "").trim();
  const base = [contact.year, contact.make, model, contact.trim].filter(Boolean).join(" ").trim();
  if (base && contact.color) return `${base} (${contact.color})`;
  if (base) return base;
  if (contact.stockId) return `Stock ${contact.stockId}`;
  if (contact.vin) return `VIN ${contact.vin}`;
  return "—";
}

function formatContactDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function splitContactName(raw?: string | null): { firstName: string; lastName: string } {
  const parts = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" ")
  };
}

function isLikelyPhoneLeadKey(value?: string | null): boolean {
  const t = String(value ?? "").trim();
  if (!t) return false;
  if (t.includes("@")) return false;
  const digits = t.replace(/\D/g, "");
  return digits.length >= 10;
}

function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(current.trim());
      current = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(current.trim());
      current = "";
      if (row.some(cell => cell.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    current += ch;
  }
  if (current.length > 0 || row.length > 0) {
    row.push(current.trim());
    if (row.some(cell => cell.length > 0)) rows.push(row);
  }
  return rows;
}

function parseContactCsv(raw: string): Array<{
  firstName?: string;
  lastName?: string;
  name?: string;
  phone?: string;
  email?: string;
}> {
  const rows = parseCsvRows(raw);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.toLowerCase().trim());
  const col = (keys: string[]) =>
    header.findIndex(h => keys.some(k => h === k || h.includes(k)));
  const iFirst = col(["first name", "firstname", "first"]);
  const iLast = col(["last name", "lastname", "last"]);
  const iName = col(["full name", "name"]);
  const iPhone = col(["phone", "mobile", "cell"]);
  const iEmail = col(["email", "e-mail"]);
  const out: Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
    phone?: string;
    email?: string;
  }> = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const firstName = iFirst >= 0 ? cells[iFirst]?.trim() : "";
    const lastName = iLast >= 0 ? cells[iLast]?.trim() : "";
    const name = iName >= 0 ? cells[iName]?.trim() : "";
    const phone = iPhone >= 0 ? cells[iPhone]?.trim() : "";
    const email = iEmail >= 0 ? cells[iEmail]?.trim() : "";
    if (!phone && !email) continue;
    out.push({
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      name: name || undefined,
      phone: phone || undefined,
      email: email || undefined
    });
  }
  return out;
}

function getCadenceAlert(cadence?: {
  status?: string;
  pausedUntil?: string | null;
  nextDueAt?: string | null;
  anchorAt?: string | null;
  kind?: string | null;
  stopReason?: string | null;
}) {
  if (!cadence) return null;
  const status = String(cadence.status ?? "").toLowerCase();
  const kind = String(cadence.kind ?? "").toLowerCase();
  const stopReason = String(cadence.stopReason ?? "").toLowerCase();
  const preserveStoppedCadence =
    status === "stopped" &&
    stopReason === "manual_handoff" &&
    (kind === "long_term" || kind === "post_sale");
  if (status !== "active" && !preserveStoppedCadence) return null;
  const nowMs = Date.now();
  if (cadence.pausedUntil) {
    const pausedAt = new Date(cadence.pausedUntil);
    if (!Number.isNaN(pausedAt.getTime())) {
      const msUntilPause = pausedAt.getTime() - nowMs;
      if (msUntilPause > 0) {
        return { sendAt: pausedAt, msUntil: msUntilPause };
      }
    }
  }
  const sendAtRaw = cadence.nextDueAt ?? cadence.anchorAt ?? null;
  if (!sendAtRaw) return null;
  const sendAt = new Date(sendAtRaw);
  if (Number.isNaN(sendAt.getTime())) return null;
  const msUntil = sendAt.getTime() - nowMs;
  if (msUntil <= 0) return null;
  return { sendAt, msUntil };
}

function isEmojiOnlyAckText(text: string): boolean {
  const t = String(text ?? "").trim();
  return t.length > 0 && /^[\p{Extended_Pictographic}\s]+$/u.test(t);
}

function isShortAckNoActionText(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (isEmojiOnlyAckText(t)) return true;
  if (t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  if (
    /\b(price|pricing|payment|monthly|apr|term|down payment|trade|trade in|service|parts|apparel|available|availability|in stock|stock|test ride|appointment|schedule|call|video|photos?|email|watch)\b/i.test(
      t
    )
  ) {
    return false;
  }
  return /\b(thanks|thank you|thanks again|thx|ty|appreciate|got it|sounds good|sounds great|will do|ok|okay|k|kk|cool|perfect|great|all good|no problem|you bet|yep|yup|sure)\b/.test(
    t
  );
}

type SystemMode = "suggest" | "autopilot";

type ConversationListItem = {
  id: string;
  leadKey: string;
  mode?: "suggest" | "human";
  status?: "open" | "closed";
  closedAt?: string | null;
  closedReason?: string | null;
  engagement?: {
    at?: string;
    source?: "sms" | "email" | "call";
    reason?: string;
    messageId?: string;
  } | null;
  sale?: {
    soldAt?: string;
    soldById?: string;
    soldByName?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    color?: string;
    stockId?: string;
    vin?: string;
    label?: string;
    note?: string;
  } | null;
  contactPreference?: "call_only";
  leadOwner?: {
    id?: string;
    name?: string;
    assignedAt?: string;
  } | null;
  leadSource?: string | null;
  campaignThread?: {
    status?: "campaign" | "linked_open" | "passed";
    campaignId?: string;
    campaignName?: string;
    listId?: string;
    listName?: string;
    firstSentAt?: string;
    lastSentAt?: string;
    replySeenAt?: string;
    passedAt?: string;
    passedTo?: "sales" | "service" | "parts" | "apparel" | "financing" | "general";
  } | null;
  hasInboundTwilio?: boolean | null;
  hotDealSticky?: boolean | null;
  dealTemperature?: "hot" | "warm" | "cold" | null;
  leadName?: string | null;
  vehicleDescription?: string | null;
  walkIn?: boolean | null;
  hold?: {
    key?: string;
    onOrder?: boolean;
    stockId?: string;
    vin?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    color?: string;
    label?: string;
    note?: string;
    until?: string | null;
    reason?: string;
    updatedAt?: string;
    createdAt?: string;
  } | null;
  followUpCadence?: {
    status?: string;
    nextDueAt?: string | null;
    pausedUntil?: string | null;
    pauseReason?: string | null;
    stopReason?: string | null;
    anchorAt?: string | null;
    kind?: string | null;
  } | null;
  followUp?: { mode?: string; reason?: string; updatedAt?: string } | null;
  inventoryWatches?: Array<{
    model: string;
    year?: number | string;
    yearMin?: number;
    yearMax?: number;
    make?: string;
    trim?: string;
    color?: string;
    minPrice?: number;
    maxPrice?: number;
    condition?: string;
    note?: string;
    status?: string;
    createdAt?: string;
    lastNotifiedAt?: string;
  }> | null;
  inventoryWatch?: {
    model: string;
    year?: number | string;
    yearMin?: number;
    yearMax?: number;
    make?: string;
    trim?: string;
    color?: string;
    minPrice?: number;
    maxPrice?: number;
    condition?: string;
    note?: string;
    status?: string;
    createdAt?: string;
    lastNotifiedAt?: string;
  } | null;
  classification?: { bucket?: string; cta?: string } | null;
  appointment?: { status?: string } | null;
  scheduler?: { preferredSalespersonId?: string; preferredSalespersonName?: string } | null;
  updatedAt: string;
  messageCount: number;
  lastMessage?: { direction: "in" | "out"; body: string; provider?: string } | null;
  pendingDraft?: boolean;
  pendingDraftPreview?: string | null;
};

type Message = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
  at: string;
  provider?: string;
  providerMessageId?: string;
  draftStatus?: "pending" | "stale";
  feedback?: {
    rating?: "up" | "down";
    reason?: string;
    note?: string;
    byUserId?: string;
    byUserName?: string;
    at?: string;
  };
};

type ConversationDetail = {
  id: string;
  leadKey: string;
  updatedAt?: string;
  mode?: "suggest" | "human";
  status?: "open" | "closed";
  closedAt?: string | null;
  closedReason?: string | null;
  engagement?: {
    at?: string;
    source?: "sms" | "email" | "call";
    reason?: string;
    messageId?: string;
  } | null;
  sale?: {
    soldAt?: string;
    soldById?: string;
    soldByName?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    color?: string;
    stockId?: string;
    vin?: string;
    label?: string;
    note?: string;
  } | null;
  contactPreference?: "call_only";
  leadOwner?: {
    id?: string;
    name?: string;
    assignedAt?: string;
  } | null;
  walkIn?: boolean | null;
  hold?: {
    key?: string;
    onOrder?: boolean;
    stockId?: string;
    vin?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    color?: string;
    label?: string;
    note?: string;
    until?: string | null;
    reason?: string;
    updatedAt?: string;
    createdAt?: string;
  } | null;
  followUpCadence?: {
    status?: string;
    nextDueAt?: string | null;
    pausedUntil?: string | null;
    pauseReason?: string | null;
    stopReason?: string | null;
    anchorAt?: string | null;
    kind?: string | null;
  };
  followUp?: { mode?: string; reason?: string; updatedAt?: string };
  agentContext?: {
    text?: string;
    mode?: "persistent" | "next_reply";
    expiresAt?: string;
    updatedAt?: string;
    updatedByUserId?: string;
    updatedByUserName?: string;
    consumedAt?: string;
    consumedReason?: string;
    notes?: Array<{
      id?: string;
      text?: string;
      mode?: "persistent" | "next_reply";
      expiresAt?: string;
      addressedAt?: string;
      addressedReason?: string;
      createdAt?: string;
      createdByUserId?: string;
      createdByUserName?: string;
    }>;
  } | null;
  inventoryWatches?: Array<{
    model: string;
    year?: number | string;
    yearMin?: number;
    yearMax?: number;
    make?: string;
    trim?: string;
    color?: string;
    minPrice?: number;
    maxPrice?: number;
    condition?: string;
    note?: string;
    status?: string;
    createdAt?: string;
    lastNotifiedAt?: string;
  }>;
  inventoryWatch?: {
    model: string;
    year?: number | string;
    yearMin?: number;
    yearMax?: number;
    make?: string;
    trim?: string;
    color?: string;
    minPrice?: number;
    maxPrice?: number;
    condition?: string;
    note?: string;
    status?: string;
    createdAt?: string;
    lastNotifiedAt?: string;
  };
  lead?: {
    leadRef?: string;
    source?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    vehicle?: {
      stockId?: string;
      vin?: string;
      year?: string;
      make?: string;
      model?: string;
      trim?: string;
      color?: string;
      description?: string;
      condition?: string;
    };
  };
  appointment?: {
    status?: string;
    whenText?: string;
    whenIso?: string | null;
    bookedEventId?: string | null;
    bookedEventLink?: string | null;
    bookedSalespersonId?: string | null;
    staffNotify?: {
      outcome?: {
        status?: string;
        primaryStatus?: "showed" | "did_not_show" | "cancelled";
        secondaryStatus?:
          | "sold"
          | "hold"
          | "needs_follow_up"
          | "lost"
          | "finance_not_approved"
          | "finance_needs_info"
          | "not_ready"
          | "other";
        note?: string;
        updatedAt?: string;
      };
    };
  };
  classification?: { bucket?: string; cta?: string };
  scheduler?: { preferredSalespersonId?: string; preferredSalespersonName?: string };
  messages: Message[];
};

function normalizeUserRow(user: any) {
  const first = String(user?.firstName ?? "").trim();
  const last = String(user?.lastName ?? "").trim();
  if (first || last) return { ...user };
  const name = String(user?.name ?? "").trim();
  if (!name) return { ...user };
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    ...user,
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" ")
  };
}

type TodoItem = {
  id: string;
  convId: string;
  leadKey: string;
  taskClass?: "followup" | "appointment" | "todo" | "reminder" | null;
  leadName?: string | null;
  ownerName?: string | null;
  ownerDisplayName?: string | null;
  ownerDisplayType?: "department_owner" | "lead_owner" | "department" | null;
  leadOwnerName?: string | null;
  departmentOwnerName?: string | null;
  reason: string;
  summary: string;
  action?: string;
  callbackTimeLabel?: string | null;
  appointmentWhenText?: string | null;
  appointmentWhenIso?: string | null;
  appointmentOutcomeStatus?: string | null;
  appointmentOutcomePrimaryStatus?: string | null;
  appointmentOutcomeSecondaryStatus?: string | null;
  appointmentOutcomeNote?: string | null;
  dueAt?: string | null;
  reminderAt?: string | null;
  createdAt: string;
};

type QuestionItem = {
  id: string;
  convId: string;
  leadKey: string;
  text: string;
  createdAt: string;
  type?: string;
  outcome?: string;
  followUpAction?: string;
};

type WatchFormItem = {
  condition: string;
  year: string;
  make: string;
  model: string;
  models?: string[];
  customModel?: string;
  modelSearch?: string;
  trim: string;
  color: string;
  minPrice: string;
  maxPrice: string;
};

type TodoInboxSection = "followup" | "appointment" | "todo" | "reminder";
type InboxDealFilter = "all" | "hot" | "sold" | "hold";

const TODO_SECTION_THEME: Record<TodoInboxSection, { header: string; title: string }> = {
  followup: {
    header: "bg-blue-50 border-b border-blue-200",
    title: "text-blue-800"
  },
  appointment: {
    header: "bg-emerald-50 border-b border-emerald-200",
    title: "text-emerald-800"
  },
  reminder: {
    header: "bg-purple-50 border-b border-purple-200",
    title: "text-purple-800"
  },
  todo: {
    header: "bg-amber-50 border-b border-amber-200",
    title: "text-amber-800"
  }
};

function getTodoSectionTheme(section: TodoInboxSection) {
  return TODO_SECTION_THEME[section];
}

function getInboxDealFilterButtonClass(active: boolean) {
  return `px-2.5 py-1 text-xs rounded border ${
    active ? "bg-[var(--accent)] text-white border-[var(--accent)]" : "bg-white hover:bg-[var(--surface-2)]"
  }`;
}

const APPOINTMENT_SECONDARY_OPTIONS_BY_PRIMARY: Record<
  "showed" | "did_not_show" | "cancelled",
  Array<{ value: string; label: string }>
> = {
  showed: [
    { value: "needs_follow_up", label: "Needs follow up" },
    { value: "sold", label: "Sold" },
    { value: "hold", label: "Hold" },
    { value: "finance_not_approved", label: "Finance not approved" },
    { value: "finance_needs_info", label: "Finance needs more info" },
    { value: "not_ready", label: "Not ready" },
    { value: "lost", label: "Lost / bought elsewhere" },
    { value: "other", label: "Other" }
  ],
  did_not_show: [
    { value: "needs_follow_up", label: "Needs follow up" },
    { value: "lost", label: "Lost / bought elsewhere" },
    { value: "not_ready", label: "Not ready" },
    { value: "other", label: "Other" }
  ],
  cancelled: [
    { value: "needs_follow_up", label: "Needs follow up" },
    { value: "lost", label: "Lost / bought elsewhere" },
    { value: "not_ready", label: "Not ready" },
    { value: "other", label: "Other" }
  ]
};

const APPOINTMENT_PRIMARY_LABELS: Record<"showed" | "did_not_show" | "cancelled", string> = {
  showed: "Showed",
  did_not_show: "Did not show",
  cancelled: "Cancelled"
};

const APPOINTMENT_SECONDARY_LABELS: Record<string, string> = {
  sold: "Sold",
  hold: "Hold",
  needs_follow_up: "Needs follow up",
  lost: "Lost / bought elsewhere",
  finance_not_approved: "Finance not approved",
  finance_needs_info: "Finance needs more info",
  not_ready: "Not ready",
  other: "Other"
};

function normalizeAppointmentPrimaryValue(raw?: string | null): "showed" | "did_not_show" | "cancelled" | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "showed" || value === "showed_up") return "showed";
  if (value === "did_not_show" || value === "no_show") return "did_not_show";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return null;
}

function normalizeAppointmentSecondaryValue(raw?: string | null): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "follow_up") return "needs_follow_up";
  if (value === "bought_elsewhere") return "lost";
  if (value === "financing_declined") return "finance_not_approved";
  if (value === "financing_needs_info") return "finance_needs_info";
  return value;
}

function mapLegacyAppointmentOutcomeToPair(legacyRaw?: string | null): {
  primary: "showed" | "did_not_show" | "cancelled";
  secondary: string;
} | null {
  const legacy = String(legacyRaw ?? "").trim().toLowerCase();
  if (!legacy) return null;
  if (legacy === "sold") return { primary: "showed", secondary: "sold" };
  if (legacy === "hold") return { primary: "showed", secondary: "hold" };
  if (legacy === "financing_declined") return { primary: "showed", secondary: "finance_not_approved" };
  if (legacy === "financing_needs_info") return { primary: "showed", secondary: "finance_needs_info" };
  if (legacy === "lost" || legacy === "bought_elsewhere") return { primary: "showed", secondary: "lost" };
  if (legacy === "other") return { primary: "showed", secondary: "other" };
  if (legacy === "cancelled" || legacy === "canceled") return { primary: "cancelled", secondary: "needs_follow_up" };
  if (legacy === "no_show") return { primary: "did_not_show", secondary: "needs_follow_up" };
  if (legacy === "showed_up" || legacy === "follow_up") return { primary: "showed", secondary: "needs_follow_up" };
  return null;
}

function formatAppointmentOutcomeDisplay(args: {
  primary?: string | null;
  secondary?: string | null;
  legacy?: string | null;
}): string | null {
  const normalizedPrimary = normalizeAppointmentPrimaryValue(args.primary);
  const normalizedSecondary = normalizeAppointmentSecondaryValue(args.secondary);
  if (normalizedPrimary && normalizedSecondary) {
    const primaryLabel = APPOINTMENT_PRIMARY_LABELS[normalizedPrimary] ?? "Showed";
    const secondaryLabel =
      APPOINTMENT_SECONDARY_LABELS[normalizedSecondary] ??
      normalizedSecondary.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    return `${primaryLabel} • ${secondaryLabel}`;
  }
  const legacyPair = mapLegacyAppointmentOutcomeToPair(args.legacy);
  if (!legacyPair) return null;
  const primaryLabel = APPOINTMENT_PRIMARY_LABELS[legacyPair.primary] ?? "Showed";
  const secondaryLabel =
    APPOINTMENT_SECONDARY_LABELS[legacyPair.secondary] ??
    legacyPair.secondary.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return `${primaryLabel} • ${secondaryLabel}`;
}

function todoActionLabel(todo: TodoItem): string {
  const explicitAction = String(todo.action ?? "").trim();
  if (explicitAction) return explicitAction;
  const reason = (todo.reason ?? "").toLowerCase();
  const summary = (todo.summary ?? "").toLowerCase();
  const text = `${reason} ${summary}`;
  if (reason === "approval") return "Business manager follow-up (credit app/prequal).";
  if (/(^|\\b)call(\\b|$)/.test(reason)) return "Call customer.";
  if (/(call only|phone only|no text|do not text)/.test(text)) return "Call customer (call-only).";
  if (/(credit|prequal|finance)/.test(text)) return "Business manager follow-up (credit app).";
  if (
    reason === "service" ||
    /(service|inspection|oil change|3[- ]hole|maintenance|repair|service department)/.test(text)
  ) {
    return "Service department follow-up and scheduling.";
  }
  if (
    reason === "parts" ||
    /(parts? department|parts? counter|part number|oem parts?|aftermarket parts?|order.*part|need.*part)/.test(text)
  ) {
    return "Parts department follow-up.";
  }
  if (
    reason === "apparel" ||
    /(apparel|merch|merchandise|clothing|jacket|hoodie|t-?shirt|helmet|gloves?|boots?|riding gear)/.test(text)
  ) {
    return "Apparel department follow-up.";
  }
  if (/(trade|appraisal|trade[- ]in)/.test(text)) return "Discuss trade appraisal and next steps.";
  if (/(inventory|verify|check stock|not seeing|live feed)/.test(text)) return "Verify inventory and follow up.";
  if (/(video|walkaround|photos)/.test(text)) return "Send a walkaround video or photos.";
  if (/(appointment|schedule|book)/.test(text)) return "Schedule an appointment.";
  if (/(pricing|price|quote|payment)/.test(text)) return "Provide pricing or payment details.";
  if (/(^|\\b)note(\\b|$)/.test(reason) || /update for/.test(text)) return "Internal note (no customer follow-up).";
  return "Follow up with the customer.";
}

function todoRequestedCallTimeLabel(todo: TodoItem): string | null {
  const dueAt = String(todo.dueAt ?? "").trim();
  const rawSummary = String(todo.summary ?? "");
  const summaryTime = rawSummary.match(/^call requested:\s*(.+)$/i)?.[1]?.replace(/[.]+$/, "").trim();
  if (!dueAt) return summaryTime || null;
  const at = new Date(dueAt);
  if (!Number.isNaN(at.getTime())) return at.toLocaleString();
  return summaryTime || null;
}

function todoAppointmentTimeLabel(todo: TodoItem): string | null {
  const dueAt = String(todo.dueAt ?? "").trim();
  if (dueAt) {
    const at = new Date(dueAt);
    if (!Number.isNaN(at.getTime())) return at.toLocaleString();
  }
  const whenText = String(todo.appointmentWhenText ?? "").trim();
  if (whenText) return whenText;
  const whenIso = String(todo.appointmentWhenIso ?? "").trim();
  if (whenIso) {
    const at = new Date(whenIso);
    if (!Number.isNaN(at.getTime())) return at.toLocaleString();
  }
  return null;
}

function todoInboxSection(todo: TodoItem): TodoInboxSection {
  const explicitTaskClass = String(todo.taskClass ?? "").toLowerCase();
  const reason = String(todo.reason ?? "").toLowerCase();
  const summary = String(todo.summary ?? "").toLowerCase();
  const action = String(todo.action ?? "").toLowerCase();
  const hasAppointmentTime = !!todoAppointmentTimeLabel(todo);
  const hasAppointmentLanguage =
    /\b(appointment|schedule|scheduled|book|booking|reschedule|no[\s-]?show|showed up|show up|test ride|demo ride)\b/.test(
      `${reason} ${summary} ${action}`
    );
  if (explicitTaskClass === "appointment") {
    // Prevent stale legacy appointment flags from forcing non-appointment
    // tasks into the appointment bucket.
    if (hasAppointmentTime) return "appointment";
  } else if (
    explicitTaskClass === "followup" ||
    explicitTaskClass === "todo" ||
    explicitTaskClass === "reminder"
  ) {
    return explicitTaskClass as TodoInboxSection;
  }
  const followupSignalForCall =
    reason === "call" &&
    (/^call customer \(follow-up\):/i.test(summary) ||
      /^call customer \((initial reply sent|follow[- ]?up)\)/i.test(summary) ||
      /\bfollow[- ]?up\b/i.test(summary) ||
      /\binitial reply sent\b/i.test(summary) ||
      /\bcadence\b/i.test(summary) ||
      /\bfollow[- ]?up\b/i.test(action));
  if (followupSignalForCall && explicitTaskClass !== "reminder") {
    return "followup";
  }
  const appointmentSignal =
    reason !== "service" &&
    reason !== "parts" &&
    reason !== "apparel" &&
    reason !== "note" &&
    hasAppointmentLanguage;
  if (appointmentSignal && hasAppointmentTime) {
    return "appointment";
  }
  const isCadenceFollowUpCall =
    reason === "call" &&
    (/^call customer \(follow-up\):/i.test(summary) ||
      /\bfollow[- ]?up\b/i.test(summary) ||
      /\bfollow[- ]?up\b/i.test(action));
  if (isCadenceFollowUpCall) return "followup";

  const isReminderCall =
    reason === "call" &&
    (/^call requested:/i.test(summary) ||
      Boolean(String(todo.dueAt ?? "").trim()) ||
      Boolean(String(todo.reminderAt ?? "").trim()) ||
      /\brequested call time\b/i.test(summary) ||
      /\bremind(er)?\b/i.test(summary));
  if (isReminderCall) return "reminder";

  return "todo";
}

type SuppressionItem = {
  phone: string;
  addedAt: string;
  reason?: string;
  source?: string;
};

type ContactItem = {
  id: string;
  leadKey?: string;
  conversationId?: string;
  leadRef?: string;
  leadSource?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  vehicleDescription?: string;
  stockId?: string;
  vin?: string;
  year?: string;
  make?: string;
  vehicle?: string;
  model?: string;
  trim?: string;
  color?: string;
  condition?: string;
  inquiry?: string;
  lastAdfAt?: string;
  lastInboundAt?: string;
  updatedAt?: string;
  status?: "active" | "archived" | "suppressed";
};

type ContactListItem = {
  id: string;
  name: string;
  source?: "manual" | "csv" | "filter";
  contactIds?: string[];
  contactCount?: number;
  filter?: {
    condition?: string;
    year?: string;
    make?: string;
    model?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  lastImportAt?: string;
};

type KpiLeadType = "all" | "new" | "used" | "walk_in";
type KpiLeadScope = "online_only" | "include_walkins" | "walkin_only";

type KpiOverview = {
  applied: {
    from: string;
    to: string;
    source: string;
    ownerId: string;
    leadType: KpiLeadType;
    leadScope: KpiLeadScope;
  };
  totals: {
    leadVolume: number;
    respondedCount: number;
    responseRatePct: number;
    avgFirstResponseMinutes: number | null;
    medianFirstResponseMinutes: number | null;
    callCount: number;
    callRatePct: number;
    avgTimeToCallMinutes: number | null;
    medianTimeToCallMinutes: number | null;
    appointmentCount: number;
    appointmentRatePct: number;
    appointmentShowedCount: number;
    appointmentShowRatePct: number;
    soldCount: number;
    soldCloseRatePct: number;
    closedCount: number;
    closeRatePct: number;
    avgTimeToCloseDays: number | null;
    medianTimeToCloseDays: number | null;
    closeRate30dPct: number;
    closeRate60dPct: number;
    closeRate90dPct: number;
    closeRate120dPct: number;
  };
  bySource: Array<{
    source: string;
    leadCount: number;
    responseRatePct: number;
    appointmentRatePct: number;
    appointmentShowRatePct: number;
    callRatePct: number;
    soldCloseRatePct: number;
  }>;
  topMotorcycles: Array<{
    motorcycle: string;
    count: number;
    newCount: number;
    usedCount: number;
  }>;
  trend: Array<{
    day: string;
    leadCount: number;
    respondedCount: number;
    responseRatePct: number;
    appointmentCount: number;
    appointmentShowedCount: number;
    callCount: number;
    soldCount: number;
  }>;
  callDetails: Array<{
    convId: string;
    leadKey: string;
    leadName: string;
    leadPhone: string;
    source: string;
    ownerId: string;
    ownerName: string;
    firstInboundAt: string | null;
    firstCallAt: string | null;
    timeToCallMinutes: number | null;
  }>;
};

type CampaignBuildMode = "design_from_scratch" | "web_search_design";
type CampaignChannel = "sms" | "email" | "both";
type CampaignAssetTarget =
  | "sms"
  | "email"
  | "facebook_post"
  | "instagram_post"
  | "instagram_story"
  | "web_banner"
  | "flyer_8_5x11";
type CampaignTag =
  | "sales"
  | "parts"
  | "apparel"
  | "service"
  | "financing"
  | "national_campaign"
  | "dealer_event";

type CampaignSourceHit = {
  title?: string;
  snippet?: string;
  url?: string;
  domain?: string;
};

type CampaignGeneratedAsset = {
  id?: string;
  target: CampaignAssetTarget;
  label?: string;
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bytes?: number;
  createdAt?: string;
};

type CampaignQueueKind = "send" | "post";

type CampaignAssetGenerationStatus = "pending" | "ready" | "failed";
type CampaignAssetGenerationEntry = {
  status: CampaignAssetGenerationStatus;
  updatedAt?: string;
  error?: string;
  attemptCount?: number;
  lastGeneratedAt?: string;
};
type CampaignAssetGenerationMap = Partial<Record<CampaignAssetTarget, CampaignAssetGenerationEntry>>;

type CampaignEntry = {
  id: string;
  name: string;
  status?: "draft" | "generated";
  buildMode: CampaignBuildMode;
  channel: CampaignChannel;
  tags: CampaignTag[];
  assetTargets?: CampaignAssetTarget[];
  prompt?: string;
  description?: string;
  inspirationImageUrls?: string[];
  assetImageUrls?: string[];
  briefDocumentUrls?: string[];
  smsBody?: string;
  emailSubject?: string;
  emailBodyText?: string;
  emailBodyHtml?: string;
  finalImageUrl?: string;
  generatedAssets?: CampaignGeneratedAsset[];
  assetGenerationStatus?: CampaignAssetGenerationMap;
  sourceHits?: CampaignSourceHit[];
  metadata?: Record<string, unknown>;
  generatedBy?: "nano_banana" | "llm_fallback" | "template";
  createdAt?: string;
  updatedAt?: string;
};

type MetaPageStatus = {
  id: string;
  name: string;
  hasInstagram: boolean;
  instagramBusinessAccountId?: string;
  instagramBusinessAccountUsername?: string;
};

type MetaIntegrationStatus = {
  connected: boolean;
  connectedAt?: string;
  updatedAt?: string;
  pageId?: string;
  pageName?: string;
  hasInstagram?: boolean;
  instagramBusinessAccountId?: string;
  instagramBusinessAccountUsername?: string;
  availablePages?: MetaPageStatus[];
  reason?: string;
  error?: string;
};

type CampaignSocialPublishOptions = {
  linkUrl?: string;
  mentionHandles?: string;
  locationName?: string;
  gifUrl?: string;
  musicCue?: string;
  stickerText?: string;
};

type CampaignUploadDropZone = "briefs" | "refs" | "design";
type CampaignUrlTextField = "inspirationImageUrlsText" | "assetImageUrlsText" | "briefDocumentUrlsText";

const CAMPAIGN_ASSET_TARGET_OPTIONS: Array<{ value: CampaignAssetTarget; label: string }> = [
  { value: "sms", label: "SMS" },
  { value: "email", label: "Email" },
  { value: "facebook_post", label: "Facebook post" },
  { value: "instagram_post", label: "Instagram post" },
  { value: "instagram_story", label: "Instagram story" },
  { value: "web_banner", label: "Web banner" },
  { value: "flyer_8_5x11", label: "Flyer (8.5x11)" }
];

const CAMPAIGN_TAG_OPTIONS: Array<{ value: CampaignTag; label: string }> = [
  { value: "sales", label: "Sales" },
  { value: "parts", label: "Parts" },
  { value: "apparel", label: "Apparel" },
  { value: "service", label: "Service" },
  { value: "financing", label: "Financing" },
  { value: "national_campaign", label: "National campaign" },
  { value: "dealer_event", label: "Dealer event" }
];

function campaignAssetDisplayLabel(asset: CampaignGeneratedAsset): string {
  const base =
    String(asset.label ?? "").trim() ||
    CAMPAIGN_ASSET_TARGET_OPTIONS.find(opt => opt.value === asset.target)?.label ||
    asset.target;
  const dim = asset.width && asset.height ? `${asset.width}x${asset.height}` : "";
  return dim ? `${base} (${dim})` : base;
}

function normalizeCampaignAssetGenerationMap(raw: unknown): CampaignAssetGenerationMap {
  const out: CampaignAssetGenerationMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [targetRaw, rowRaw] of Object.entries(raw as Record<string, unknown>)) {
    const target = String(targetRaw ?? "").trim() as CampaignAssetTarget;
    if (!CAMPAIGN_ASSET_TARGET_OPTIONS.some(opt => opt.value === target)) continue;
    if (!rowRaw || typeof rowRaw !== "object") continue;
    const statusRaw = String((rowRaw as any)?.status ?? "").trim().toLowerCase();
    const status: CampaignAssetGenerationStatus =
      statusRaw === "ready" || statusRaw === "failed" || statusRaw === "pending"
        ? (statusRaw as CampaignAssetGenerationStatus)
        : "pending";
    out[target] = {
      status,
      updatedAt: String((rowRaw as any)?.updatedAt ?? "").trim() || undefined,
      error: String((rowRaw as any)?.error ?? "").trim() || undefined,
      attemptCount:
        Number.isFinite(Number((rowRaw as any)?.attemptCount)) && Number((rowRaw as any)?.attemptCount) > 0
          ? Math.round(Number((rowRaw as any)?.attemptCount))
          : undefined,
      lastGeneratedAt: String((rowRaw as any)?.lastGeneratedAt ?? "").trim() || undefined
    };
  }
  return out;
}

function campaignUrlsToText(values?: string[] | null): string {
  return Array.isArray(values) ? values.filter(Boolean).join("\n") : "";
}

function extractUrlsFromCampaignText(raw: string): string[] {
  const normalized = String(raw ?? "").trim();
  if (!normalized) return [];
  const matches = normalized.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  if (matches.length) {
    return matches
      .map(v => v.trim().replace(/[),.;!?]+$/g, ""))
      .filter(Boolean);
  }
  return normalized
    .split(/\n+/)
    .map(v => v.trim())
    .filter(Boolean);
}

function looksLikeCampaignImageUrl(raw: string): boolean {
  const url = String(raw ?? "").trim();
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.includes("/uploads/campaigns/")) return true;
  try {
    const parsed = new URL(url);
    const pathname = String(parsed.pathname ?? "").toLowerCase();
    return /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(pathname);
  } catch {
    return false;
  }
}

function parseCampaignUrlsText(raw: string): string[] {
  return Array.from(
    new Set(
      extractUrlsFromCampaignText(raw)
        .map(v => v.trim())
        .filter(Boolean)
    )
  );
}

function campaignFileLabelFromUrl(url: string, fallback: string): string {
  const value = String(url ?? "").trim();
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    const last = String(parsed.pathname ?? "").split("/").filter(Boolean).pop();
    return decodeURIComponent(last || fallback);
  } catch {
    const last = value.split("/").filter(Boolean).pop();
    return decodeURIComponent(last || fallback);
  }
}

function formatFileSizeShort(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function readImageDimensionsFromBlob(blob: Blob): Promise<{ width: number; height: number } | null> {
  const mime = String(blob?.type ?? "").toLowerCase();
  if (!mime.startsWith("image/")) return null;
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const dims = { width: Number(bitmap.width ?? 0), height: Number(bitmap.height ?? 0) };
      bitmap.close();
      if (dims.width > 0 && dims.height > 0) return dims;
    } catch {
      // fall through to HTMLImageElement probe
    }
  }
  return await new Promise(resolve => {
    const objUrl = window.URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const width = Number(img.naturalWidth ?? img.width ?? 0);
      const height = Number(img.naturalHeight ?? img.height ?? 0);
      window.URL.revokeObjectURL(objUrl);
      if (width > 0 && height > 0) {
        resolve({ width, height });
        return;
      }
      resolve(null);
    };
    img.onerror = () => {
      window.URL.revokeObjectURL(objUrl);
      resolve(null);
    };
    img.src = objUrl;
  });
}

function deriveCampaignChannelFromTargets(targets: CampaignAssetTarget[] | null | undefined): CampaignChannel {
  const set = new Set<CampaignAssetTarget>(Array.isArray(targets) ? targets : []);
  const hasSms = set.has("sms");
  const hasEmail = set.has("email");
  if (hasSms && hasEmail) return "both";
  if (hasEmail) return "email";
  if (hasSms) return "sms";
  return "both";
}

function campaignQueueEntry(
  entry: CampaignEntry | null | undefined,
  queue: CampaignQueueKind
): Record<string, unknown> | null {
  const meta = entry?.metadata;
  if (!meta || typeof meta !== "object") return null;
  const queueRoot = (meta as any)?.queue;
  if (!queueRoot || typeof queueRoot !== "object") return null;
  const row = (queueRoot as any)?.[queue];
  if (!row || typeof row !== "object") return null;
  return row as Record<string, unknown>;
}

function campaignQueueKindForAssetTarget(target: CampaignAssetTarget): CampaignQueueKind | null {
  if (target === "sms" || target === "email") return "send";
  if (target === "facebook_post" || target === "instagram_post" || target === "instagram_story") {
    return "post";
  }
  return null;
}

function campaignAssetQueueEntry(
  entry: CampaignEntry | null | undefined,
  target: CampaignAssetTarget
): Record<string, unknown> | null {
  const meta = entry?.metadata;
  if (!meta || typeof meta !== "object") return null;
  const root = (meta as any)?.assetQueue;
  if (!root || typeof root !== "object") return null;
  const row = (root as any)?.[target];
  if (!row || typeof row !== "object") return null;
  return row as Record<string, unknown>;
}

function campaignQueuedAssetTargetsForQueue(
  entry: CampaignEntry | null | undefined,
  queue: CampaignQueueKind
): CampaignAssetTarget[] {
  const meta = entry?.metadata;
  if (!meta || typeof meta !== "object") return [];
  const root = (meta as any)?.assetQueue;
  if (!root || typeof root !== "object") return [];
  const out: CampaignAssetTarget[] = [];
  for (const [targetRaw, rowRaw] of Object.entries(root as Record<string, unknown>)) {
    const target = String(targetRaw ?? "").trim() as CampaignAssetTarget;
    if (!target || !CAMPAIGN_ASSET_TARGET_OPTIONS.some(opt => opt.value === target)) continue;
    if (!rowRaw || typeof rowRaw !== "object") continue;
    const status = String((rowRaw as any)?.status ?? "").trim().toLowerCase();
    if (status !== "queued") continue;
    const rowQueueRaw = String((rowRaw as any)?.queue ?? "").trim().toLowerCase();
    const rowQueue =
      rowQueueRaw === "send" || rowQueueRaw === "post"
        ? (rowQueueRaw as CampaignQueueKind)
        : campaignQueueKindForAssetTarget(target);
    if (rowQueue !== queue) continue;
    out.push(target);
  }
  return Array.from(new Set(out));
}

function campaignQueuedAssetAtIsoForQueue(
  entry: CampaignEntry | null | undefined,
  queue: CampaignQueueKind
): string {
  const meta = entry?.metadata;
  if (!meta || typeof meta !== "object") return "";
  const root = (meta as any)?.assetQueue;
  if (!root || typeof root !== "object") return "";
  let best = "";
  for (const [targetRaw, rowRaw] of Object.entries(root as Record<string, unknown>)) {
    const target = String(targetRaw ?? "").trim() as CampaignAssetTarget;
    if (!target || !CAMPAIGN_ASSET_TARGET_OPTIONS.some(opt => opt.value === target)) continue;
    if (!rowRaw || typeof rowRaw !== "object") continue;
    const status = String((rowRaw as any)?.status ?? "").trim().toLowerCase();
    if (status !== "queued") continue;
    const rowQueueRaw = String((rowRaw as any)?.queue ?? "").trim().toLowerCase();
    const rowQueue =
      rowQueueRaw === "send" || rowQueueRaw === "post"
        ? (rowQueueRaw as CampaignQueueKind)
        : campaignQueueKindForAssetTarget(target);
    if (rowQueue !== queue) continue;
    const iso = String((rowRaw as any)?.queuedAt ?? (rowRaw as any)?.updatedAt ?? "").trim();
    if (!iso) continue;
    if (!best || new Date(iso).getTime() > new Date(best).getTime()) best = iso;
  }
  return best;
}

function campaignAssetIsQueued(entry: CampaignEntry | null | undefined, target: CampaignAssetTarget): boolean {
  const row = campaignAssetQueueEntry(entry, target);
  return String(row?.status ?? "").trim().toLowerCase() === "queued";
}

function campaignAssetQueuedAtIso(entry: CampaignEntry | null | undefined, target: CampaignAssetTarget): string {
  const row = campaignAssetQueueEntry(entry, target);
  const iso = String(row?.queuedAt ?? row?.updatedAt ?? "").trim();
  if (iso) return iso;
  return String(entry?.updatedAt ?? entry?.createdAt ?? "").trim();
}

function campaignIsQueued(entry: CampaignEntry | null | undefined, queue: CampaignQueueKind): boolean {
  const row = campaignQueueEntry(entry, queue);
  if (String(row?.status ?? "").trim().toLowerCase() === "queued") return true;
  return campaignQueuedAssetTargetsForQueue(entry, queue).length > 0;
}

function campaignQueuedAtIso(entry: CampaignEntry | null | undefined, queue: CampaignQueueKind): string {
  const row = campaignQueueEntry(entry, queue);
  const iso = String(row?.queuedAt ?? row?.updatedAt ?? "").trim();
  if (iso) return iso;
  const assetIso = campaignQueuedAssetAtIsoForQueue(entry, queue);
  if (assetIso) return assetIso;
  return String(entry?.updatedAt ?? entry?.createdAt ?? "").trim();
}

function campaignFindGeneratedAsset(
  entry: CampaignEntry | null | undefined,
  target: CampaignAssetTarget
): CampaignGeneratedAsset | null {
  if (!entry) return null;
  const assets = Array.isArray(entry.generatedAssets) ? entry.generatedAssets : [];
  const exact = assets.find(row => String(row?.target ?? "").trim() === target && String(row?.url ?? "").trim());
  if (exact) return exact;
  const fallbackUrl = String(entry.finalImageUrl ?? "").trim();
  if (!fallbackUrl) return null;
  return {
    target,
    label: CAMPAIGN_ASSET_TARGET_OPTIONS.find(opt => opt.value === target)?.label ?? target,
    url: fallbackUrl
  };
}

function campaignTrimToLimit(raw: unknown, max = 1800): string {
  return String(raw ?? "").trim().slice(0, max);
}

function campaignSanitizePublishOptionText(raw: unknown, max = 220): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function campaignSanitizeUrl(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return "";
  return value.slice(0, 1000);
}

function campaignNormalizeSocialPublishOptions(raw: unknown): CampaignSocialPublishOptions {
  if (!raw || typeof raw !== "object") return {};
  const row = raw as Record<string, unknown>;
  const linkUrl = campaignSanitizeUrl(row.linkUrl);
  const mentionHandles = campaignSanitizePublishOptionText(row.mentionHandles, 220);
  const locationName = campaignSanitizePublishOptionText(row.locationName, 140);
  const gifUrl = campaignSanitizeUrl(row.gifUrl);
  const musicCue = campaignSanitizePublishOptionText(row.musicCue, 120);
  const stickerText = campaignSanitizePublishOptionText(row.stickerText, 120);
  return {
    linkUrl: linkUrl || undefined,
    mentionHandles: mentionHandles || undefined,
    locationName: locationName || undefined,
    gifUrl: gifUrl || undefined,
    musicCue: musicCue || undefined,
    stickerText: stickerText || undefined
  };
}

function campaignNormalizeSocialPublishOptionsMap(raw: unknown): Partial<Record<CampaignAssetTarget, CampaignSocialPublishOptions>> {
  const out: Partial<Record<CampaignAssetTarget, CampaignSocialPublishOptions>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [targetRaw, rowRaw] of Object.entries(raw as Record<string, unknown>)) {
    const target = String(targetRaw ?? "").trim() as CampaignAssetTarget;
    if (!CAMPAIGN_ASSET_TARGET_OPTIONS.some(opt => opt.value === target)) continue;
    out[target] = campaignNormalizeSocialPublishOptions(rowRaw);
  }
  return out;
}

function campaignMentionLine(raw: string | undefined): string {
  const input = String(raw ?? "").trim();
  if (!input) return "";
  const handles = Array.from(
    new Set(
      input
        .split(/[,\s]+/)
        .map(v => v.trim())
        .filter(Boolean)
        .map(v => (v.startsWith("@") ? v : `@${v.replace(/^@+/, "")}`))
    )
  );
  return handles.join(" ");
}

function campaignTagHashtags(tags: CampaignTag[] | undefined): string {
  const seed = Array.isArray(tags) ? tags : [];
  const out: string[] = [];
  const add = (v: string) => {
    if (!out.includes(v)) out.push(v);
  };
  for (const tag of seed) {
    if (tag === "sales") add("#HarleyDavidsonDeals");
    if (tag === "parts") add("#HarleyParts");
    if (tag === "apparel") add("#HarleyGear");
    if (tag === "service") add("#HarleyService");
    if (tag === "financing") add("#RideNowPayLater");
    if (tag === "national_campaign") add("#HarleyEvent");
    if (tag === "dealer_event") add("#DealerEvent");
  }
  add("#HarleyDavidson");
  add("#AmericanHarley");
  add("#RideWithUs");
  return out.slice(0, 6).join(" ");
}

function campaignSplitCaptionSentences(raw: string): string[] {
  const input = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!input) return [];
  const parts = input.match(/[^.!?]+[.!?]?/g) ?? [];
  return parts.map(part => part.trim()).filter(Boolean);
}

function campaignNormalizeCaptionSentence(raw: string): string {
  let text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text.replace(
    /^(?:gen(?:e|r)?ate|create)\s+a?\s*campaign[\s\S]*?\bfor\s+an?\s+event\s+called\s+/i,
    ""
  );
  text = text.replace(/^(?:for\s+an?\s+event\s+called|event\s+called)\s+/i, "");
  text = text.replace(/^using\s+the\s+reference\s+image[\s\S]*?\bfor\s+styling\b/i, "");
  text = text.replace(/^important[:,]?\s*/i, "");
  text = text.replace(/^make\s+sure\s+/i, "");
  text = text.replace(/\s{2,}/g, " ").trim();
  return text;
}

function campaignIsInstructionSentence(raw: string): boolean {
  const text = String(raw ?? "").toLowerCase();
  if (!text) return true;
  if (
    /\b(make sure|important|output format|step \d+|drag|drop|choose|reference image|design images?|logos? must|put .* bottom|include .* logo|separate from)\b/.test(
      text
    )
  ) {
    return true;
  }
  if (/\b(gen(?:e|r)?ate|create)\s+a?\s*campaign\b/.test(text) && !/\bevent\s+called\b/.test(text)) {
    return true;
  }
  return false;
}

function campaignCaptionHasInstructionSignals(raw: string): boolean {
  const input = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!input) return false;
  if (/\b(genrate|generate|create)\s+a?\s*campaign\b/i.test(input)) return true;
  for (const sentence of campaignSplitCaptionSentences(input)) {
    if (campaignIsInstructionSentence(sentence)) return true;
  }
  return false;
}

function campaignSanitizeCaptionDetail(raw: unknown): string {
  const input = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!input) return "";
  const out: string[] = [];
  for (const sentenceRaw of campaignSplitCaptionSentences(input)) {
    const sentence = campaignNormalizeCaptionSentence(sentenceRaw);
    if (!sentence) continue;
    if (campaignIsInstructionSentence(sentence)) continue;
    out.push(sentence);
    if (out.length >= 2) break;
  }
  if (out.length) return out.join(" ").trim();
  const eventCalled = input.match(/event\s+called\s+(.+?)(?:\.|$)/i);
  if (eventCalled?.[1]) return campaignNormalizeCaptionSentence(eventCalled[1]);
  return "";
}

function campaignFirstEmailParagraph(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  return text.split(/\n\s*\n/).map(v => v.trim()).find(Boolean) ?? "";
}

function campaignDeriveCaptionDetail(entry: CampaignEntry): string {
  const fromDescription = campaignSanitizeCaptionDetail(entry.description);
  if (fromDescription) return fromDescription;
  const fromSms = campaignSanitizeCaptionDetail(entry.smsBody);
  if (fromSms) return fromSms;
  const fromEmail = campaignSanitizeCaptionDetail(campaignFirstEmailParagraph(entry.emailBodyText));
  if (fromEmail) return fromEmail;
  const fromPrompt = campaignSanitizeCaptionDetail(entry.prompt);
  if (fromPrompt) return fromPrompt;
  return "";
}

function campaignLooksLikeEvent(entry: CampaignEntry, detail: string): boolean {
  const joined = [entry.name, entry.description, entry.prompt, detail].map(v => String(v ?? "").toLowerCase()).join(" ");
  return /\b(event|pre-?party|open house|rsvp|join us|saturday|sunday|monday|tuesday|wednesday|thursday|friday|\d{1,2}\s?(?:am|pm))\b/.test(
    joined
  );
}

function campaignWantsRsvpLanguage(entry: CampaignEntry, detail: string): boolean {
  const joined = [entry.name, entry.description, entry.prompt, detail].map(v => String(v ?? "").toLowerCase()).join(" ");
  return /\b(rsvp|register|registration|book(?:\s+(?:a|your))?\s*spot|reserve(?:\s+(?:a|your))?\s*spot|save\s+your\s+spot)\b/.test(
    joined
  );
}

function campaignBuildCatchyCaption(entry: CampaignEntry): string {
  const name = campaignTrimToLimit(entry.name, 140);
  const detailRaw = campaignDeriveCaptionDetail(entry);
  const detail = campaignTrimToLimit(detailRaw, 280);
  const intro = name || "Fresh inventory just dropped";
  const tags = campaignTagHashtags(entry.tags);
  const eventLike = (entry.tags ?? []).includes("dealer_event") || campaignLooksLikeEvent(entry, detail);
  const cta = eventLike
    ? campaignWantsRsvpLanguage(entry, detail)
      ? "Message us to RSVP and get event details."
      : "Message us for event details."
    : "Message us for pricing, availability, and next steps.";
  const lines = [intro, detail || "New arrivals, standout options, and serious riding season energy.", cta, tags].filter(Boolean);
  return lines.join("\n\n").slice(0, 1800);
}

function campaignComposePublishCaption(
  baseCaptionRaw: string,
  options?: CampaignSocialPublishOptions
): string {
  const baseCaption = campaignTrimToLimit(baseCaptionRaw, 1600);
  const normalized = campaignNormalizeSocialPublishOptions(options);
  const extras: string[] = [];
  const mentions = campaignMentionLine(normalized.mentionHandles);
  if (mentions) extras.push(mentions);
  if (normalized.locationName) extras.push(`Location: ${normalized.locationName}`);
  if (normalized.musicCue) extras.push(`Music cue: ${normalized.musicCue}`);
  if (normalized.stickerText) extras.push(`Sticker: ${normalized.stickerText}`);
  if (normalized.linkUrl) extras.push(normalized.linkUrl);
  if (normalized.gifUrl) extras.push(`GIF: ${normalized.gifUrl}`);
  const merged = [baseCaption, ...extras].filter(Boolean).join("\n\n").trim();
  return merged.slice(0, 1800);
}

function campaignAutoPublishCaption(entry: CampaignEntry | null | undefined): string {
  if (!entry) return "";
  const meta = entry.metadata && typeof entry.metadata === "object" ? (entry.metadata as Record<string, unknown>) : null;
  const explicitRaw =
    String(meta?.socialCaption ?? meta?.caption ?? "").trim() ||
    String(meta?.publishCaption ?? "").trim();
  if (explicitRaw && !campaignCaptionHasInstructionSignals(explicitRaw)) return explicitRaw.slice(0, 1800);

  const catchy = campaignBuildCatchyCaption(entry);
  if (catchy) return catchy;

  const sms = String(entry.smsBody ?? "").trim();
  if (sms) return sms.slice(0, 1800);

  const emailText = String(entry.emailBodyText ?? "").trim();
  if (emailText) {
    const firstParagraph = emailText.split(/\n\s*\n/).map(v => v.trim()).find(Boolean) ?? emailText;
    return firstParagraph.slice(0, 1800);
  }

  const description = String(entry.description ?? "").trim();
  if (description) return description.slice(0, 1800);

  const fallbackName = String(entry.name ?? "").trim();
  return fallbackName ? `${fallbackName} — message us for details.` : "";
}

const EMPTY_CAMPAIGN_FORM = {
  name: "",
  buildMode: "design_from_scratch" as CampaignBuildMode,
  channel: "both" as CampaignChannel,
  tags: [] as CampaignTag[],
  assetTargets: [] as CampaignAssetTarget[],
  prompt: "",
  description: "",
  inspirationImageUrlsText: "",
  assetImageUrlsText: "",
  briefDocumentUrlsText: "",
  smsBody: "",
  emailSubject: "",
  emailBodyText: "",
  emailBodyHtml: ""
};

export default function Home() {
  const [mode, setMode] = useState<SystemMode>("suggest");
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [questionOutcomeById, setQuestionOutcomeById] = useState<Record<string, string>>({});
  const [questionFollowUpById, setQuestionFollowUpById] = useState<Record<string, string>>({});
  const [suppressions, setSuppressions] = useState<SuppressionItem[]>([]);
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [newSuppression, setNewSuppression] = useState("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"inbox" | "campaigns" | "archive">("inbox");
  const [section, setSection] = useState<
    | "inbox"
    | "todos"
    | "questions"
    | "suppressions"
    | "contacts"
    | "watches"
    | "inventory"
    | "campaigns"
    | "kpi"
    | "settings"
    | "calendar"
  >("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConv, setSelectedConv] = useState<ConversationDetail | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"list" | "detail">("list");
  const [cadenceResolveOpen, setCadenceResolveOpen] = useState(false);
  const [cadenceResolveMode, setCadenceResolveMode] = useState<"alert" | "watch">("alert");
  const [cadenceResolveConv, setCadenceResolveConv] = useState<ConversationDetail | null>(null);
  const [cadenceResolution, setCadenceResolution] = useState("resume");
  const [cadenceResumeDate, setCadenceResumeDate] = useState("");
  const [cadenceWatchEnabled, setCadenceWatchEnabled] = useState(false);
  const [cadenceWatchItems, setCadenceWatchItems] = useState<WatchFormItem[]>([]);
  const [cadenceWatchNote, setCadenceWatchNote] = useState("");
  const [cadenceResolveSaving, setCadenceResolveSaving] = useState(false);
  const [cadenceResolveError, setCadenceResolveError] = useState<string | null>(null);
  const [cadenceResolveNotice, setCadenceResolveNotice] = useState<string | null>(null);
  const [watchQuery, setWatchQuery] = useState("");
  const [watchSalespersonFilter, setWatchSalespersonFilter] = useState("all");
  const [inboxQuery, setInboxQuery] = useState("");
  const [inboxOwnerFilter, setInboxOwnerFilter] = useState("all");
  const [inboxDealFilter, setInboxDealFilter] = useState<InboxDealFilter>("all");
  const [campaignInboxExpanded, setCampaignInboxExpanded] = useState<Record<string, boolean>>({});
  const [todoQuery, setTodoQuery] = useState("");
  const [todoLeadOwnerFilter, setTodoLeadOwnerFilter] = useState("all");
  const [todoTaskTypeFilter, setTodoTaskTypeFilter] = useState<"all" | TodoInboxSection>("all");
  const [kpiOverview, setKpiOverview] = useState<KpiOverview | null>(null);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [kpiError, setKpiError] = useState<string | null>(null);
  const [kpiSourceFilter, setKpiSourceFilter] = useState("all");
  const [kpiLeadTypeFilter, setKpiLeadTypeFilter] = useState<KpiLeadType>("all");
  const [kpiLeadScopeFilter, setKpiLeadScopeFilter] = useState<KpiLeadScope>("online_only");
  const [kpiOwnerFilter, setKpiOwnerFilter] = useState("all");
  const [kpiCallOwnerFilter, setKpiCallOwnerFilter] = useState("all");
  const [kpiFrom, setKpiFrom] = useState<string>("");
  const [kpiTo, setKpiTo] = useState<string>("");
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [campaignSaving, setCampaignSaving] = useState(false);
  const [campaignGenerating, setCampaignGenerating] = useState(false);
  const [campaignAssetQueueBusyTarget, setCampaignAssetQueueBusyTarget] =
    useState<CampaignAssetTarget | "">("");
  const [campaignDeletingId, setCampaignDeletingId] = useState("");
  const [campaignRemovingAssetKey, setCampaignRemovingAssetKey] = useState("");
  const [campaignInspirationUploadBusy, setCampaignInspirationUploadBusy] = useState(false);
  const [campaignAssetUploadBusy, setCampaignAssetUploadBusy] = useState(false);
  const [campaignBriefUploadBusy, setCampaignBriefUploadBusy] = useState(false);
  const [campaignActiveDropZone, setCampaignActiveDropZone] = useState<CampaignUploadDropZone | "">("");
  const [metaStatus, setMetaStatus] = useState<MetaIntegrationStatus | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaActionBusy, setMetaActionBusy] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [campaignQueueActionBusyKey, setCampaignQueueActionBusyKey] = useState("");
  const [campaignQueueSendDialogCampaignId, setCampaignQueueSendDialogCampaignId] = useState("");
  const [campaignQueueSendDialogTarget, setCampaignQueueSendDialogTarget] = useState<CampaignAssetTarget | "">("");
  const [campaignQueueSendDialogListId, setCampaignQueueSendDialogListId] = useState("all");
  const [campaignQueuePublishDialogCampaignId, setCampaignQueuePublishDialogCampaignId] = useState("");
  const [campaignQueuePublishDialogTarget, setCampaignQueuePublishDialogTarget] = useState<CampaignAssetTarget | "">("");
  const [campaignQueuePublishCaptionByTarget, setCampaignQueuePublishCaptionByTarget] = useState<
    Partial<Record<CampaignAssetTarget, string>>
  >({});
  const [campaignQueuePublishOptionsByTarget, setCampaignQueuePublishOptionsByTarget] = useState<
    Partial<Record<CampaignAssetTarget, CampaignSocialPublishOptions>>
  >({});
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [campaignSelectedId, setCampaignSelectedId] = useState("");
  const [campaignListFilter, setCampaignListFilter] = useState<"all" | CampaignQueueKind>("all");
  const [campaignForm, setCampaignForm] = useState({ ...EMPTY_CAMPAIGN_FORM });
  const [campaignSourceHits, setCampaignSourceHits] = useState<CampaignSourceHit[]>([]);
  const [campaignGeneratedBy, setCampaignGeneratedBy] = useState<string>("");
  const [campaignGeneratedAt, setCampaignGeneratedAt] = useState<string>("");
  const [campaignFinalImageUrl, setCampaignFinalImageUrl] = useState<string>("");
  const [campaignGeneratedAssets, setCampaignGeneratedAssets] = useState<CampaignGeneratedAsset[]>([]);
  const [campaignTargetToGenerate, setCampaignTargetToGenerate] = useState<CampaignAssetTarget>("sms");
  const [campaignEditFromCurrentImage, setCampaignEditFromCurrentImage] = useState(false);
  const campaignBriefUploadInputRef = useRef<HTMLInputElement | null>(null);
  const campaignInspirationUploadInputRef = useRef<HTMLInputElement | null>(null);
  const campaignAssetUploadInputRef = useRef<HTMLInputElement | null>(null);
  const campaignInspirationPreviewUrls = useMemo(
    () =>
      parseCampaignUrlsText(campaignForm.inspirationImageUrlsText)
        .filter(looksLikeCampaignImageUrl),
    [campaignForm.inspirationImageUrlsText]
  );
  const campaignBriefPreviewUrls = useMemo(
    () => parseCampaignUrlsText(campaignForm.briefDocumentUrlsText),
    [campaignForm.briefDocumentUrlsText]
  );
  const campaignAssetPreviewUrls = useMemo(
    () =>
      parseCampaignUrlsText(campaignForm.assetImageUrlsText)
        .filter(looksLikeCampaignImageUrl),
    [campaignForm.assetImageUrlsText]
  );
  const campaignEffectiveChannel = useMemo(
    () => deriveCampaignChannelFromTargets(campaignForm.assetTargets),
    [campaignForm.assetTargets]
  );
  const campaignSelectedTargets = useMemo(
    () => new Set<CampaignAssetTarget>(Array.isArray(campaignForm.assetTargets) ? campaignForm.assetTargets : []),
    [campaignForm.assetTargets]
  );
  const campaignSelectedTargetsOrdered = useMemo(
    () =>
      CAMPAIGN_ASSET_TARGET_OPTIONS.map(opt => opt.value).filter(target =>
        (campaignForm.assetTargets ?? []).includes(target)
      ),
    [campaignForm.assetTargets]
  );
  const campaignActiveTarget = useMemo<CampaignAssetTarget>(
    () => campaignSelectedTargetsOrdered[0] ?? campaignTargetToGenerate,
    [campaignSelectedTargetsOrdered, campaignTargetToGenerate]
  );
  const campaignCurrentBaseImageUrl = useMemo(() => {
    const byTarget = (campaignGeneratedAssets ?? []).find(
      row => String(row.target ?? "").trim() === campaignActiveTarget
    );
    if (String(byTarget?.url ?? "").trim()) return String(byTarget?.url ?? "").trim();
    if ((campaignGeneratedAssets ?? []).length === 1) {
      const first = String(campaignGeneratedAssets[0]?.url ?? "").trim();
      if (first) return first;
    }
    return String(campaignFinalImageUrl ?? "").trim();
  }, [campaignGeneratedAssets, campaignActiveTarget, campaignFinalImageUrl]);
  const campaignHasCurrentBaseImage = Boolean(campaignCurrentBaseImageUrl);
  const campaignSelectedEntry = useMemo(
    () => campaigns.find(row => row.id === campaignSelectedId) ?? null,
    [campaigns, campaignSelectedId]
  );
  const campaignPreviewEntry = useMemo<CampaignEntry | null>(() => {
    if (campaignSelectedEntry) return campaignSelectedEntry;
    const name = String(campaignForm.name ?? "").trim();
    const prompt = String(campaignForm.prompt ?? "").trim();
    const description = String(campaignForm.description ?? "").trim();
    const smsBody = String(campaignForm.smsBody ?? "").trim();
    const emailBodyText = String(campaignForm.emailBodyText ?? "").trim();
    if (!name && !prompt && !description && !smsBody && !emailBodyText) return null;
    return {
      id: "preview",
      name: name || "Campaign preview",
      buildMode: campaignForm.buildMode,
      channel: campaignEffectiveChannel,
      tags: campaignForm.tags,
      prompt: prompt || undefined,
      description: description || undefined,
      smsBody: smsBody || undefined,
      emailBodyText: emailBodyText || undefined,
      metadata: {}
    };
  }, [campaignSelectedEntry, campaignForm, campaignEffectiveChannel]);
  const campaignAutoCaptionPreview = useMemo(
    () => campaignAutoPublishCaption(campaignPreviewEntry),
    [campaignPreviewEntry]
  );
  const campaignSocialOptionsByTarget = useMemo(
    () => campaignNormalizeSocialPublishOptionsMap((campaignSelectedEntry?.metadata as any)?.socialPublishOptions),
    [campaignSelectedEntry]
  );
  const campaignQueuePublishDialogEntry = useMemo(
    () => campaigns.find(row => row.id === campaignQueuePublishDialogCampaignId) ?? null,
    [campaigns, campaignQueuePublishDialogCampaignId]
  );
  const campaignQueueSendDialogEntry = useMemo(
    () => campaigns.find(row => row.id === campaignQueueSendDialogCampaignId) ?? null,
    [campaigns, campaignQueueSendDialogCampaignId]
  );
  const campaignQueueSendDialogTargets = useMemo(() => {
    const queued = campaignQueuedAssetTargetsForQueue(campaignQueueSendDialogEntry, "send");
    if (!campaignQueueSendDialogTarget) return queued;
    return queued.includes(campaignQueueSendDialogTarget) ? [campaignQueueSendDialogTarget] : queued;
  }, [campaignQueueSendDialogEntry, campaignQueueSendDialogTarget]);
  const campaignQueuePublishDialogTargets = useMemo(() => {
    const queued = campaignQueuedAssetTargetsForQueue(campaignQueuePublishDialogEntry, "post");
    if (!campaignQueuePublishDialogTarget) return queued;
    return queued.includes(campaignQueuePublishDialogTarget) ? [campaignQueuePublishDialogTarget] : queued;
  }, [campaignQueuePublishDialogEntry, campaignQueuePublishDialogTarget]);
  const campaignQueuePublishDialogAssets = useMemo(
    () =>
      campaignQueuePublishDialogTargets
        .map(target => campaignFindGeneratedAsset(campaignQueuePublishDialogEntry, target))
        .filter((row): row is CampaignGeneratedAsset => Boolean(row?.url)),
    [campaignQueuePublishDialogEntry, campaignQueuePublishDialogTargets]
  );
  const campaignSendQueue = useMemo(
    () =>
      campaigns
        .filter(row => campaignIsQueued(row, "send"))
        .sort(
          (a, b) =>
            new Date(campaignQueuedAtIso(b, "send")).getTime() - new Date(campaignQueuedAtIso(a, "send")).getTime()
        ),
    [campaigns]
  );
  const campaignPostQueue = useMemo(
    () =>
      campaigns
        .filter(row => campaignIsQueued(row, "post"))
        .sort(
          (a, b) =>
            new Date(campaignQueuedAtIso(b, "post")).getTime() - new Date(campaignQueuedAtIso(a, "post")).getTime()
        ),
    [campaigns]
  );
  const campaignVisibleList = useMemo(() => {
    if (campaignListFilter === "send") return campaignSendQueue;
    if (campaignListFilter === "post") return campaignPostQueue;
    return campaigns;
  }, [campaignListFilter, campaignSendQueue, campaignPostQueue, campaigns]);
  const campaignListFilterLabel = useMemo(() => {
    if (campaignListFilter === "send") return "Send Queue";
    if (campaignListFilter === "post") return "Post Queue";
    return "All campaigns";
  }, [campaignListFilter]);
  const campaignAssetGenerationStatus = useMemo(() => {
    const fromEntry = normalizeCampaignAssetGenerationMap(campaignSelectedEntry?.assetGenerationStatus);
    if (Object.keys(fromEntry).length) return fromEntry;
    const meta = (campaignSelectedEntry?.metadata as any)?.assetGenerationStatus;
    return normalizeCampaignAssetGenerationMap(meta);
  }, [campaignSelectedEntry]);
  const campaignGeneratedAssetTargetSet = useMemo(
    () =>
      new Set<CampaignAssetTarget>(
        (campaignGeneratedAssets ?? [])
          .map(asset => String(asset?.target ?? "").trim() as CampaignAssetTarget)
          .filter(Boolean)
      ),
    [campaignGeneratedAssets]
  );
  const campaignWantsSms = campaignSelectedTargets.has("sms");
  const campaignWantsEmail = campaignSelectedTargets.has("email");
  const campaignHasAnyTarget = campaignSelectedTargets.size > 0;
  const campaignNextPendingTarget = useMemo(() => {
    const selected = campaignSelectedTargetsOrdered;
    if (!selected.length) return null;
    const firstPending = selected.find(target => {
      const status = String(campaignAssetGenerationStatus[target]?.status ?? "").trim().toLowerCase();
      if (status === "pending" || status === "failed") return true;
      return !campaignGeneratedAssetTargetSet.has(target);
    });
    return firstPending ?? selected[0] ?? null;
  }, [campaignAssetGenerationStatus, campaignGeneratedAssetTargetSet, campaignSelectedTargetsOrdered]);
  const cadenceResolveNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [watchEditOpen, setWatchEditOpen] = useState(false);
  const [watchEditConvId, setWatchEditConvId] = useState<string | null>(null);
  const [watchEditItems, setWatchEditItems] = useState<WatchFormItem[]>([]);
  const [watchEditNote, setWatchEditNote] = useState("");
  const [watchEditSaving, setWatchEditSaving] = useState(false);
  const [outcomeNoteOpen, setOutcomeNoteOpen] = useState(false);
  const [watchEditError, setWatchEditError] = useState<string | null>(null);
  const [modelsByYear, setModelsByYear] = useState<Record<string, string[]>>({});

  const [holdModalOpen, setHoldModalOpen] = useState(false);
  const [holdModalConv, setHoldModalConv] = useState<ConversationDetail | null>(null);
  const [holdInventoryItems, setHoldInventoryItems] = useState<any[]>([]);
  const [holdInventoryLoading, setHoldInventoryLoading] = useState(false);
  const [holdSearch, setHoldSearch] = useState("");
  const [holdSelection, setHoldSelection] = useState<any | null>(null);
  const [holdOnOrder, setHoldOnOrder] = useState(false);
  const [holdOnOrderLabel, setHoldOnOrderLabel] = useState("");
  const [holdNote, setHoldNote] = useState("");
  const [holdError, setHoldError] = useState<string | null>(null);
  const [holdSaving, setHoldSaving] = useState(false);
  const [holdDetailsOpen, setHoldDetailsOpen] = useState(false);
  const [soldDetailsOpen, setSoldDetailsOpen] = useState(false);
  const [soldModalOpen, setSoldModalOpen] = useState(false);
  const [soldModalConv, setSoldModalConv] = useState<ConversationDetail | null>(null);
  const [soldInventoryItems, setSoldInventoryItems] = useState<any[]>([]);
  const [soldInventoryLoading, setSoldInventoryLoading] = useState(false);
  const [soldSearch, setSoldSearch] = useState("");
  const [soldSelection, setSoldSelection] = useState<any | null>(null);
  const [soldManualOpen, setSoldManualOpen] = useState(false);
  const [soldManualUnit, setSoldManualUnit] = useState<any>({
    year: "",
    make: "",
    model: "",
    trim: "",
    color: "",
    stockId: "",
    vin: ""
  });
  const [soldNote, setSoldNote] = useState("");
  const [soldError, setSoldError] = useState<string | null>(null);
  const [soldSaving, setSoldSaving] = useState(false);
  const [agentContextText, setAgentContextText] = useState("");
  const [agentContextMode, setAgentContextMode] = useState<"persistent" | "next_reply">("persistent");
  const [agentContextExpiresAt, setAgentContextExpiresAt] = useState("");
  const [agentContextSaving, setAgentContextSaving] = useState(false);
  const [agentContextError, setAgentContextError] = useState<string | null>(null);
  const [agentContextOpen, setAgentContextOpen] = useState(false);
  const [agentContextSpeechSupported, setAgentContextSpeechSupported] = useState(false);
  const [agentContextSpeechListening, setAgentContextSpeechListening] = useState(false);
  const [agentContextSpeechError, setAgentContextSpeechError] = useState<string | null>(null);
  const agentContextSpeechRef = useRef<SpeechRecognitionLike | null>(null);
  const agentContextSpeechBaseRef = useRef("");
  const agentContextSpeechFinalRef = useRef("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composePhone, setComposePhone] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeShowDetails, setComposeShowDetails] = useState(false);
  const [composeFirstName, setComposeFirstName] = useState("");
  const [composeLastName, setComposeLastName] = useState("");
  const [composeEmail, setComposeEmail] = useState("");
  const [composeVehicle, setComposeVehicle] = useState<any>({});
  const [composeInventoryItems, setComposeInventoryItems] = useState<any[]>([]);
  const [composeInventoryLoading, setComposeInventoryLoading] = useState(false);
  const [composeInventoryOpen, setComposeInventoryOpen] = useState(false);
  const [composeSearch, setComposeSearch] = useState("");
  const [composeSelection, setComposeSelection] = useState<any | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeSending, setComposeSending] = useState(false);
  const [composeSmsAttachments, setComposeSmsAttachments] = useState<
    { name: string; type: string; size: number; file: File }[]
  >([]);
  const [composeSmsAttachmentsBusy, setComposeSmsAttachmentsBusy] = useState(false);
  const [selectedContact, setSelectedContact] = useState<ContactItem | null>(null);
  const [contactEdit, setContactEdit] = useState(false);
  const [contactForm, setContactForm] = useState({
    firstName: "",
    lastName: "",
    name: "",
    email: "",
    phone: ""
  });
  const [contactQuery, setContactQuery] = useState("");
  const [contactLists, setContactLists] = useState<ContactListItem[]>([]);
  const [selectedContactListId, setSelectedContactListId] = useState("all");
  const [newContactListName, setNewContactListName] = useState("");
  const [contactListFilterForm, setContactListFilterForm] = useState({
    condition: "",
    year: "",
    make: "",
    model: ""
  });
  const [importListName, setImportListName] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [broadcastBody, setBroadcastBody] = useState("");
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);
  const [newContactOpen, setNewContactOpen] = useState(false);
  const [newContactForm, setNewContactForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: ""
  });
  const [detailLoading, setDetailLoading] = useState(false);
  const [sendBody, setSendBody] = useState("");
  const [sendBodySource, setSendBodySource] = useState<"draft" | "user" | "system">("system");
  const [emailManualMode, setEmailManualMode] = useState(false);
  const [lastDraftId, setLastDraftId] = useState<string | null>(null);
  const [editPromptOpen, setEditPromptOpen] = useState(false);
  const [editNote, setEditNote] = useState("");
  const [pendingSend, setPendingSend] = useState<
    { body: string; draftId?: string; mediaUrls?: string[]; channel: "sms" | "email" } | null
  >(null);
  const [smsAttachments, setSmsAttachments] = useState<
    { name: string; type: string; size: number; url: string; mode: "mms" | "link" }[]
  >([]);
  const [smsAttachmentsBusy, setSmsAttachmentsBusy] = useState(false);
  const [emailAttachments, setEmailAttachments] = useState<
    { name: string; type: string; size: number; content: string }[]
  >([]);
  const [emailAttachmentsBusy, setEmailAttachmentsBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [clearDraftBusy, setClearDraftBusy] = useState(false);
  const [messageFeedbackBusy, setMessageFeedbackBusy] = useState<Record<string, boolean>>({});
  const [closeReason, setCloseReason] = useState("");
  const [soldById, setSoldById] = useState("");
  const [listActionsOpenId, setListActionsOpenId] = useState<string | null>(null);
  const [todoInlineOpenId, setTodoInlineOpenId] = useState<string | null>(null);
  const [todoInlineText, setTodoInlineText] = useState("");
  const [todoInlineTarget, setTodoInlineTarget] = useState<string>("lead_owner");
  const [reminderInlineOpenId, setReminderInlineOpenId] = useState<string | null>(null);
  const [reminderInlineText, setReminderInlineText] = useState("");
  const [reminderInlineTarget, setReminderInlineTarget] = useState<string>("lead_owner");
  const [reminderInlineDueAt, setReminderInlineDueAt] = useState("");
  const [reminderInlineLeadMinutes, setReminderInlineLeadMinutes] = useState("30");
  const [reminderInlineSaving, setReminderInlineSaving] = useState(false);
  const [contactInlineOpenId, setContactInlineOpenId] = useState<string | null>(null);
  const [contactInlineSaving, setContactInlineSaving] = useState(false);
  const [contactInlineForm, setContactInlineForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: ""
  });
  const [reassignInlineOpenId, setReassignInlineOpenId] = useState<string | null>(null);
  const [reassignInlineTarget, setReassignInlineTarget] = useState<string>("department:service");
  const [reassignInlineSummary, setReassignInlineSummary] = useState("");
  const [reassignInlineSaving, setReassignInlineSaving] = useState(false);
  const sendBoxRef = useRef<HTMLTextAreaElement | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const lastStreamRefreshRef = useRef(0);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const loadConversationRef = useRef<(id: string) => Promise<void>>(async () => {});
  const selectedIdRef = useRef<string | null>(null);
  const refreshConversationsRef = useRef<() => Promise<void>>(async () => {});
  const refreshSelectedRef = useRef<(id: string) => Promise<void>>(async () => {});
  const lastConversationsSigRef = useRef<string>("");
  const lastSelectedSigRef = useRef<string>("");
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"dealer" | "scheduler" | "users" | "notifications">("dealer");
  const [authUser, setAuthUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [loginForm, setLoginForm] = useState({ email: "", password: "", name: "" });
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);
  const [usersList, setUsersList] = useState<any[]>([]);
  const [userForm, setUserForm] = useState({
    email: "",
    password: "",
    name: "",
    firstName: "",
    lastName: "",
    emailSignature: "",
    phone: "",
    extension: "",
    role: "salesperson",
    includeInSchedule: false,
    calendarId: "",
    permissions: {
      canEditAppointments: false,
      canToggleHumanOverride: false,
      canAccessTodos: false,
      canAccessSuppressions: false
    }
  });
  const [userPasswords, setUserPasswords] = useState<Record<string, string>>({});
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [showNewUserForm, setShowNewUserForm] = useState(false);
  const [dealerProfile, setDealerProfile] = useState<any>(null);
  const [dealerProfileForm, setDealerProfileForm] = useState({
    dealerName: "",
    agentName: "",
    crmProvider: "",
    websiteProvider: "",
    fromEmail: "",
    replyToEmail: "",
    emailSignature: "",
    logoUrl: "",
    bookingUrl: "",
    bookingToken: "",
    creditAppUrl: "",
    lienHolderResponse: "",
    riderToRiderFinancingEnabled: false,
    phone: "",
    website: "",
    addressLine1: "",
    city: "",
    state: "",
    zip: "",
    testRideEnabled: true,
    testRideMonths: [4, 5, 6, 7, 8, 9, 10],
    weatherPickupRadiusMiles: "25",
    weatherColdThresholdF: "50",
    weatherForecastHours: "48",
    buyingUsedBikesEnabled: true,
    webSearchReferenceUrls: [] as string[],
    webSearchUseGooglePlacePhotos: false,
    webSearchGooglePlaceId: "",
    campaignWebBannerWidth: "",
    campaignWebBannerHeight: "",
    campaignWebBannerInsetPercent: "",
    campaignWebBannerFit: "auto" as "auto" | "cover" | "contain",
    taxRate: "8"
  });
  const [selectedReferenceSite, setSelectedReferenceSite] = useState("");
  const [dealerHours, setDealerHours] = useState<Record<string, { open: string | null; close: string | null }>>(
    {}
  );
  const [schedulerConfig, setSchedulerConfig] = useState<any>(null);
  const [messageFilter, setMessageFilter] = useState<"sms" | "email" | "calls">("sms");
  const [expandedCallSummaries, setExpandedCallSummaries] = useState<Record<string, boolean>>({});
  const [schedulerForm, setSchedulerForm] = useState({
    timezone: "America/New_York",
    assignmentMode: "preferred",
    minLeadTimeHours: "4",
    minGapBetweenAppointmentsMinutes: "60",
    weekdayEarliest: "09:30",
    weekdayLatest: "17:00",
    saturdayEarliest: "09:30",
    saturdayLatest: "14:00"
  });
  const [schedulerHours, setSchedulerHours] = useState<
    Record<string, { open: string | null; close: string | null }>
  >({});
  const [availabilityBlocks, setAvailabilityBlocks] = useState<Record<string, any[]>>({});
  const [salespeopleList, setSalespeopleList] = useState<
    Array<{ id: string; name: string; calendarId: string }>
  >([]);
  const [preferredOrderIds, setPreferredOrderIds] = useState<string[]>([]);
  const [appointmentTypesList, setAppointmentTypesList] = useState<
    Array<{ key: string; durationMinutes: string; colorId?: string }>
  >([{ key: "inventory_visit", durationMinutes: "60", colorId: "" }]);
  const [appointmentTypeToAdd, setAppointmentTypeToAdd] = useState("inventory_visit");
  const [manualApptOpen, setManualApptOpen] = useState(false);
  const [manualApptSaving, setManualApptSaving] = useState(false);
  const [manualApptError, setManualApptError] = useState<string | null>(null);
  const [manualApptForm, setManualApptForm] = useState({
    date: "",
    time: "",
    appointmentType: "inventory_visit",
    salespersonId: "",
    notes: ""
  });
  const [newSalespersonName, setNewSalespersonName] = useState("");
  const [creatingCalendar, setCreatingCalendar] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [calendarView, setCalendarView] = useState<"day" | "week">("day");
  const [calendarDate, setCalendarDate] = useState<Date>(new Date());
  const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarSalespeople, setCalendarSalespeople] = useState<string[]>([]);
  const [calendarFilterOpen, setCalendarFilterOpen] = useState(false);
  const [calendarEdit, setCalendarEdit] = useState<any | null>(null);
  const [calendarRowHeight, setCalendarRowHeight] = useState(40);
  const [calendarNowMs, setCalendarNowMs] = useState(() => Date.now());
  const [googleStatus, setGoogleStatus] = useState<{ connected: boolean; reason?: string; error?: string } | null>(null);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [inventoryNotes, setInventoryNotes] = useState<Record<string, any[]>>({});
  const [inventorySaving, setInventorySaving] = useState<string | null>(null);
  const [inventoryExpandedNote, setInventoryExpandedNote] = useState<string | null>(null);
  const inventoryNoteSuggestions = useMemo(() => {
    const labels = new Set<string>();
    const notes = new Set<string>();
    Object.values(inventoryNotes).forEach(list => {
      (list ?? []).forEach((n: any) => {
        const l = String(n?.label ?? "").trim();
        const t = String(n?.note ?? "").trim();
        if (l) labels.add(l);
        if (t) notes.add(t);
      });
    });
    return {
      labels: Array.from(labels).slice(0, 50),
      notes: Array.from(notes).slice(0, 50)
    };
  }, [inventoryNotes]);
  const [calendarEditForm, setCalendarEditForm] = useState({
    summary: "",
    startDate: "",
    startTime: "",
    endDate: "",
    endTime: "",
    status: "scheduled",
    reason: "",
    colorId: ""
  });
  const [calendarEditSalespersonId, setCalendarEditSalespersonId] = useState("");
  const [todoResolveOpen, setTodoResolveOpen] = useState(false);
  const [todoResolveTarget, setTodoResolveTarget] = useState<TodoItem | null>(null);
  const [todoResolution, setTodoResolution] = useState("resume");
  const [appointmentCloseOpen, setAppointmentCloseOpen] = useState(false);
  const [appointmentCloseTarget, setAppointmentCloseTarget] = useState<TodoItem | null>(null);
  const [appointmentClosePrimaryOutcome, setAppointmentClosePrimaryOutcome] = useState<
    "showed" | "did_not_show" | "cancelled"
  >("showed");
  const [appointmentCloseSecondaryOutcome, setAppointmentCloseSecondaryOutcome] = useState("needs_follow_up");
  const [appointmentCloseNote, setAppointmentCloseNote] = useState("");
  const [appointmentCloseSaving, setAppointmentCloseSaving] = useState(false);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  const [callMethod, setCallMethod] = useState<"cell" | "extension">("cell");
  const [callPickerOpen, setCallPickerOpen] = useState(false);
  const [pendingDeepLinkCallId, setPendingDeepLinkCallId] = useState<string | null>(null);
  const groupCsvInputRef = useRef<HTMLInputElement | null>(null);
  const calendarColumnRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const calendarEventsRef = useRef<any[]>([]);
  const calendarGridRef = useRef<HTMLDivElement | null>(null);
  const deepLinkCallInFlightRef = useRef(false);
  const dragGuardRef = useRef<{ blockUntil: number }>({ blockUntil: 0 });
  const dragStateRef = useRef<{
    mode: "move" | "resize" | null;
    event: any | null;
    startY: number;
    origStartMin: number;
    origEndMin: number;
    openWindow: number;
    closeWindow: number;
    didMove?: boolean;
  }>({ mode: null, event: null, startY: 0, origStartMin: 0, origEndMin: 0, openWindow: 0, closeWindow: 0 });
  const [blockForm, setBlockForm] = useState({
    salespersonId: "",
    title: "",
    days: ["monday"],
    start: "12:00",
    end: "13:00",
    allDay: false
  });

  const kpiOwnerOptions = useMemo(
    () =>
      (usersList ?? [])
        .filter((u: any) => {
          const role = String(u?.role ?? "").toLowerCase();
          return role === "manager" || role === "salesperson";
        })
        .map((u: any) => ({
          id: String(u?.id ?? "").trim(),
          name:
            [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() ||
            String(u?.name ?? "").trim() ||
            String(u?.email ?? "").trim() ||
            String(u?.id ?? "").trim()
        }))
        .filter((u: any) => u.id)
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
    [usersList]
  );

  const kpiCallOwnerOptions = useMemo(() => {
    const byId = new Map<string, string>();
    (kpiOverview?.callDetails ?? []).forEach(row => {
      const id = String(row.ownerId ?? "").trim();
      if (!id) return;
      const name = String(row.ownerName ?? "").trim() || id;
      if (!byId.has(id)) byId.set(id, name);
    });
    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [kpiOverview?.callDetails]);

  const kpiVisibleCallDetails = useMemo(() => {
    const ownerFilter = String(kpiCallOwnerFilter ?? "all").trim();
    const rows = kpiOverview?.callDetails ?? [];
    if (!ownerFilter || ownerFilter === "all") return rows;
    return rows.filter(row => String(row.ownerId ?? "").trim() === ownerFilter);
  }, [kpiOverview?.callDetails, kpiCallOwnerFilter]);

  function dateInputOffset(daysAgo: number): string {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }

  useEffect(() => {
    if (!kpiFrom) setKpiFrom(dateInputOffset(30));
    if (!kpiTo) setKpiTo(dateInputOffset(0));
  }, [kpiFrom, kpiTo]);

  useEffect(() => {
    if (!kpiCallOwnerOptions.some(o => o.id === kpiCallOwnerFilter)) {
      if (kpiCallOwnerFilter !== "all") setKpiCallOwnerFilter("all");
    }
  }, [kpiCallOwnerFilter, kpiCallOwnerOptions]);

  useEffect(() => {
    if (!campaignSelectedTargetsOrdered.length) {
      if (campaignTargetToGenerate !== "sms") setCampaignTargetToGenerate("sms");
      return;
    }
    if (!campaignSelectedTargetsOrdered.includes(campaignTargetToGenerate)) {
      const next = campaignNextPendingTarget ?? campaignSelectedTargetsOrdered[0];
      if (next && next !== campaignTargetToGenerate) setCampaignTargetToGenerate(next);
    }
  }, [campaignNextPendingTarget, campaignSelectedTargetsOrdered, campaignTargetToGenerate]);

  async function loadKpiOverview() {
    if (!isManager) return;
    setKpiLoading(true);
    setKpiError(null);
    try {
      const params = new URLSearchParams();
      params.set("source", kpiSourceFilter || "all");
      params.set("ownerId", kpiOwnerFilter || "all");
      params.set("leadType", kpiLeadTypeFilter || "all");
      params.set("leadScope", kpiLeadScopeFilter || "online_only");
      if (kpiFrom) params.set("from", `${kpiFrom}T00:00:00.000Z`);
      if (kpiTo) params.set("to", `${kpiTo}T23:59:59.999Z`);
      const resp = await fetch(`/api/analytics/kpi?${params.toString()}`, { cache: "no-store" });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.overview) {
        throw new Error(data?.error ?? "Failed to load KPI overview");
      }
      setKpiOverview(data.overview as KpiOverview);
    } catch (err: any) {
      setKpiError(err?.message ?? "Failed to load KPI overview");
    } finally {
      setKpiLoading(false);
    }
  }

  function applyCampaignToForm(entry: CampaignEntry | null) {
    const validTags = new Set<CampaignTag>(CAMPAIGN_TAG_OPTIONS.map(opt => opt.value));
    const validTargets = new Set<CampaignAssetTarget>(CAMPAIGN_ASSET_TARGET_OPTIONS.map(opt => opt.value));
    if (!entry) {
      setCampaignForm({ ...EMPTY_CAMPAIGN_FORM });
      setCampaignSourceHits([]);
      setCampaignGeneratedBy("");
      setCampaignGeneratedAt("");
      setCampaignFinalImageUrl("");
      setCampaignGeneratedAssets([]);
      return;
    }
    const buildMode: CampaignBuildMode =
      entry.buildMode === "web_search_design" || (entry.buildMode as any) === "promotion_event_prompt"
        ? "web_search_design"
        : "design_from_scratch";
    const channel: CampaignChannel =
      entry.channel === "sms" || entry.channel === "email" || entry.channel === "both"
        ? entry.channel
        : "both";
    const tags: CampaignTag[] = Array.isArray(entry.tags)
      ? (entry.tags
          .filter(tag => validTags.has(tag as CampaignTag))
          .map(tag => tag as CampaignTag) as CampaignTag[])
      : [];
    const assetTargets: CampaignAssetTarget[] = Array.isArray(entry.assetTargets)
      ? (entry.assetTargets
          .map(v => String(v ?? "").trim())
          .filter(v => validTargets.has(v as CampaignAssetTarget))
          .map(v => v as CampaignAssetTarget) as CampaignAssetTarget[])
      : [];
    // UI now enforces one output target at a time for a simpler workflow.
    const normalizedTargets = assetTargets.length ? [assetTargets[0]] : [];
    const generatedAssets: CampaignGeneratedAsset[] = Array.isArray(entry.generatedAssets)
      ? entry.generatedAssets
          .filter(asset => !!asset?.url && validTargets.has(String(asset?.target ?? "").trim() as CampaignAssetTarget))
          .map(asset => ({
            ...asset,
            target: String(asset?.target ?? "").trim() as CampaignAssetTarget,
            url: String(asset?.url ?? "").trim()
          }))
      : [];
    setCampaignForm({
      name: String(entry.name ?? "").trim(),
      buildMode,
      channel,
      tags,
      assetTargets: normalizedTargets,
      prompt: String(entry.prompt ?? ""),
      description: String(entry.description ?? ""),
      inspirationImageUrlsText: campaignUrlsToText(entry.inspirationImageUrls),
      assetImageUrlsText: campaignUrlsToText(entry.assetImageUrls),
      briefDocumentUrlsText: campaignUrlsToText(entry.briefDocumentUrls),
      smsBody: String(entry.smsBody ?? ""),
      emailSubject: String(entry.emailSubject ?? ""),
      emailBodyText: String(entry.emailBodyText ?? ""),
      emailBodyHtml: String(entry.emailBodyHtml ?? "")
    });
    setCampaignSourceHits(Array.isArray(entry.sourceHits) ? entry.sourceHits : []);
    setCampaignGeneratedBy(String(entry.generatedBy ?? ""));
    setCampaignGeneratedAt(String(entry.updatedAt ?? entry.createdAt ?? ""));
    setCampaignGeneratedAssets(generatedAssets);
    setCampaignFinalImageUrl(String(entry.finalImageUrl ?? "").trim() || generatedAssets[0]?.url || "");
  }

  function resetCampaignDraft() {
    setCampaignSelectedId("");
    applyCampaignToForm(null);
    setCampaignError(null);
  }

  async function uploadCampaignFiles(
    files: FileList | null,
    endpoint: string,
    opts?: {
      channel?: CampaignChannel;
      profile?:
        | "sms"
        | "email"
        | "facebook_post"
        | "instagram_post"
        | "instagram_story"
        | "web_banner"
        | "flyer_8_5x11";
    }
  ): Promise<string[]> {
    if (!files || files.length === 0) return [];
    const urlsToAppend: string[] = [];
    const params = new URLSearchParams();
    if (opts?.profile) params.set("profile", opts.profile);
    else if (opts?.channel) params.set("channel", opts.channel);
    const requestEndpoint = params.toString() ? `${endpoint}?${params.toString()}` : endpoint;
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch(requestEndpoint, {
        method: "POST",
        body: fd
      });
      const payload = await resp.json().catch(() => null);
      if (!resp.ok || !payload?.url) {
        window.alert(payload?.error ?? `Failed to upload "${file.name}".`);
        continue;
      }
      urlsToAppend.push(String(payload.url));
    }
    return urlsToAppend;
  }

  async function handleCampaignInspirationUploads(files: FileList | null) {
    if (!files || files.length === 0) return;
    setCampaignInspirationUploadBusy(true);
    setCampaignError(null);
    try {
      for (const file of Array.from(files)) {
        if (!String(file.type ?? "").startsWith("image/")) {
          window.alert(`"${file.name}" must be an image file.`);
          return;
        }
      }
      const urlsToAppend = await uploadCampaignFiles(files, "/api/campaigns/media", {
        channel: campaignEffectiveChannel
      });
      if (!urlsToAppend.length) return;
      setCampaignForm(prev => {
        const existing = parseCampaignUrlsText(prev.inspirationImageUrlsText);
        const next = Array.from(new Set([...existing, ...urlsToAppend]));
        return { ...prev, inspirationImageUrlsText: next.join("\n") };
      });
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to upload inspiration image");
    } finally {
      setCampaignInspirationUploadBusy(false);
    }
  }

  async function handleCampaignAssetUploads(files: FileList | null) {
    if (!files || files.length === 0) return;
    setCampaignAssetUploadBusy(true);
    setCampaignError(null);
    try {
      for (const file of Array.from(files)) {
        if (!String(file.type ?? "").startsWith("image/")) {
          window.alert(`"${file.name}" must be an image file.`);
          return;
        }
      }
      const urlsToAppend = await uploadCampaignFiles(files, "/api/campaigns/media", {
        channel: campaignEffectiveChannel
      });
      if (!urlsToAppend.length) return;
      setCampaignForm(prev => {
        const existing = parseCampaignUrlsText(prev.assetImageUrlsText);
        const next = Array.from(new Set([...existing, ...urlsToAppend]));
        return { ...prev, assetImageUrlsText: next.join("\n") };
      });
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to upload asset image");
    } finally {
      setCampaignAssetUploadBusy(false);
    }
  }

  async function handleCampaignBriefUploads(files: FileList | null) {
    if (!files || files.length === 0) return;
    setCampaignBriefUploadBusy(true);
    setCampaignError(null);
    try {
      const urlsToAppend = await uploadCampaignFiles(files, "/api/campaigns/briefs");
      if (!urlsToAppend.length) return;
      setCampaignForm(prev => {
        const existing = parseCampaignUrlsText(prev.briefDocumentUrlsText);
        const next = Array.from(new Set([...existing, ...urlsToAppend]));
        return { ...prev, briefDocumentUrlsText: next.join("\n") };
      });
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to upload brief file");
    } finally {
      setCampaignBriefUploadBusy(false);
    }
  }

  function removeCampaignUrlFromField(field: CampaignUrlTextField, urlToRemove: string) {
    const needle = String(urlToRemove ?? "").trim();
    if (!needle) return;
    setCampaignForm(prev => {
      const existing = parseCampaignUrlsText(prev[field]);
      const next = existing.filter(url => url !== needle);
      return { ...prev, [field]: next.join("\n") };
    });
  }

  async function handleCampaignDropZoneFiles(zone: CampaignUploadDropZone, files: FileList | null) {
    if (!files || files.length === 0) return;
    if (zone === "briefs") {
      await handleCampaignBriefUploads(files);
      return;
    }
    if (campaignForm.buildMode !== "design_from_scratch") return;
    if (zone === "refs") {
      await handleCampaignInspirationUploads(files);
      return;
    }
    await handleCampaignAssetUploads(files);
  }

  async function loadMetaStatus() {
    if (!isManager) return;
    setMetaLoading(true);
    setMetaError(null);
    try {
      const resp = await fetch("/api/meta/status", { cache: "no-store" });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error ?? "Failed to load Meta status");
      }
      setMetaStatus({
        connected: data.connected === true,
        connectedAt: data.connectedAt,
        updatedAt: data.updatedAt,
        pageId: data.pageId,
        pageName: data.pageName,
        hasInstagram: data.hasInstagram,
        instagramBusinessAccountId: data.instagramBusinessAccountId,
        instagramBusinessAccountUsername: data.instagramBusinessAccountUsername,
        availablePages: Array.isArray(data.availablePages) ? data.availablePages : []
      });
    } catch (err: any) {
      setMetaStatus(null);
      setMetaError(err?.message ?? "Failed to load Meta status");
    } finally {
      setMetaLoading(false);
    }
  }

  async function startMetaConnect() {
    if (!isManager) return;
    setMetaActionBusy(true);
    setMetaError(null);
    try {
      const resp = await fetch("/api/meta/start", { cache: "no-store" });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.url) {
        throw new Error(data?.error ?? "Failed to start Meta connect");
      }
      const targetUrl = String(data.url ?? "").trim();
      if (!targetUrl) throw new Error("Meta connect URL missing");
      const popup = window.open(targetUrl, "_blank", "noopener,noreferrer");
      if (!popup) {
        window.location.href = targetUrl;
      } else {
        setSaveToast("Complete Meta login in the new tab, then click Refresh Meta.");
      }
    } catch (err: any) {
      setMetaError(err?.message ?? "Failed to start Meta connect");
    } finally {
      setMetaActionBusy(false);
    }
  }

  async function disconnectMeta() {
    if (!isManager) return;
    setMetaActionBusy(true);
    setMetaError(null);
    try {
      const resp = await fetch("/api/meta/disconnect", {
        method: "POST"
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error ?? "Failed to disconnect Meta");
      }
      setMetaStatus({ connected: false });
      setSaveToast("Meta disconnected");
    } catch (err: any) {
      setMetaError(err?.message ?? "Failed to disconnect Meta");
    } finally {
      setMetaActionBusy(false);
    }
  }

  function openCampaignFromQueue(entry: CampaignEntry, queue: CampaignQueueKind, opts?: { toast?: boolean }) {
    goToSection("campaigns");
    setCampaignListFilter(queue);
    setCampaignSelectedId(entry.id);
    applyCampaignToForm(entry);
    if (opts?.toast !== false) {
      setSaveToast(queue === "send" ? "Viewing Send Queue" : "Viewing Post Queue");
    }
  }

  function openPostQueuePublishDialog(entry: CampaignEntry, target?: CampaignAssetTarget) {
    goToSection("campaigns");
    setCampaignListFilter("all");
    setCampaignSelectedId(entry.id);
    applyCampaignToForm(entry);
    const metaMap = campaignNormalizeSocialPublishOptionsMap((entry.metadata as any)?.socialPublishOptions);
    const autoCaption = campaignAutoPublishCaption(entry);
    const captions: Partial<Record<CampaignAssetTarget, string>> = {};
    const optionsByTarget: Partial<Record<CampaignAssetTarget, CampaignSocialPublishOptions>> = {};
    for (const queuedTarget of campaignQueuedAssetTargetsForQueue(entry, "post")) {
      captions[queuedTarget] = autoCaption;
      optionsByTarget[queuedTarget] = metaMap[queuedTarget] ?? {};
    }
    setCampaignQueuePublishCaptionByTarget(captions);
    setCampaignQueuePublishOptionsByTarget(optionsByTarget);
    setCampaignQueuePublishDialogTarget(target ?? "");
    setCampaignQueuePublishDialogCampaignId(entry.id);
    void loadMetaStatus();
  }

  function openSendQueueSendDialog(entry: CampaignEntry, target?: CampaignAssetTarget) {
    openCampaignFromQueue(entry, "send", { toast: false });
    setCampaignQueueSendDialogTarget(target ?? "");
    setCampaignQueueSendDialogCampaignId(entry.id);
    setCampaignQueueSendDialogListId(selectedContactListId || "all");
  }

  function closeSendQueueSendDialog() {
    setCampaignQueueSendDialogCampaignId("");
    setCampaignQueueSendDialogTarget("");
    setCampaignQueueSendDialogListId("all");
    setCampaignQueueActionBusyKey("");
  }

  function closePostQueuePublishDialog() {
    setCampaignQueuePublishDialogCampaignId("");
    setCampaignQueuePublishDialogTarget("");
    setCampaignQueuePublishCaptionByTarget({});
    setCampaignQueuePublishOptionsByTarget({});
    setCampaignQueueActionBusyKey("");
  }

  async function sendQueuedCampaignAssetNow(entry: CampaignEntry, target: CampaignAssetTarget) {
    const campaignId = String(entry.id ?? "").trim();
    if (!campaignId) return;
    const busyKey = `send:${campaignId}:${target}`;
    setCampaignQueueActionBusyKey(busyKey);
    setCampaignError(null);
    try {
      const sendTargets = campaignQueuedAssetTargetsForQueue(entry, "send");
      if (!sendTargets.includes(target)) {
        throw new Error("This send asset is no longer queued.");
      }
      const listIdRaw = String(campaignQueueSendDialogListId ?? "").trim();
      const sendToAll = listIdRaw === "all";
      const listId = !sendToAll ? listIdRaw : "";
      if (!sendToAll && !listId) {
        throw new Error("Select a recipient group or choose All contacts.");
      }
      const message = String(entry.smsBody ?? "").trim();
      const emailSubject = String(entry.emailSubject ?? "").trim();
      const emailBodyText = String(entry.emailBodyText ?? "").trim();
      const emailBodyHtml = String(entry.emailBodyHtml ?? "").trim();
      if (target === "sms" && !message) throw new Error("This campaign has no SMS draft to send.");
      if (target === "email" && !emailBodyText && !emailBodyHtml) {
        throw new Error("This campaign has no email draft to send.");
      }
      if (target === "email" && !emailSubject) {
        throw new Error("This campaign email has no subject.");
      }
      const resp = await fetch("/api/contacts/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: target === "email" ? "email" : "sms",
          ...(sendToAll ? { sendToAll: true } : { listId }),
          ...(target === "email"
            ? {
                subject: emailSubject,
                emailBodyText: emailBodyText || undefined,
                emailBodyHtml: emailBodyHtml || undefined
              }
            : { message }),
          campaignId,
          campaignName: String(entry.name ?? "").trim() || undefined
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error ?? "Failed to send campaign");
      }
      const dequeueResp = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          queue: "send",
          action: "dequeue"
        })
      });
      const dequeueData = await dequeueResp.json().catch(() => null);
      if (dequeueResp.ok && dequeueData?.ok && dequeueData?.campaign) {
        const saved = dequeueData.campaign as CampaignEntry;
        setCampaigns(prev => {
          const idx = prev.findIndex(row => row.id === saved.id);
          const next = idx >= 0 ? prev.map(row => (row.id === saved.id ? saved : row)) : [saved, ...prev];
          return next.sort((a, b) => {
            const aAt = new Date(String(a.updatedAt ?? a.createdAt ?? "")).getTime();
            const bAt = new Date(String(b.updatedAt ?? b.createdAt ?? "")).getTime();
            return bAt - aAt;
          });
        });
        if (campaignSelectedId === saved.id) applyCampaignToForm(saved);
        if (!campaignIsQueued(saved, "send")) {
          closeSendQueueSendDialog();
        }
      } else {
        await loadCampaigns(campaignId);
      }
      const label = target === "email" ? "Email sent" : "SMS sent";
      setSaveToast(`${label}: ${data.sent ?? 0}/${data.attempted ?? 0} from "${entry.name || "campaign"}"`);
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to send queued campaign");
    } finally {
      setCampaignQueueActionBusyKey("");
    }
  }

  async function publishQueuedCampaignAssetNow(
    entry: CampaignEntry,
    target: CampaignAssetTarget,
    platform: "facebook" | "instagram" | "instagram_story"
  ) {
    const campaignId = String(entry.id ?? "").trim();
    if (!campaignId) return;
    const busyKey = `post:${campaignId}:${target}:${platform}`;
    setCampaignQueueActionBusyKey(busyKey);
    setCampaignError(null);
    setMetaError(null);
    try {
      const postTargets = campaignQueuedAssetTargetsForQueue(entry, "post");
      if (!postTargets.includes(target)) {
        throw new Error("This asset is no longer queued for post.");
      }
      const endpoint =
        platform === "facebook"
          ? `/api/campaigns/${encodeURIComponent(campaignId)}/publish/facebook`
          : `/api/campaigns/${encodeURIComponent(campaignId)}/publish/instagram`;
      const body: Record<string, unknown> = {};
      body.assetTarget = target;
      if (platform === "instagram_story") body.mediaType = "story";
      const socialOptions = campaignNormalizeSocialPublishOptions(campaignQueuePublishOptionsByTarget[target]);
      const manualCaption = String(campaignQueuePublishCaptionByTarget[target] ?? "").trim();
      const autoCaption = campaignAutoPublishCaption(entry);
      const captionToUse = campaignComposePublishCaption(manualCaption || autoCaption, socialOptions);
      if (captionToUse && platform !== "instagram_story") body.caption = captionToUse;
      if (socialOptions.linkUrl) body.linkUrl = socialOptions.linkUrl;
      if (socialOptions.mentionHandles) body.mentionHandles = socialOptions.mentionHandles;
      if (socialOptions.locationName) body.locationName = socialOptions.locationName;
      if (socialOptions.gifUrl) body.gifUrl = socialOptions.gifUrl;
      if (socialOptions.musicCue) body.musicCue = socialOptions.musicCue;
      if (socialOptions.stickerText) body.stickerText = socialOptions.stickerText;
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error ?? "Failed to publish campaign");
      }
      const dequeueResp = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          queue: "post",
          action: "dequeue"
        })
      });
      const dequeueData = await dequeueResp.json().catch(() => null);
      if (dequeueResp.ok && dequeueData?.ok && dequeueData?.campaign) {
        const saved = dequeueData.campaign as CampaignEntry;
        setCampaigns(prev => {
          const idx = prev.findIndex(row => row.id === saved.id);
          const next = idx >= 0 ? prev.map(row => (row.id === saved.id ? saved : row)) : [saved, ...prev];
          return next.sort((a, b) => {
            const aAt = new Date(String(a.updatedAt ?? a.createdAt ?? "")).getTime();
            const bAt = new Date(String(b.updatedAt ?? b.createdAt ?? "")).getTime();
            return bAt - aAt;
          });
        });
        if (campaignSelectedId === saved.id) applyCampaignToForm(saved);
        if (!campaignIsQueued(saved, "post")) {
          closePostQueuePublishDialog();
        }
      } else {
        await loadCampaigns(campaignId);
      }
      setCampaignQueuePublishCaptionByTarget(prev => {
        const next = { ...prev };
        delete next[target];
        return next;
      });
      const label =
        platform === "facebook"
          ? "Published to Facebook"
          : platform === "instagram_story"
            ? "Published to Instagram Story"
            : "Published to Instagram";
      setSaveToast(`${label}: ${entry.name || "campaign"} (${campaignAssetDisplayLabel({ target, url: "" })})`);
      await loadMetaStatus();
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to publish queued campaign");
    } finally {
      setCampaignQueueActionBusyKey("");
    }
  }

  async function loadCampaigns(preferredId?: string) {
    if (!isManager) return;
    setCampaignLoading(true);
    setCampaignError(null);
    try {
      const resp = await fetch("/api/campaigns", { cache: "no-store" });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error ?? "Failed to load campaigns");
      }
      const rows = Array.isArray(data?.campaigns) ? (data.campaigns as CampaignEntry[]) : [];
      setCampaigns(rows);
      if (!rows.length) {
        resetCampaignDraft();
        return;
      }
      const targetId = String(preferredId ?? campaignSelectedId ?? "").trim();
      const selected = rows.find(row => row.id === targetId) ?? rows[0];
      setCampaignSelectedId(selected.id);
      applyCampaignToForm(selected);
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to load campaigns");
    } finally {
      setCampaignLoading(false);
    }
  }

  async function saveCampaignDraft() {
    const name = String(campaignForm.name ?? "").trim();
    if (!name) {
      setCampaignError("Campaign name is required.");
      return;
    }
    const isScratchBuild = campaignForm.buildMode === "design_from_scratch";
    setCampaignSaving(true);
    setCampaignError(null);
    try {
      const payload = {
        name,
        status: "draft",
        buildMode: campaignForm.buildMode,
        channel: campaignEffectiveChannel,
        tags: campaignForm.tags,
        assetTargets: campaignForm.assetTargets,
        prompt: String(campaignForm.prompt ?? "").trim() || undefined,
        description: String(campaignForm.description ?? "").trim() || undefined,
        inspirationImageUrls: isScratchBuild ? parseCampaignUrlsText(campaignForm.inspirationImageUrlsText) : [],
        assetImageUrls: isScratchBuild ? parseCampaignUrlsText(campaignForm.assetImageUrlsText) : [],
        briefDocumentUrls: parseCampaignUrlsText(campaignForm.briefDocumentUrlsText),
        smsBody: String(campaignForm.smsBody ?? "").trim() || undefined,
        emailSubject: String(campaignForm.emailSubject ?? "").trim() || undefined,
        emailBodyText: String(campaignForm.emailBodyText ?? "").trim() || undefined,
        emailBodyHtml: String(campaignForm.emailBodyHtml ?? "").trim() || undefined
      };
      const endpoint = campaignSelectedId
        ? `/api/campaigns/${encodeURIComponent(campaignSelectedId)}`
        : "/api/campaigns";
      const method = campaignSelectedId ? "PATCH" : "POST";
      const resp = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.campaign) {
        throw new Error(data?.error ?? "Failed to save campaign");
      }
      const saved = data.campaign as CampaignEntry;
      setCampaignSelectedId(saved.id);
      applyCampaignToForm(saved);
      setCampaigns(prev => {
        const idx = prev.findIndex(row => row.id === saved.id);
        const next = idx >= 0 ? prev.map(row => (row.id === saved.id ? saved : row)) : [saved, ...prev];
        return next.sort((a, b) => {
          const aAt = new Date(String(a.updatedAt ?? a.createdAt ?? "")).getTime();
          const bAt = new Date(String(b.updatedAt ?? b.createdAt ?? "")).getTime();
          return bAt - aAt;
        });
      });
      setSaveToast("Campaign saved");
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to save campaign");
    } finally {
      setCampaignSaving(false);
    }
  }

  function openQueuedCampaign(queue: CampaignQueueKind) {
    goToSection("campaigns");
    setCampaignListFilter(queue);
    const list = queue === "send" ? campaignSendQueue : campaignPostQueue;
    const first = list[0];
    if (!first) {
      setSaveToast(queue === "send" ? "Send Queue is empty" : "Post Queue is empty");
      return;
    }
    openCampaignFromQueue(first, queue);
  }

  async function deleteCampaignById(id: string) {
    const target = campaigns.find(row => row.id === id) ?? null;
    const displayName = String(target?.name ?? "this campaign").trim() || "this campaign";
    const okToDelete = window.confirm(`Delete "${displayName}"? This cannot be undone.`);
    if (!okToDelete) return;
    setCampaignDeletingId(id);
    setCampaignError(null);
    try {
      const resp = await fetch(`/api/campaigns/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error ?? "Failed to delete campaign");
      }
      if (campaignSelectedId === id) {
        setCampaignSelectedId("");
      }
      await loadCampaigns();
      setSaveToast("Campaign deleted");
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to delete campaign");
    } finally {
      setCampaignDeletingId("");
    }
  }

  async function setCampaignAssetQueue(
    target: CampaignAssetTarget,
    shouldQueue: boolean
  ): Promise<CampaignEntry | null> {
    const id = String(campaignSelectedId ?? "").trim();
    if (!id) {
      setCampaignError("Save the campaign first, then queue generated files.");
      return null;
    }
    const queue = campaignQueueKindForAssetTarget(target);
    if (!queue) {
      setCampaignError("This output type is download-only and cannot be queued.");
      return null;
    }
    setCampaignAssetQueueBusyTarget(target);
    setCampaignError(null);
    try {
      const resp = await fetch(`/api/campaigns/${encodeURIComponent(id)}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          queue,
          action: shouldQueue ? "queue" : "dequeue"
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.campaign) {
        throw new Error(data?.error ?? "Failed to update generated file queue");
      }
      const saved = data.campaign as CampaignEntry;
      setCampaigns(prev => {
        const idx = prev.findIndex(row => row.id === saved.id);
        const next = idx >= 0 ? prev.map(row => (row.id === saved.id ? saved : row)) : [saved, ...prev];
        return next.sort((a, b) => {
          const aAt = new Date(String(a.updatedAt ?? a.createdAt ?? "")).getTime();
          const bAt = new Date(String(b.updatedAt ?? b.createdAt ?? "")).getTime();
          return bAt - aAt;
        });
      });
      if (campaignSelectedId === saved.id) applyCampaignToForm(saved);
      const targetLabel =
        CAMPAIGN_ASSET_TARGET_OPTIONS.find(opt => opt.value === target)?.label ?? campaignAssetDisplayLabel({ target, url: "" });
      setSaveToast(
        shouldQueue
          ? queue === "send"
            ? `${targetLabel} queued for send`
            : `${targetLabel} queued for post`
          : `${targetLabel} removed from queue`
      );
      return saved;
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to update generated file queue");
      return null;
    } finally {
      setCampaignAssetQueueBusyTarget("");
    }
  }

  async function removeCampaignGeneratedAsset(asset: CampaignGeneratedAsset) {
    const campaignId = String(campaignSelectedId ?? "").trim();
    if (!campaignId) {
      setCampaignError("Save the campaign first, then remove generated files.");
      return;
    }
    const target = String(asset?.target ?? "").trim() as CampaignAssetTarget;
    const targetUrl = String(asset?.url ?? "").trim();
    if (!target || !targetUrl) {
      setCampaignError("Missing generated file target or URL.");
      return;
    }
    const label = campaignAssetDisplayLabel(asset);
    const okToRemove = window.confirm(`Remove "${label}" from this campaign? You can regenerate it anytime.`);
    if (!okToRemove) return;

    const busyKey = `remove:${campaignId}:${target}:${targetUrl}`;
    setCampaignRemovingAssetKey(busyKey);
    setCampaignError(null);
    try {
      let workingEntry = campaignSelectedEntry;
      if (!workingEntry || workingEntry.id !== campaignId) {
        workingEntry = campaigns.find(row => row.id === campaignId) ?? null;
      }
      if (!workingEntry) {
        throw new Error("Campaign not found.");
      }

      if (campaignAssetIsQueued(workingEntry, target)) {
        const saved = await setCampaignAssetQueue(target, false);
        if (saved) {
          workingEntry = saved;
        }
      }

      const existingAssets: CampaignGeneratedAsset[] = Array.isArray(workingEntry.generatedAssets)
        ? workingEntry.generatedAssets
            .filter(row => String(row?.url ?? "").trim())
            .map(row => ({
              ...row,
              target: String(row?.target ?? "").trim() as CampaignAssetTarget,
              url: String(row?.url ?? "").trim()
            }))
        : [];
      const nextAssets = existingAssets.filter(row => {
        const rowTarget = String(row?.target ?? "").trim();
        const rowUrl = String(row?.url ?? "").trim();
        if (rowTarget !== target) return true;
        return rowUrl !== targetUrl;
      });
      if (nextAssets.length === existingAssets.length) {
        throw new Error("Generated file was not found on this campaign.");
      }

      const preferredTargets = Array.isArray(workingEntry.assetTargets) && workingEntry.assetTargets.length
        ? workingEntry.assetTargets
        : CAMPAIGN_ASSET_TARGET_OPTIONS.map(opt => opt.value);
      const nextPreviewAsset =
        preferredTargets
          .map(preferred => nextAssets.find(row => String(row?.target ?? "").trim() === preferred))
          .find((row): row is CampaignGeneratedAsset => Boolean(row?.url)) ??
        nextAssets[0] ??
        null;
      const nextFinalImageUrl = String(nextPreviewAsset?.url ?? "").trim();

      const nextStatus = normalizeCampaignAssetGenerationMap(
        workingEntry.assetGenerationStatus ??
          ((workingEntry.metadata as any)?.assetGenerationStatus ?? {})
      );
      nextStatus[target] = {
        status: "pending",
        updatedAt: new Date().toISOString()
      };

      const resp = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generatedAssets: nextAssets,
          finalImageUrl: nextFinalImageUrl || "",
          assetGenerationStatus: nextStatus
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.campaign) {
        throw new Error(data?.error ?? "Failed to remove generated file");
      }
      const saved = data.campaign as CampaignEntry;
      setCampaigns(prev => {
        const idx = prev.findIndex(row => row.id === saved.id);
        const next = idx >= 0 ? prev.map(row => (row.id === saved.id ? saved : row)) : [saved, ...prev];
        return next.sort((a, b) => {
          const aAt = new Date(String(a.updatedAt ?? a.createdAt ?? "")).getTime();
          const bAt = new Date(String(b.updatedAt ?? b.createdAt ?? "")).getTime();
          return bAt - aAt;
        });
      });
      if (campaignSelectedId === saved.id) applyCampaignToForm(saved);
      setSaveToast(`${label} removed`);
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to remove generated file");
    } finally {
      setCampaignRemovingAssetKey("");
    }
  }

  async function removeCampaignFinalImagePreview() {
    const campaignId = String(campaignSelectedId ?? "").trim();
    const currentUrl = String(campaignFinalImageUrl ?? "").trim();
    if (!campaignId) {
      setCampaignError("Save the campaign first, then remove generated files.");
      return;
    }
    if (!currentUrl) return;
    const okToRemove = window.confirm("Remove this output preview from the campaign? You can regenerate it anytime.");
    if (!okToRemove) return;

    const busyKey = `remove:${campaignId}:final:${currentUrl}`;
    setCampaignRemovingAssetKey(busyKey);
    setCampaignError(null);
    try {
      const workingEntry =
        campaignSelectedEntry && campaignSelectedEntry.id === campaignId
          ? campaignSelectedEntry
          : campaigns.find(row => row.id === campaignId) ?? null;
      if (!workingEntry) {
        throw new Error("Campaign not found.");
      }

      const existingAssets: CampaignGeneratedAsset[] = Array.isArray(workingEntry.generatedAssets)
        ? workingEntry.generatedAssets
            .filter(row => String(row?.url ?? "").trim())
            .map(row => ({
              ...row,
              target: String(row?.target ?? "").trim() as CampaignAssetTarget,
              url: String(row?.url ?? "").trim()
            }))
        : [];
      const removedAsset = existingAssets.find(row => String(row.url ?? "").trim() === currentUrl) ?? null;
      const nextAssets = existingAssets.filter(row => String(row.url ?? "").trim() !== currentUrl);

      const preferredTargets = Array.isArray(workingEntry.assetTargets) && workingEntry.assetTargets.length
        ? workingEntry.assetTargets
        : CAMPAIGN_ASSET_TARGET_OPTIONS.map(opt => opt.value);
      const nextPreviewAsset =
        preferredTargets
          .map(preferred => nextAssets.find(row => String(row?.target ?? "").trim() === preferred))
          .find((row): row is CampaignGeneratedAsset => Boolean(row?.url)) ??
        nextAssets[0] ??
        null;
      const nextFinalImageUrl = String(nextPreviewAsset?.url ?? "").trim();

      const nextStatus = normalizeCampaignAssetGenerationMap(
        workingEntry.assetGenerationStatus ??
          ((workingEntry.metadata as any)?.assetGenerationStatus ?? {})
      );
      if (removedAsset?.target) {
        nextStatus[removedAsset.target] = {
          status: "pending",
          updatedAt: new Date().toISOString()
        };
      }

      const resp = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generatedAssets: nextAssets,
          finalImageUrl: nextFinalImageUrl || "",
          assetGenerationStatus: nextStatus
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.campaign) {
        throw new Error(data?.error ?? "Failed to remove output preview");
      }
      const saved = data.campaign as CampaignEntry;
      setCampaigns(prev => {
        const idx = prev.findIndex(row => row.id === saved.id);
        const next = idx >= 0 ? prev.map(row => (row.id === saved.id ? saved : row)) : [saved, ...prev];
        return next.sort((a, b) => {
          const aAt = new Date(String(a.updatedAt ?? a.createdAt ?? "")).getTime();
          const bAt = new Date(String(b.updatedAt ?? b.createdAt ?? "")).getTime();
          return bAt - aAt;
        });
      });
      if (campaignSelectedId === saved.id) applyCampaignToForm(saved);
      setSaveToast("Output removed");
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to remove output");
    } finally {
      setCampaignRemovingAssetKey("");
    }
  }

  async function downloadCampaignAsset(url: string, fallbackName?: string) {
    const source = String(url ?? "").trim();
    if (!source) {
      setCampaignError("Missing download URL.");
      return;
    }
    setCampaignError(null);
    try {
      const resp = await fetch(source, { method: "GET" });
      if (!resp.ok) {
        throw new Error(`Download failed (${resp.status})`);
      }
      const blob = await resp.blob();
      const blobBytes = Number(blob.size ?? 0);
      const blobDims = await readImageDimensionsFromBlob(blob);
      const parsed = (() => {
        try {
          return new URL(source, window.location.origin);
        } catch {
          return null;
        }
      })();
      const rawName = parsed
        ? decodeURIComponent(parsed.pathname.split("/").pop() || "")
        : "";
      const extFromType = (() => {
        const mime = String(blob.type ?? "").toLowerCase();
        if (mime === "image/jpeg") return ".jpg";
        if (mime === "image/png") return ".png";
        if (mime === "image/webp") return ".webp";
        if (mime === "image/gif") return ".gif";
        if (mime === "application/pdf") return ".pdf";
        return "";
      })();
      const cleanFallback =
        String(fallbackName ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "_")
          .replace(/^_+|_+$/g, "") || "campaign_asset";
      const baseName = rawName || (extFromType ? `${cleanFallback}${extFromType}` : cleanFallback);

      const blobUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = baseName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(blobUrl);
      const specText = blobDims ? `${blobDims.width}x${blobDims.height}` : "non-image";
      setSaveToast(`Downloaded ${baseName} (${specText}, ${formatFileSizeShort(blobBytes)})`);
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to download file.");
    }
  }

  async function printCampaignAsset(url: string, fallbackName?: string) {
    const source = String(url ?? "").trim();
    if (!source) {
      setCampaignError("Missing print URL.");
      return;
    }
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setCampaignError("Popup blocked. Allow popups for this site and try again.");
      return;
    }
    printWindow.document.open();
    printWindow.document.write("<!doctype html><html><body style='font-family:Arial,sans-serif;padding:16px;'>Preparing print…</body></html>");
    printWindow.document.close();
    setCampaignError(null);
    try {
      const resp = await fetch(source, { method: "GET" });
      if (!resp.ok) {
        throw new Error(`Print failed (${resp.status})`);
      }
      const blob = await resp.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const title = escapeHtml(String(fallbackName ?? "Campaign flyer").trim() || "Campaign flyer");
      const imageUrlEscaped = escapeHtml(objectUrl);
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    html, body { margin: 0; padding: 0; background: #fff; }
    .wrap { margin: 0 auto; width: 100%; max-width: 8.5in; }
    img { display: block; width: 100%; height: auto; }
    @media print {
      @page { size: auto; margin: 0.25in; }
      html, body { background: #fff; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <img src="${imageUrlEscaped}" alt="${title}" />
  </div>
</body>
</html>`;
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      try {
        printWindow.focus();
        const triggerPrint = () => {
          try {
            printWindow.print();
          } catch {}
        };
        if (printWindow.document.readyState === "complete") {
          setTimeout(triggerPrint, 150);
        } else {
          printWindow.onload = () => setTimeout(triggerPrint, 150);
        }
      } catch {}
      setTimeout(() => window.URL.revokeObjectURL(objectUrl), 60_000);
      setSaveToast("Opening print dialog...");
    } catch (err: any) {
      try {
        printWindow.close();
      } catch {}
      setCampaignError(err?.message ?? "Failed to print file.");
    }
  }

  async function openCampaignAssetPrimaryAction(asset: CampaignGeneratedAsset) {
    const target = asset.target;
    const queue = campaignQueueKindForAssetTarget(target);
    if (!queue) {
      setCampaignError("This generated file supports open/download only.");
      return;
    }
    const entry = campaignSelectedEntry;
    if (!entry || !campaignSelectedId) {
      setCampaignError("Save the campaign first, then use send/post.");
      return;
    }
    let actionEntry: CampaignEntry = entry;
    if (!campaignAssetIsQueued(entry, target)) {
      const saved = await setCampaignAssetQueue(target, true);
      if (!saved) return;
      actionEntry = saved;
    }
    if (queue === "send") {
      openSendQueueSendDialog(actionEntry, target);
      return;
    }
    openPostQueuePublishDialog(actionEntry, target);
  }

  async function generateCampaign(opts?: {
    target?: CampaignAssetTarget | null;
    replaceTarget?: boolean;
    editFromCurrent?: boolean;
  }) {
    const name = String(campaignForm.name ?? "").trim();
    if (!name) {
      setCampaignError("Campaign name is required.");
      return;
    }
    const selectedTargets = campaignSelectedTargetsOrdered;
    if (!selectedTargets.length) {
      setCampaignError("Select at least one output file before generating.");
      return;
    }
    const target = (opts?.target ?? campaignTargetToGenerate) as CampaignAssetTarget;
    if (!target || !selectedTargets.includes(target)) {
      setCampaignError("Pick an output target to generate.");
      return;
    }
    const editFromCurrent = Boolean(opts?.editFromCurrent);
    const currentTargetAssetUrl = (() => {
      const byTarget = (campaignGeneratedAssets ?? []).find(
        row => String(row?.target ?? "").trim() === target
      );
      if (String(byTarget?.url ?? "").trim()) return String(byTarget?.url ?? "").trim();
      if ((campaignGeneratedAssets ?? []).length === 1) {
        const single = String(campaignGeneratedAssets[0]?.url ?? "").trim();
        if (single) return single;
      }
      return String(campaignFinalImageUrl ?? "").trim();
    })();
    if (editFromCurrent && !currentTargetAssetUrl) {
      setCampaignError("No current generated image found for this output. Generate once first, then apply edits.");
      return;
    }
    const isScratchBuild = campaignForm.buildMode === "design_from_scratch";
    const baseInspirationImageUrls = parseCampaignUrlsText(campaignForm.inspirationImageUrlsText);
    const inspirationImageUrls = editFromCurrent
      ? (currentTargetAssetUrl ? [currentTargetAssetUrl] : [])
      : isScratchBuild
        ? baseInspirationImageUrls
        : [];
    const assetImageUrls = editFromCurrent
      ? []
      : isScratchBuild
        ? parseCampaignUrlsText(campaignForm.assetImageUrlsText)
        : [];
    setCampaignGenerating(true);
    setCampaignError(null);
    try {
      const payload = {
        campaignId: campaignSelectedId || undefined,
        save: true,
        name,
        buildMode: campaignForm.buildMode,
        channel: campaignEffectiveChannel,
        tags: campaignForm.tags,
        assetTargets: campaignForm.assetTargets,
        singleTarget: target,
        replaceTarget: opts?.replaceTarget !== false,
        editFromCurrent,
        prompt: String(campaignForm.prompt ?? "").trim() || undefined,
        description: String(campaignForm.description ?? "").trim() || undefined,
        inspirationImageUrls,
        assetImageUrls,
        briefDocumentUrls: parseCampaignUrlsText(campaignForm.briefDocumentUrlsText)
      };
      const resp = await fetch("/api/campaigns/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error ?? "Failed to generate campaign");
      }
      const saved = (data?.campaign as CampaignEntry | undefined) ?? null;
      const generated = (data?.generated as any) ?? null;
      if (saved) {
        setCampaignSelectedId(saved.id);
        applyCampaignToForm(saved);
        setCampaigns(prev => {
          const idx = prev.findIndex(row => row.id === saved.id);
          const next = idx >= 0 ? prev.map(row => (row.id === saved.id ? saved : row)) : [saved, ...prev];
          return next.sort((a, b) => {
            const aAt = new Date(String(a.updatedAt ?? a.createdAt ?? "")).getTime();
            const bAt = new Date(String(b.updatedAt ?? b.createdAt ?? "")).getTime();
            return bAt - aAt;
          });
        });
      } else if (generated) {
        const generatedAssets: CampaignGeneratedAsset[] = Array.isArray(generated?.generatedAssets)
          ? generated.generatedAssets
          : [];
        setCampaignForm(prev => ({
          ...prev,
          smsBody: String(generated?.smsBody ?? ""),
          emailSubject: String(generated?.emailSubject ?? ""),
          emailBodyText: String(generated?.emailBodyText ?? ""),
          emailBodyHtml: String(generated?.emailBodyHtml ?? "")
        }));
        setCampaignSourceHits(Array.isArray(generated?.sourceHits) ? generated.sourceHits : []);
        setCampaignGeneratedBy(String(generated?.generatedBy ?? ""));
        setCampaignGeneratedAt(new Date().toISOString());
        setCampaignGeneratedAssets(generatedAssets);
        setCampaignFinalImageUrl(
          String(generated?.finalImageUrl ?? "").trim() || String(generatedAssets[0]?.url ?? "").trim()
        );
      }
      setSaveToast(
        `${CAMPAIGN_ASSET_TARGET_OPTIONS.find(opt => opt.value === target)?.label ?? "Asset"} ${
          editFromCurrent ? "edited" : "generated"
        }`
      );
    } catch (err: any) {
      setCampaignError(err?.message ?? "Failed to generate campaign");
    } finally {
      setCampaignGenerating(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const authResp = await fetch("/api/auth/me", { cache: "no-store" });
      const authJson = await authResp.json().catch(() => null);
      if (!authResp.ok || !authJson?.ok) {
        setAuthUser(null);
        setAuthLoading(false);
        setNeedsBootstrap(false);
        setLoading(false);
        return;
      }
      if (authJson?.needsBootstrap) {
        setNeedsBootstrap(true);
        setAuthUser(null);
        setAuthLoading(false);
        setLoading(false);
        return;
      }
      setNeedsBootstrap(false);
      setAuthUser(authJson?.user ?? null);

      const [s, c, contactsResp, contactListsResp, modelsResp, usersResp] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/conversations", { cache: "no-store" }),
        fetch("/api/contacts", { cache: "no-store" }),
        fetch("/api/contacts/lists", { cache: "no-store" }),
        fetch("/api/models-by-year", { cache: "no-store" }),
        fetch("/api/users", { cache: "no-store" })
      ]);
      const [t, q, sup, googleResp] = await Promise.all([
        fetch("/api/todos", { cache: "no-store" }),
        fetch("/api/questions", { cache: "no-store" }),
        fetch("/api/suppressions", { cache: "no-store" }),
        fetch("/api/google/status", { cache: "no-store" })
      ]);

      const settings = await s.json().catch(() => null);
      const convs = await c.json().catch(() => null);
      const contactsJson = await contactsResp.json().catch(() => null);
      const contactListsJson = await contactListsResp.json().catch(() => null);
      const modelsJson = await modelsResp.json().catch(() => null);
      const usersJson = await usersResp.json().catch(() => null);
      const todosResp = await t.json().catch(() => null);
      const questionsResp = await q.json().catch(() => null);
      const suppressionsResp = await sup.json().catch(() => null);
      const googleJson = await googleResp.json().catch(() => null);

      setMode((settings?.mode as SystemMode) ?? "suggest");
      setConversations(
        (convs?.conversations as ConversationListItem[])?.map(c => ({
          ...c,
          mode: c.mode ?? "suggest"
        })) ?? []
      );
      setTodos((todosResp?.todos as TodoItem[]) ?? []);
      setQuestions((questionsResp?.questions as QuestionItem[]) ?? []);
      setSuppressions((suppressionsResp?.suppressions as SuppressionItem[]) ?? []);
      if (googleResp.ok && googleJson?.ok && typeof googleJson.connected === "boolean") {
        setGoogleStatus({ connected: googleJson.connected, reason: googleJson.reason, error: googleJson.error });
      } else {
        setGoogleStatus(null);
      }

      if (modelsJson?.ok && modelsJson?.modelsByYear) {
        setModelsByYear(modelsJson.modelsByYear as Record<string, string[]>);
      }
      if (usersResp.ok && usersJson?.ok && Array.isArray(usersJson.users)) {
        setUsersList(usersJson.users.map(normalizeUserRow));
      }
      setContacts((contactsJson?.contacts as ContactItem[]) ?? []);
      setContactLists((contactListsJson?.lists as ContactListItem[]) ?? []);
      setLoading(false);
      setAuthLoading(false);
    } catch (err) {
      console.error("[home] initial load failed", err);
      setAuthLoading(false);
      setLoading(false);
    }
  }

  useEffect(() => {
    calendarEventsRef.current = calendarEvents;
  }, [calendarEvents]);

  useEffect(() => {
    if (section !== "calendar") return;
    const compute = () => {
      const el = calendarGridRef.current;
      if (!el) return;
      const height = el.getBoundingClientRect().height;
      const tz = schedulerConfig?.timezone ?? "America/New_York";
      const dayName = calendarDate.toLocaleDateString("en-US", { weekday: "long", timeZone: tz }).toLowerCase();
      const hours = schedulerConfig?.businessHours?.[dayName];
      const parseTime = (t?: string | null) => {
        if (!t) return null;
        const [h, m] = t.split(":").map(Number);
        return h * 60 + (m || 0);
      };
      let open = parseTime(hours?.open);
      let close = parseTime(hours?.close);
      if (open == null || close == null || close <= open) {
        open = 9 * 60;
        close = 18 * 60;
      }
      open = Math.max(0, Math.floor(open / 60) * 60);
      close = Math.min(24 * 60, Math.ceil(close / 60) * 60);
      if (close <= open) {
        close = Math.min(24 * 60, open + 60);
      }
      const totalMinutes = close - open;
      const rowCount = Math.max(1, Math.ceil(totalMinutes / 60));
      const nextHeight = Math.max(32, Math.floor(height / rowCount));
      setCalendarRowHeight(nextHeight);
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [section, schedulerConfig?.businessHours, schedulerConfig?.timezone, calendarDate]);

  useEffect(() => {
    if (section !== "calendar" || calendarView !== "day") return;
    const tick = () => setCalendarNowMs(Date.now());
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [section, calendarView]);

  async function loadConversation(id: string) {
    setDetailLoading(true);
    const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await r.json();
    setSelectedConv(data?.conversation ?? null);
    setDetailLoading(false);
  }

  async function fetchConversationDetail(id: string): Promise<ConversationDetail | null> {
    const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await r.json().catch(() => null);
    return data?.conversation ?? null;
  }

  async function refreshConversations() {
    if (document.visibilityState === "hidden") return;
    const r = await fetch("/api/conversations", { cache: "no-store" });
    const data = await r.json();
    const next =
      (data?.conversations as ConversationListItem[])?.map(c => ({
        ...c,
        mode: c.mode ?? "suggest"
      })) ?? [];
    const sig = next
      .map(c => `${c.id}:${c.updatedAt}:${c.messageCount}:${c.lastMessage?.body ?? ""}`)
      .join("|");
    if (sig && sig === lastConversationsSigRef.current) return;
    lastConversationsSigRef.current = sig;
    setConversations(next);
  }

  async function refreshTodos() {
    const r = await fetch("/api/todos", { cache: "no-store" });
    const data = await r.json().catch(() => null);
    setTodos((data?.todos as TodoItem[]) ?? []);
  }

  async function refreshSelectedConversation(id: string) {
    if (document.visibilityState === "hidden") return;
    const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await r.json();
    const conv = data?.conversation ?? null;
    const sig = conv
      ? `${conv.id}:${conv.updatedAt ?? ""}:${conv.messages?.length ?? 0}:` +
        `${conv.messages?.[conv.messages?.length - 1]?.id ?? ""}`
      : "";
    if (sig && sig === lastSelectedSigRef.current) return;
    lastSelectedSigRef.current = sig;
    setSelectedConv(conv);
  }

  useEffect(() => {
    const context = selectedConv?.agentContext ?? null;
    setAgentContextText(String(context?.text ?? ""));
    setAgentContextMode(context?.mode === "next_reply" ? "next_reply" : "persistent");
    setAgentContextExpiresAt(isoToLocalDateTimeInput(context?.expiresAt));
    setAgentContextError(null);
    setAgentContextSpeechError(null);
  }, [selectedConv?.id, selectedConv?.agentContext?.updatedAt, selectedConv?.agentContext?.text]);

  useEffect(() => {
    setAgentContextOpen(false);
  }, [selectedConv?.id]);

  useEffect(() => {
    setAgentContextSpeechSupported(!!getSpeechRecognitionCtor());
  }, []);

  useEffect(() => {
    if (agentContextOpen || !agentContextSpeechListening) return;
    try {
      agentContextSpeechRef.current?.stop();
    } catch {}
    setAgentContextSpeechListening(false);
  }, [agentContextOpen, agentContextSpeechListening]);

  useEffect(() => {
    return () => {
      try {
        agentContextSpeechRef.current?.abort();
      } catch {}
    };
  }, []);

  function seedWatchItemsFromConv(conv: ConversationDetail | null): WatchFormItem[] {
    const fromExisting =
      conv?.inventoryWatches?.length
        ? conv.inventoryWatches
        : conv?.inventoryWatch
          ? [conv.inventoryWatch]
          : [];
    if (fromExisting.length) {
      return groupWatchesToFormItems(
        fromExisting.map(w => ({
          ...w,
          condition: normalizeWatchCondition(w.condition)
        }))
      );
    }
    const vehicle = conv?.lead?.vehicle;
    const seedModelRaw = String(vehicle?.model ?? vehicle?.description ?? "").trim();
    const seedModel = isGenericWatchModelPlaceholder(seedModelRaw) ? "" : seedModelRaw;
    return [
      {
        condition: normalizeWatchCondition(vehicle?.condition),
        year: vehicle?.year ?? "",
        make: vehicle?.make ?? "",
        model: seedModel,
        models: seedModel ? [seedModel] : [],
        trim: vehicle?.trim ?? "",
        color: vehicle?.color ?? "",
        minPrice: "",
        maxPrice: ""
      }
    ];
  }

  async function openCadenceResolve(convId: string, mode: "alert" | "watch") {
    setCadenceResolveError(null);
    setCadenceResolveMode(mode);
    const conv =
      selectedConv?.id === convId ? selectedConv : await fetchConversationDetail(convId);
    setCadenceResolveConv(conv);
    setCadenceWatchItems(seedWatchItemsFromConv(conv));
    setCadenceWatchNote("");
    setCadenceWatchEnabled(mode === "watch");
    setCadenceResolution(mode === "watch" ? "pause_7" : "resume");
    setCadenceResumeDate("");
    setCadenceResolveOpen(true);
  }

  async function openHoldModal(convId: string) {
    setHoldError(null);
    setHoldSearch("");
    setHoldSelection(null);
    setHoldOnOrder(false);
    setHoldOnOrderLabel("");
    setHoldModalOpen(true);
    const conv =
      selectedConv?.id === convId ? selectedConv : await fetchConversationDetail(convId);
    setHoldModalConv(conv);
    setHoldNote(conv?.hold?.note ?? "");
    const leadVehicle = conv?.lead?.vehicle ?? {};
    const leadLabel = [leadVehicle?.year, leadVehicle?.make, leadVehicle?.model, leadVehicle?.trim]
      .filter(Boolean)
      .join(" ")
      .trim();
    const holdLabelSeed = String(conv?.hold?.label ?? leadLabel ?? "").trim();
    const initialOnOrder =
      !!conv?.hold?.onOrder ||
      String(conv?.hold?.reason ?? "").toLowerCase() === "order_hold";
    setHoldOnOrder(initialOnOrder);
    setHoldOnOrderLabel(holdLabelSeed);
    setHoldInventoryLoading(true);
    try {
      const resp = await fetch("/api/inventory", { cache: "no-store" });
      const json = await resp.json();
      const items = Array.isArray(json?.items) ? json.items : [];
      setHoldInventoryItems(items);
      const leadStock = conv?.lead?.vehicle?.stockId ?? "";
      const leadVin = conv?.lead?.vehicle?.vin ?? "";
      const normalizedLead = String(leadStock || leadVin).trim().toLowerCase();
      const normalizedHold = String(conv?.hold?.stockId || conv?.hold?.vin || conv?.hold?.key || "")
        .trim()
        .toLowerCase();
      const preselect = items.find((it: any) => {
        const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
        return (normalizedHold && key === normalizedHold) || (normalizedLead && key === normalizedLead);
      });
      if (preselect) {
        setHoldSelection(preselect);
      }
    } catch (err: any) {
      setHoldError(err?.message ?? "Failed to load inventory.");
    } finally {
      setHoldInventoryLoading(false);
    }
  }

  async function submitHold(selection: any | null, action: "hold" | "hold_clear") {
    if (!holdModalConv) return;
    if (action === "hold" && !holdOnOrder && !selection) {
      setHoldError("Please select a unit, or enable Bike on order.");
      return;
    }
    setHoldSaving(true);
    setHoldError(null);
    try {
      const leadVehicle = holdModalConv?.lead?.vehicle ?? {};
      const orderLabel = String(holdOnOrderLabel ?? "").trim();
      const holdPayload =
        action === "hold"
          ? {
              onOrder: holdOnOrder || undefined,
              stockId: holdOnOrder ? "" : (selection?.stockId ?? ""),
              vin: holdOnOrder ? "" : (selection?.vin ?? ""),
              year: holdOnOrder ? String(leadVehicle?.year ?? "").trim() : String(selection?.year ?? "").trim(),
              make: holdOnOrder ? String(leadVehicle?.make ?? "").trim() : String(selection?.make ?? "").trim(),
              model: holdOnOrder ? String(leadVehicle?.model ?? "").trim() : String(selection?.model ?? "").trim(),
              trim: holdOnOrder ? String(leadVehicle?.trim ?? "").trim() : String(selection?.trim ?? "").trim(),
              color: holdOnOrder ? String(leadVehicle?.color ?? "").trim() : String(selection?.color ?? "").trim(),
              label: holdOnOrder
                ? orderLabel
                : [selection?.year, selection?.make, selection?.model, selection?.trim]
                    .filter(Boolean)
                    .join(" ")
                    .trim(),
              note: holdNote?.trim() || undefined
            }
          : undefined;
      const resp = await fetch(
        `/api/conversations/${encodeURIComponent(holdModalConv.id)}/followup-action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolution: action, holdUnit: holdPayload })
        }
      );
      const data = await resp.json().catch(() => null);
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Failed to update hold");
      }
      if (selectedConv?.id === holdModalConv.id && data?.conversation) {
        setSelectedConv(data.conversation);
      }
      setHoldModalOpen(false);
      void load();
    } catch (err: any) {
      setHoldError(err?.message ?? "Failed to update hold");
    } finally {
      setHoldSaving(false);
    }
  }

  async function openSoldModal(convId: string) {
    setSoldError(null);
    setSoldSearch("");
    setSoldSelection(null);
    setSoldManualOpen(false);
    setSoldModalOpen(true);
    const conv =
      selectedConv?.id === convId ? selectedConv : await fetchConversationDetail(convId);
    setSoldModalConv(conv);
    setSoldNote(conv?.sale?.note ?? "");
    const leadVehicle = conv?.lead?.vehicle ?? {};
    setSoldManualUnit({
      year: String(conv?.sale?.year ?? leadVehicle?.year ?? "") || "",
      make: conv?.sale?.make ?? leadVehicle?.make ?? "",
      model: conv?.sale?.model ?? leadVehicle?.model ?? "",
      trim: conv?.sale?.trim ?? leadVehicle?.trim ?? "",
      color: conv?.sale?.color ?? leadVehicle?.color ?? "",
      stockId: conv?.sale?.stockId ?? leadVehicle?.stockId ?? "",
      vin: conv?.sale?.vin ?? leadVehicle?.vin ?? ""
    });
    setSoldInventoryLoading(true);
    try {
      const resp = await fetch("/api/inventory", { cache: "no-store" });
      const json = await resp.json();
      const items = Array.isArray(json?.items) ? json.items : [];
      setSoldInventoryItems(items);
      const leadStock = conv?.lead?.vehicle?.stockId ?? "";
      const leadVin = conv?.lead?.vehicle?.vin ?? "";
      const normalizedLead = String(leadStock || leadVin).trim().toLowerCase();
      const normalizedSold = String(conv?.sale?.stockId || conv?.sale?.vin || "")
        .trim()
        .toLowerCase();
      const preselect = items.find((it: any) => {
        const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
        return (normalizedSold && key === normalizedSold) || (normalizedLead && key === normalizedLead);
      });
      if (preselect) {
        setSoldSelection(preselect);
      }
    } catch (err: any) {
      setSoldError(err?.message ?? "Failed to load inventory.");
    } finally {
      setSoldInventoryLoading(false);
    }
  }

  function resolveSoldSelection() {
    if (soldSelection) return soldSelection;
    const stockId = String(soldManualUnit?.stockId ?? "").trim();
    const vin = String(soldManualUnit?.vin ?? "").trim();
    if (!stockId && !vin) return null;
    return {
      year: String(soldManualUnit?.year ?? "").trim(),
      make: String(soldManualUnit?.make ?? "").trim(),
      model: String(soldManualUnit?.model ?? "").trim(),
      trim: String(soldManualUnit?.trim ?? "").trim(),
      color: String(soldManualUnit?.color ?? "").trim(),
      stockId,
      vin
    };
  }

  async function submitSold(selection: any) {
    if (!soldModalConv) return;
    const resolved = selection ?? resolveSoldSelection();
    if (!resolved) {
      setSoldError("Please select a unit or enter a stock/VIN to mark sold.");
      return;
    }
    setSoldSaving(true);
    setSoldError(null);
    try {
      const soldByName =
        soldByOptions.find(sp => sp.id === soldById)?.firstName ??
        soldByOptions.find(sp => sp.id === soldById)?.name ??
        "";
      const soldPayload = {
        stockId: resolved?.stockId ?? "",
        vin: resolved?.vin ?? "",
        label: [resolved?.year, resolved?.make, resolved?.model, resolved?.trim]
          .filter(Boolean)
          .join(" ")
          .trim(),
        note: soldNote?.trim() || undefined,
        year: resolved?.year ?? "",
        make: resolved?.make ?? "",
        model: resolved?.model ?? "",
        trim: resolved?.trim ?? "",
        color: resolved?.color ?? ""
      };
      const resp = await fetch(`/api/conversations/${encodeURIComponent(soldModalConv.id)}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "sold",
          soldById,
          soldByName,
          soldUnit: soldPayload
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Failed to mark sold");
      }
      if (data?.conversation) {
        const conv = data.conversation as ConversationDetail & { messages?: Message[] };
        if (selectedConv?.id === conv.id) {
          setSelectedConv(conv);
        }
        setConversations(prev =>
          prev.map(c => {
            if (c.id !== conv.id) return c;
            const last = Array.isArray(conv.messages) ? conv.messages[conv.messages.length - 1] : null;
            return {
              ...c,
              status: conv.status ?? c.status,
              closedReason: conv.closedReason ?? c.closedReason,
              sale: conv.sale ?? c.sale,
              hold: conv.hold ?? c.hold,
              followUp: conv.followUp ?? c.followUp,
              followUpCadence: conv.followUpCadence ?? c.followUpCadence,
              updatedAt: conv.updatedAt ?? c.updatedAt,
              messageCount: Array.isArray(conv.messages) ? conv.messages.length : c.messageCount,
              lastMessage: last
                ? {
                    direction: last.direction,
                    body: last.body,
                    provider: last.provider
                  }
                : c.lastMessage ?? null
            };
          })
        );
      }
      setSaveToast("Saved");
      setCloseReason("");
      setSoldById("");
      setSoldModalOpen(false);
      await load();
    } catch (err: any) {
      setSoldError(err?.message ?? "Failed to mark sold");
    } finally {
      setSoldSaving(false);
    }
  }

  function openCompose() {
    setComposeError(null);
    setComposePhone("");
    setComposeBody("");
    setComposeShowDetails(false);
    setComposeFirstName("");
    setComposeLastName("");
    setComposeEmail("");
    setComposeVehicle({});
    setComposeInventoryItems([]);
    setComposeInventoryOpen(false);
    setComposeSearch("");
    setComposeSelection(null);
    setComposeSmsAttachments([]);
    setComposeSmsAttachmentsBusy(false);
    setComposeOpen(true);
  }

  async function toggleComposeInventory() {
    const nextOpen = !composeInventoryOpen;
    setComposeInventoryOpen(nextOpen);
    if (!nextOpen || composeInventoryItems.length) return;
    setComposeInventoryLoading(true);
    try {
      const resp = await fetch("/api/inventory", { cache: "no-store" });
      const json = await resp.json();
      const items = Array.isArray(json?.items) ? json.items : [];
      setComposeInventoryItems(items);
    } catch (err: any) {
      setComposeError(err?.message ?? "Failed to load inventory.");
    } finally {
      setComposeInventoryLoading(false);
    }
  }

  function applyComposeSelection(it: any) {
    if (!it) return;
    setComposeSelection(it);
    setComposeVehicle({
      year: it.year ?? "",
      make: it.make ?? "",
      model: it.model ?? "",
      trim: it.trim ?? "",
      color: it.color ?? "",
      stockId: it.stockId ?? "",
      vin: it.vin ?? "",
      condition: it.condition ?? ""
    });
  }

  async function handleComposeSmsAttachments(files: FileList | null) {
    if (!files || files.length === 0) return;
    setComposeSmsAttachmentsBusy(true);
    const selected = Array.from(files);
    const maxPerFile = 100 * 1024 * 1024;
    const next: { name: string; type: string; size: number; file: File }[] = [];
    for (const file of selected) {
      if (file.size > maxPerFile) {
        window.alert(`"${file.name}" is too large (max 100MB).`);
        continue;
      }
      if (!(file.type.startsWith("image/") || file.type.startsWith("video/"))) {
        window.alert(`"${file.name}" must be an image or video file.`);
        continue;
      }
      next.push({
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        file
      });
    }
    if (next.length) {
      setComposeSmsAttachments(prev => [...prev, ...next]);
    }
    setComposeSmsAttachmentsBusy(false);
  }

  function removeComposeSmsAttachment(index: number) {
    setComposeSmsAttachments(prev => prev.filter((_, i) => i !== index));
  }

  async function sendCompose() {
    if (!composePhone.trim()) {
      setComposeError("Phone is required.");
      return;
    }
    if (!composeBody.trim() && composeSmsAttachments.length === 0) {
      setComposeError("Message or media is required.");
      return;
    }
    if (composeSmsAttachmentsBusy) {
      setComposeError("Media is still uploading. Please wait a moment.");
      return;
    }
    setComposeSending(true);
    setComposeError(null);
    try {
      const payload: any = {
        phone: composePhone.trim(),
        firstName: composeFirstName.trim() || undefined,
        lastName: composeLastName.trim() || undefined,
        email: composeEmail.trim() || undefined
      };
      const vehicle = {
        year: String(composeVehicle.year ?? "").trim() || undefined,
        make: String(composeVehicle.make ?? "").trim() || undefined,
        model: String(composeVehicle.model ?? "").trim() || undefined,
        trim: String(composeVehicle.trim ?? "").trim() || undefined,
        color: String(composeVehicle.color ?? "").trim() || undefined,
        stockId: String(composeVehicle.stockId ?? "").trim() || undefined,
        vin: String(composeVehicle.vin ?? "").trim() || undefined,
        condition: String(composeVehicle.condition ?? "").trim() || undefined
      };
      if (Object.values(vehicle).some(v => v)) {
        payload.vehicle = vehicle;
      }
      const resp = await fetch("/api/conversations/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Failed to create conversation");
      }
      const conv = data?.conversation;
      if (!conv?.id) {
        throw new Error("Conversation not returned");
      }
      const uploadedComposeMedia: { name: string; url: string; mode: "mms" | "link" }[] = [];
      for (const att of composeSmsAttachments) {
        const fd = new FormData();
        fd.append("file", att.file);
        const mediaResp = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/media`, {
          method: "POST",
          body: fd
        });
        const mediaPayload = await mediaResp.json().catch(() => null);
        if (!mediaResp.ok || !mediaPayload?.url) {
          throw new Error(mediaPayload?.error ?? `Failed to upload "${att.name}".`);
        }
        const mode =
          (typeof mediaPayload.mmsEligible === "boolean"
            ? mediaPayload.mmsEligible
            : att.size <= 5 * 1024 * 1024)
            ? ("mms" as const)
            : ("link" as const);
        uploadedComposeMedia.push({
          name: String(mediaPayload.name ?? att.name),
          url: String(mediaPayload.url),
          mode
        });
      }
      const composeMmsMediaUrls = uploadedComposeMedia
        .filter(att => att.mode === "mms")
        .map(att => att.url);
      const composeLinkSuffix = uploadedComposeMedia
        .filter(att => att.mode === "link")
        .map(att => `${att.name || "Media"}: ${att.url}`)
        .join("\n");
      const composeBodyWithLinks = composeLinkSuffix
        ? `${composeBody.trim()}\n\n${composeLinkSuffix}`.trim()
        : composeBody.trim();
      const sendResp = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: composeBodyWithLinks,
          channel: "sms",
          manualTakeover: true,
          mediaUrls: composeMmsMediaUrls
        })
      });
      const sendData = await sendResp.json().catch(() => null);
      if (!sendResp.ok || sendData?.ok === false) {
        throw new Error(sendData?.error ?? "Failed to send SMS");
      }
      setComposeSmsAttachments([]);
      setComposeOpen(false);
      openConversation(conv.id);
      setSelectedConv(sendData?.conversation ?? conv);
      await load();
    } catch (err: any) {
      setComposeError(err?.message ?? "Failed to send SMS");
    } finally {
      setComposeSending(false);
    }
  }

  function updateWatchItem(idx: number, patch: Partial<WatchFormItem>) {
    setCadenceWatchItems(prev =>
      prev.map((item, i) => (i === idx ? { ...item, ...patch } : item))
    );
  }

  function addWatchItem() {
    setCadenceWatchItems(prev => {
      const base =
        prev[0] ?? {
          condition: "",
          year: "",
          make: "",
          model: "",
          trim: "",
          color: "",
          minPrice: "",
          maxPrice: ""
        };
      return [...prev, { ...base, model: "", models: [], customModel: "", modelSearch: "" }];
    });
  }

  function removeWatchItem(idx: number) {
    setCadenceWatchItems(prev => prev.filter((_, i) => i !== idx));
  }

  function updateWatchEditItem(idx: number, patch: Partial<WatchFormItem>) {
    setWatchEditItems(prev => prev.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  }

  function addWatchEditItem() {
    setWatchEditItems(prev => {
      const base =
        prev[0] ?? {
          condition: "",
          year: "",
          make: "",
          model: "",
          trim: "",
          color: "",
          minPrice: "",
          maxPrice: ""
        };
      return [...prev, { ...base, model: "", models: [], customModel: "", modelSearch: "" }];
    });
  }

  function removeWatchEditItem(idx: number) {
    setWatchEditItems(prev => prev.filter((_, i) => i !== idx));
  }

  function watchToFormItem(watch: any): WatchFormItem {
    const yearText =
      watch?.year ??
      (watch?.yearMin && watch?.yearMax
        ? `${watch.yearMin}-${watch.yearMax}`
        : watch?.yearMin ?? watch?.yearMax ?? "") ??
      "";
    const modelRaw = String(watch?.model ?? "").trim();
    const model = isGenericWatchModelPlaceholder(modelRaw) ? "" : modelRaw;
    return {
      condition: watch?.condition ?? "",
      year: yearText ? String(yearText) : "",
      make: watch?.make ?? "",
      model,
      models: model ? [model] : [],
      customModel: "",
      modelSearch: "",
      trim: watch?.trim ?? "",
      color: watch?.color ?? "",
      minPrice: watch?.minPrice != null ? String(watch.minPrice) : "",
      maxPrice: watch?.maxPrice != null ? String(watch.maxPrice) : ""
    };
  }

  function getItemModels(item: WatchFormItem): string[] {
    const raw = item.models && item.models.length ? item.models : item.model ? [item.model] : [];
    return Array.from(
      new Set(
        raw
          .map(m => m.trim())
          .filter(Boolean)
          .filter(m => !isGenericWatchModelPlaceholder(m))
      )
    );
  }

  function groupWatchesToFormItems(watches: any[]): WatchFormItem[] {
    const map = new Map<string, WatchFormItem>();
    watches.forEach(watch => {
      const base = watchToFormItem(watch);
      const key = [
        base.condition ?? "",
        base.year ?? "",
        base.make ?? "",
        base.trim ?? "",
        base.color ?? "",
        base.minPrice ?? "",
        base.maxPrice ?? ""
      ]
        .map(v => String(v).toLowerCase())
        .join("|");
      const existing = map.get(key);
      const models = getItemModels(base);
      if (!existing) {
        map.set(key, { ...base, models: models.length ? models : [], model: models[0] ?? base.model });
        return;
      }
      const next = new Set([...(existing.models ?? []), ...models]);
      existing.models = Array.from(next);
      existing.model = existing.models[0] ?? existing.model ?? "";
      map.set(key, existing);
    });
    return Array.from(map.values()).map(item => {
      const models = getItemModels(item);
      return { ...item, models, model: models[0] ?? item.model ?? "", customModel: "", modelSearch: "" };
    });
  }

  function expandWatchItems(items: WatchFormItem[]): WatchFormItem[] {
    const expanded: WatchFormItem[] = [];
    items.forEach(item => {
      const models = getItemModels(item);
      if (!models.length) return;
      models.forEach(model => {
        expanded.push({
          condition: item.condition,
          year: item.year,
          make: item.make,
          model,
          trim: item.trim,
          color: item.color,
          minPrice: item.minPrice,
          maxPrice: item.maxPrice
        });
      });
    });
    return expanded;
  }

  function parseYearRangeValue(value: string): { min: number; max: number } | null {
    const t = (value ?? "").trim();
    if (!t) return null;
    const range = t.match(/\b(20\d{2})\s*-\s*(20\d{2})\b/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        return { min: Math.min(a, b), max: Math.max(a, b) };
      }
    }
    const single = t.match(/\b(20\d{2})\b/);
    if (single) {
      const y = Number(single[1]);
      if (Number.isFinite(y)) return { min: y, max: y };
    }
    return null;
  }

  function getModelsForYearValue(yearValue: string, makeValue?: string): string[] {
    const make = (makeValue ?? "").trim().toLowerCase();
    if (make && make !== "harley-davidson" && make !== "harley davidson") {
      return [];
    }
    const range = parseYearRangeValue(yearValue);
    if (!range) {
      const all = new Set<string>();
      Object.values(modelsByYear).forEach(list => {
        (list ?? []).forEach(name => {
          if (name) all.add(name);
        });
      });
      return Array.from(all).sort((a, b) => a.localeCompare(b));
    }
    const out = new Set<string>();
    for (let y = range.min; y <= range.max; y++) {
      for (const name of modelsByYear[String(y)] ?? []) out.add(name);
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
  }

  function getWatchModelChoices(item: WatchFormItem): string[] {
    const optionSet = new Map<string, string>();
    const modelOptions = getModelsForYearValue(item.year, item.make);
    modelOptions.forEach(model => {
      const key = model.trim().toLowerCase();
      if (key && !optionSet.has(key)) optionSet.set(key, model);
    });
    const selectedModels = getItemModels(item);
    selectedModels.forEach(model => {
      const trimmed = model.trim();
      const key = trimmed.toLowerCase();
      if (key && !optionSet.has(key)) optionSet.set(key, trimmed);
    });
    return Array.from(optionSet.values()).sort((a, b) => a.localeCompare(b));
  }

  function filterWatchModelChoices(options: string[], query?: string): string[] {
    const q = normalizeModelMatchText(query ?? "");
    if (!q) return options;
    return options.filter(option => normalizeModelMatchText(option).includes(q));
  }

  function normalizeModelMatchText(value: string): string {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function modelTokens(value: string): string[] {
    return normalizeModelMatchText(value).split(" ").filter(Boolean);
  }

  function hasTokenFragment(tokens: string[], fragment: string): boolean {
    const needle = String(fragment ?? "").toLowerCase();
    if (!needle) return false;
    return tokens.some(token => token.includes(needle));
  }

  function isSportster1250Variant(tokens: string[]): boolean {
    const hasSportster = tokens.includes("sportster");
    const has1250 = hasTokenFragment(tokens, "1250") || tokens.some(token => /^rh1250/.test(token));
    const hasSportsterS = hasSportster && tokens.includes("s");
    return has1250 || hasSportsterS;
  }

  function isIron883Variant(tokens: string[]): boolean {
    const has883 = hasTokenFragment(tokens, "883");
    if (!has883) return false;
    const hasIron =
      tokens.includes("iron") ||
      hasTokenFragment(tokens, "883n") ||
      tokens.some(token => /^xl883n/.test(token));
    return hasIron;
  }

  function containsTokenSequence(haystack: string[], needle: string[]): boolean {
    if (!needle.length || haystack.length < needle.length) return false;
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  type WatchModelFamilyId =
    | "trike"
    | "tri_glide"
    | "touring"
    | "grand_american_touring"
    | "softail"
    | "dyna"
    | "cvo"
    | "nightster"
    | "sport_glide"
    | "road_glide_limited"
    | "ultra_limited"
    | "low_rider_s"
    | "softail_deluxe"
    | "deluxe"
    | "street_glide"
    | "road_glide"
    | "road_king"
    | "heritage"
    | "sportster"
    | "pan_america"
    | "v_rod"
    | "street_bob"
    | "fat_bob"
    | "fat_boy"
    | "breakout"
    | "ultra_classic"
    | "electra_glide"
    | "springer_softail"
    | "wide_glide";

  function tokensExactly(tokens: string[], expected: string[]): boolean {
    if (tokens.length !== expected.length) return false;
    return tokens.every((token, idx) => token === expected[idx]);
  }

  function detectGenericWatchFamily(tokens: string[]): WatchModelFamilyId | null {
    if (!tokens.length) return null;
    if (tokensExactly(tokens, ["trike"]) || tokensExactly(tokens, ["trikes"])) return "trike";
    if (tokensExactly(tokens, ["tri", "glide"])) return "tri_glide";
    if (tokensExactly(tokens, ["touring"])) return "touring";
    if (tokensExactly(tokens, ["grand", "american", "touring"])) return "grand_american_touring";
    if (tokensExactly(tokens, ["softail"])) return "softail";
    if (tokensExactly(tokens, ["dyna"])) return "dyna";
    if (tokensExactly(tokens, ["cvo"])) return "cvo";
    if (tokensExactly(tokens, ["nightster"])) return "nightster";
    if (tokensExactly(tokens, ["sport", "glide"])) return "sport_glide";
    if (tokensExactly(tokens, ["road", "glide", "limited"])) return "road_glide_limited";
    if (tokensExactly(tokens, ["ultra", "limited"])) return "ultra_limited";
    if (tokensExactly(tokens, ["low", "rider", "s"])) return "low_rider_s";
    if (tokensExactly(tokens, ["softail", "deluxe"])) return "softail_deluxe";
    if (tokensExactly(tokens, ["deluxe"])) return "deluxe";
    if (tokensExactly(tokens, ["street", "glide"])) return "street_glide";
    if (tokensExactly(tokens, ["road", "glide"])) return "road_glide";
    if (tokensExactly(tokens, ["road", "king"])) return "road_king";
    if (
      tokensExactly(tokens, ["heritage"]) ||
      tokensExactly(tokens, ["heritage", "classic"]) ||
      tokensExactly(tokens, ["heritage", "softail"]) ||
      tokensExactly(tokens, ["heritage", "softail", "classic"])
    ) {
      return "heritage";
    }
    if (tokensExactly(tokens, ["sportster"])) return "sportster";
    if (tokensExactly(tokens, ["pan", "america"]) || tokensExactly(tokens, ["pan", "america", "1250"])) {
      return "pan_america";
    }
    if (tokensExactly(tokens, ["vrod"]) || tokensExactly(tokens, ["v", "rod"])) return "v_rod";
    if (tokensExactly(tokens, ["street", "bob"])) return "street_bob";
    if (tokensExactly(tokens, ["fat", "bob"])) return "fat_bob";
    if (tokensExactly(tokens, ["fat", "boy"])) return "fat_boy";
    if (tokensExactly(tokens, ["breakout"])) return "breakout";
    if (tokensExactly(tokens, ["ultra", "classic"])) return "ultra_classic";
    if (
      tokensExactly(tokens, ["electra", "glide"]) ||
      tokensExactly(tokens, ["electraglide"]) ||
      tokensExactly(tokens, ["electraglide", "classic"])
    ) {
      return "electra_glide";
    }
    if (tokensExactly(tokens, ["springer", "softail"])) return "springer_softail";
    if (tokensExactly(tokens, ["wide", "glide"])) return "wide_glide";
    return null;
  }

  function optionMatchesWatchFamily(optionTokens: string[], familyId: WatchModelFamilyId): boolean {
    if (!optionTokens.length) return false;
    const optionHasTriGlide =
      containsTokenSequence(optionTokens, ["tri", "glide"]) || optionTokens.includes("flhtcutg");
    const optionHasRoadGlideTrike =
      containsTokenSequence(optionTokens, ["road", "glide"]) &&
      (optionTokens.includes("3") ||
        optionTokens.includes("iii") ||
        optionTokens.includes("trike") ||
        optionTokens.includes("fltrt"));
    const optionHasStreetGlideTrike =
      containsTokenSequence(optionTokens, ["street", "glide"]) &&
      (optionTokens.includes("3") ||
        optionTokens.includes("iii") ||
        optionTokens.includes("trike") ||
        optionTokens.includes("flhlt"));
    const optionHasFreewheeler = optionTokens.includes("freewheeler") || optionTokens.includes("flrt");
    const optionHasRoadGlide = containsTokenSequence(optionTokens, ["road", "glide"]);
    const optionHasStreetGlide = containsTokenSequence(optionTokens, ["street", "glide"]);
    const optionHasRoadKing = containsTokenSequence(optionTokens, ["road", "king"]);
    const optionHasElectraGlide = containsTokenSequence(optionTokens, ["electra", "glide"]);
    const optionHasUltraClassic = containsTokenSequence(optionTokens, ["ultra", "classic"]);
    const optionHasUltraLimited = containsTokenSequence(optionTokens, ["ultra", "limited"]);
    const optionHasTourGlide = containsTokenSequence(optionTokens, ["tour", "glide"]);
    const optionHasLowRider = containsTokenSequence(optionTokens, ["low", "rider"]);
    const optionHasStreetBob = containsTokenSequence(optionTokens, ["street", "bob"]);
    const optionHasFatBob = containsTokenSequence(optionTokens, ["fat", "bob"]);
    const optionHasFatBoy = containsTokenSequence(optionTokens, ["fat", "boy"]);
    const optionHasBreakout = optionTokens.includes("breakout");
    const optionHasHeritage = optionTokens.includes("heritage");
    const optionHasSoftail = optionTokens.includes("softail");
    const optionHasDeluxe = optionTokens.includes("deluxe");
    const optionHasSlim = optionTokens.includes("slim");
    const optionHasSportGlide = containsTokenSequence(optionTokens, ["sport", "glide"]) || optionTokens.includes("flsb");
    const optionHasSpringer = optionTokens.includes("springer");
    const optionHasDeuce = optionTokens.includes("deuce");
    const optionHasRocker = optionTokens.includes("rocker");
    const optionHasCrossBones = containsTokenSequence(optionTokens, ["cross", "bones"]);
    const optionHasBlackline = optionTokens.includes("blackline");
    const optionHasDyna = optionTokens.includes("dyna");
    const optionHasWideGlide = containsTokenSequence(optionTokens, ["wide", "glide"]);
    const optionHasSwitchback = optionTokens.includes("switchback");
    const optionHasSuperGlide =
      (optionTokens.includes("super") && optionTokens.includes("glide")) || optionTokens.includes("fxr");
    const optionHasCvo = optionTokens.includes("cvo");
    const optionHasNightster = optionTokens.includes("nightster") || optionTokens.some(token => /^rh975/.test(token));
    switch (familyId) {
      case "trike":
        return (
          optionHasTriGlide ||
          optionHasRoadGlideTrike ||
          optionHasStreetGlideTrike ||
          optionHasFreewheeler ||
          optionTokens.includes("trike")
        );
      case "tri_glide":
        return optionHasTriGlide;
      case "touring":
      case "grand_american_touring":
        return (
          optionHasRoadGlide ||
          optionHasStreetGlide ||
          optionHasRoadKing ||
          optionHasElectraGlide ||
          optionHasUltraClassic ||
          optionHasUltraLimited ||
          optionHasTourGlide
        );
      case "softail":
        return (
          optionHasSoftail ||
          optionHasHeritage ||
          optionHasStreetBob ||
          optionHasFatBob ||
          optionHasFatBoy ||
          optionHasBreakout ||
          optionHasLowRider ||
          optionHasSlim ||
          optionHasSportGlide ||
          optionHasSpringer ||
          optionHasDeluxe ||
          optionHasDeuce ||
          optionHasRocker ||
          optionHasCrossBones ||
          optionHasBlackline
        );
      case "dyna":
        return (
          optionHasDyna ||
          optionHasStreetBob ||
          optionHasFatBob ||
          optionHasWideGlide ||
          optionHasSwitchback ||
          optionHasLowRider ||
          optionHasSuperGlide
        );
      case "cvo":
        return optionHasCvo;
      case "nightster":
        return optionHasNightster;
      case "sport_glide":
        return optionHasSportGlide;
      case "road_glide_limited":
        return (
          containsTokenSequence(optionTokens, ["road", "glide", "limited"]) ||
          (containsTokenSequence(optionTokens, ["road", "glide"]) && optionTokens.includes("fltrk"))
        );
      case "ultra_limited":
        return (
          containsTokenSequence(optionTokens, ["ultra", "limited"]) ||
          containsTokenSequence(optionTokens, ["electra", "glide", "ultra", "limited"])
        );
      case "low_rider_s":
        return containsTokenSequence(optionTokens, ["low", "rider", "s"]);
      case "softail_deluxe":
        return (
          containsTokenSequence(optionTokens, ["softail", "deluxe"]) ||
          optionTokens.includes("deluxe")
        );
      case "deluxe":
        return optionTokens.includes("deluxe");
      case "street_glide":
        return containsTokenSequence(optionTokens, ["street", "glide"]);
      case "road_glide":
        return containsTokenSequence(optionTokens, ["road", "glide"]);
      case "road_king":
        return containsTokenSequence(optionTokens, ["road", "king"]);
      case "heritage":
        return (
          optionTokens.includes("heritage") ||
          containsTokenSequence(optionTokens, ["heritage", "classic"]) ||
          containsTokenSequence(optionTokens, ["heritage", "softail"])
        );
      case "sportster":
        return (
          optionTokens.includes("sportster") ||
          hasTokenFragment(optionTokens, "883") ||
          optionTokens.some(token => /^rh1250/.test(token) || /^xl883/.test(token) || /^xl1200/.test(token))
        );
      case "pan_america":
        return (
          containsTokenSequence(optionTokens, ["pan", "america"]) ||
          optionTokens.some(token => /^ra1250/.test(token))
        );
      case "v_rod":
        return (
          optionTokens.includes("vrod") ||
          containsTokenSequence(optionTokens, ["v", "rod"]) ||
          containsTokenSequence(optionTokens, ["night", "rod"]) ||
          containsTokenSequence(optionTokens, ["street", "rod"]) ||
          optionTokens.some(token => /^vrsc/.test(token))
        );
      case "street_bob":
        return containsTokenSequence(optionTokens, ["street", "bob"]);
      case "fat_bob":
        return containsTokenSequence(optionTokens, ["fat", "bob"]);
      case "fat_boy":
        return containsTokenSequence(optionTokens, ["fat", "boy"]);
      case "breakout":
        return optionTokens.includes("breakout");
      case "ultra_classic":
        return (
          containsTokenSequence(optionTokens, ["ultra", "classic"]) ||
          containsTokenSequence(optionTokens, ["ultra", "limited"]) ||
          (containsTokenSequence(optionTokens, ["electra", "glide"]) && optionTokens.includes("ultra"))
        );
      case "electra_glide":
        return containsTokenSequence(optionTokens, ["electra", "glide"]) || optionTokens.includes("electraglide");
      case "springer_softail":
        return (
          containsTokenSequence(optionTokens, ["springer", "softail"]) ||
          (optionTokens.includes("springer") && optionTokens.includes("softail"))
        );
      case "wide_glide":
        return containsTokenSequence(optionTokens, ["wide", "glide"]);
      default:
        return false;
    }
  }

  function isWatchModelOptionChecked(groupModels: string[], option: string): boolean {
    const normalizedOption = normalizeModelMatchText(option);
    if (!normalizedOption) return false;
    const selected = groupModels.map(normalizeModelMatchText).filter(Boolean);
    if (selected.includes(normalizedOption)) return true;
    const optionTokens = modelTokens(option);
    const optionHasSportster = optionTokens.includes("sportster");
    const optionHas883 = hasTokenFragment(optionTokens, "883");
    const optionIsSportster1250 = isSportster1250Variant(optionTokens);
    return selected.some(model => {
      const tokens = modelTokens(model);
      if (!tokens.length) return false;
      const selectedGenericFamily = detectGenericWatchFamily(tokens);
      if (selectedGenericFamily) {
        return optionMatchesWatchFamily(optionTokens, selectedGenericFamily);
      }
      const selectedHasSportster = tokens.includes("sportster");
      const selectedHas883 = hasTokenFragment(tokens, "883");
      const selectedIsSportster1250 = isSportster1250Variant(tokens);
      const selectedWantsSportsterS =
        selectedHasSportster && !selectedHas883 && selectedIsSportster1250;
      const selectedDisplacements = Array.from(
        new Set(tokens.flatMap(token => token.match(/\d{3,4}/g) ?? []))
      );

      // "883" watch includes both explicit Sportster 883 and 883-coded labels.
      if (selectedHas883) {
        const selectedWantsIron883 = isIron883Variant(tokens);
        if (selectedWantsIron883) {
          return optionHas883 && isIron883Variant(optionTokens);
        }
        return optionHas883;
      }

      // "Sportster S"/1250 watch should stay in that lane only.
      if (selectedWantsSportsterS) {
        return optionIsSportster1250;
      }

      // "Sportster 1200" (or any specific displacement) should only match that displacement.
      if (selectedHasSportster && selectedDisplacements.length) {
        return selectedDisplacements.some(d => hasTokenFragment(optionTokens, d));
      }

      // Generic "Sportster" watch should include Sportster family + 883-only labels,
      // while excluding Sportster S / RH1250 unless explicitly requested.
      if (selectedHasSportster) {
        if (optionIsSportster1250) return false;
        return optionHasSportster || optionHas883;
      }

      // Generic family matching:
      // if selected model is a family label like "Fat Boy", treat model variants
      // (e.g. Fat Boy 114, Fat Boy Lo, Fat Boy Anniversary) as selected too.
      if (tokens.length >= 2) {
        if (containsTokenSequence(optionTokens, tokens)) return true;
        const selectedCollapsed = tokens.join("");
        const optionCollapsed = optionTokens.join("");
        if (selectedCollapsed.length >= 6 && optionCollapsed.includes(selectedCollapsed)) return true;
      }
      return false;
    });
  }

  const watchMakeOptions = useMemo(() => {
    const set = new Set<string>();
    if (Object.keys(modelsByYear).length) set.add("Harley-Davidson");
    inventoryItems.forEach(item => {
      const make = String(item?.make ?? "").trim();
      if (make) set.add(make);
    });
    watchEditItems.forEach(item => {
      const make = String(item?.make ?? "").trim();
      if (make) set.add(make);
    });
    cadenceWatchItems.forEach(item => {
      const make = String(item?.make ?? "").trim();
      if (make) set.add(make);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [modelsByYear, inventoryItems, watchEditItems, cadenceWatchItems]);

  async function openWatchEdit(convId: string) {
    setWatchEditError(null);
    const convFromDetail =
      (selectedConv?.id === convId || selectedConv?.leadKey === convId
        ? selectedConv
        : await fetchConversationDetail(convId)) ?? null;
    const conv = convFromDetail ?? conversations.find(c => c.id === convId || c.leadKey === convId) ?? null;
    if (!conv) return;
    const watches =
      conv.inventoryWatches && conv.inventoryWatches.length
        ? conv.inventoryWatches
        : conv.inventoryWatch
          ? [conv.inventoryWatch]
          : [];
    setWatchEditConvId(conv.id);
    setWatchEditItems(
      watches.length ? groupWatchesToFormItems(watches) : seedWatchItemsFromConv(conv as ConversationDetail)
    );
    const note = watches.find(w => String(w?.note ?? "").trim())?.note ?? "";
    setWatchEditNote(note);
    setWatchEditOpen(true);
  }

  async function saveWatchEdit() {
    if (!watchEditConvId) return;
    const hasModel = watchEditItems.some(item => getItemModels(item).length > 0);
    if (!hasModel) {
      setWatchEditError("Please enter at least one model to watch.");
      return;
    }
    setWatchEditSaving(true);
    setWatchEditError(null);
    try {
      const payload = {
        items: expandWatchItems(watchEditItems),
        note: watchEditNote.trim() || undefined
      };
      const resp = await fetch(`/api/conversations/${encodeURIComponent(watchEditConvId)}/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Failed to update watch");
      }
      setWatchEditOpen(false);
      await load();
      if (selectedConv?.id === watchEditConvId) {
        setSelectedConv(data?.conversation ?? selectedConv);
      }
    } catch (err: any) {
      setWatchEditError(err?.message ?? "Failed to update watch");
    } finally {
      setWatchEditSaving(false);
    }
  }

  async function deleteWatchForConv(convId: string, watchIndex?: number) {
    if (!window.confirm("Delete this watch?")) return;
    const conv = conversations.find(c => c.id === convId || c.leadKey === convId);
    if (!conv) return;
    const watches =
      conv.inventoryWatches && conv.inventoryWatches.length
        ? conv.inventoryWatches
        : conv.inventoryWatch
          ? [conv.inventoryWatch]
          : [];
    if (!watches.length) return;
    if (typeof watchIndex === "number" && watches.length > 1) {
      const remaining = watches.filter((_, idx) => idx !== watchIndex);
      const next = remaining.map(watchToFormItem);
      const note =
        remaining.find(w => String(w?.note ?? "").trim())?.note ?? undefined;
      await fetch(`/api/conversations/${encodeURIComponent(convId)}/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: next,
          note
        })
      });
      await load();
      return;
    }
    await fetch(`/api/conversations/${encodeURIComponent(convId)}/watch`, { method: "DELETE" });
    await load();
  }

  async function submitCadenceResolve() {
    if (!cadenceResolveConv) return;
    if (cadenceResolution === "resume_on" && !cadenceResumeDate) {
      setCadenceResolveError("Please choose a resume date.");
      return;
    }
    if (cadenceWatchEnabled) {
      const hasModel = cadenceWatchItems.some(item => getItemModels(item).length > 0);
      if (!hasModel) {
        setCadenceResolveError("Please enter at least one model to watch.");
        return;
      }
    }
    setCadenceResolveSaving(true);
    setCadenceResolveError(null);
    try {
      const payload = {
        resolution: cadenceResolution,
        resumeDate: cadenceResolution === "resume_on" ? cadenceResumeDate : undefined,
        watch: cadenceWatchEnabled
          ? {
              note: cadenceWatchNote,
              items: expandWatchItems(cadenceWatchItems)
            }
          : undefined
      };
      const resp = await fetch(
        `/api/conversations/${encodeURIComponent(cadenceResolveConv.id)}/followup-action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );
      const data = await resp.json().catch(() => null);
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Failed to update follow-up cadence");
      }
      if (data?.notice) {
        if (cadenceResolveNoticeTimer.current) {
          clearTimeout(cadenceResolveNoticeTimer.current);
        }
        if (data.notice !== cadenceResolveNotice) {
          setCadenceResolveNotice(data.notice);
        }
        cadenceResolveNoticeTimer.current = setTimeout(() => {
          setCadenceResolveNotice(null);
          cadenceResolveNoticeTimer.current = null;
        }, 4500);
      }
      if (selectedConv?.id === cadenceResolveConv.id && data?.conversation) {
        setSelectedConv(data.conversation);
      }
      await load();
      setCadenceResolveOpen(false);
    } catch (err: any) {
      setCadenceResolveError(err?.message ?? "Failed to update follow-up cadence");
    } finally {
      setCadenceResolveSaving(false);
    }
  }

  async function updateMode(next: SystemMode) {
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next })
    });
    await load();
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const sectionParam = String(params.get("section") ?? "").trim().toLowerCase();
    const convHint = String(params.get("convId") ?? params.get("leadKey") ?? "").trim();
    const actionParam = String(params.get("action") ?? "").trim().toLowerCase();
    const hasRouteParams =
      params.has("section") || params.has("convId") || params.has("leadKey") || params.has("action");
    const allowedSections = new Set([
      "inbox",
      "todos",
      "questions",
      "suppressions",
      "contacts",
      "watches",
      "inventory",
      "campaigns",
      "settings",
      "calendar"
    ]);
    if (allowedSections.has(sectionParam)) {
      const next = sectionParam as
        | "inbox"
        | "todos"
        | "questions"
        | "suppressions"
        | "contacts"
        | "watches"
        | "inventory"
        | "campaigns"
        | "settings"
        | "calendar";
      setSection(next);
      if (
        next === "calendar" ||
        next === "settings" ||
        next === "inventory" ||
        next === "suppressions" ||
        next === "campaigns"
      ) {
        setMobilePanel("detail");
      } else {
        setMobilePanel("list");
      }
    }
    if (convHint) {
      setSection("inbox");
      setSelectedId(convHint);
      setMobilePanel("detail");
    }
    if (actionParam === "call" && convHint) {
      setSection("inbox");
      setPendingDeepLinkCallId(convHint);
    }
    if (hasRouteParams) {
      params.delete("section");
      params.delete("convId");
      params.delete("leadKey");
      params.delete("action");
      const next = `${url.pathname}${params.toString() ? `?${params.toString()}` : ""}${url.hash}`;
      window.history.replaceState({}, "", next);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadConversation(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!pendingDeepLinkCallId) return;
    if (!authUser) return;
    if (deepLinkCallInFlightRef.current) return;
    deepLinkCallInFlightRef.current = true;
    void (async () => {
      try {
        let targetId = pendingDeepLinkCallId;
        const listMatch = conversations.find(c => c.id === targetId || c.leadKey === targetId);
        if (listMatch?.id) {
          targetId = listMatch.id;
        }
        setSection("inbox");
        setSelectedId(targetId);
        setMobilePanel("detail");
        let conv = selectedConv?.id === targetId ? selectedConv : null;
        if (!conv) {
          conv = await fetchConversationDetail(targetId);
        }
        if (!conv && listMatch?.leadKey && listMatch.leadKey !== targetId) {
          conv = await fetchConversationDetail(listMatch.leadKey);
        }
        if (!conv) return;
        setSelectedConv(conv);
        if (!authUser.phone && !authUser.extension) return;
        if (authUser.phone && authUser.extension) {
          setCallPickerOpen(true);
          return;
        }
        if (authUser.extension && !authUser.phone) {
          await startCall("extension", conv);
          return;
        }
        await startCall("cell", conv);
      } finally {
        setPendingDeepLinkCallId(null);
        deepLinkCallInFlightRef.current = false;
      }
    })();
  }, [pendingDeepLinkCallId, authUser, conversations, selectedConv]);

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    loadConversationRef.current = loadConversation;
  });

  useEffect(() => {
    refreshConversationsRef.current = refreshConversations;
  });

  useEffect(() => {
    refreshSelectedRef.current = refreshSelectedConversation;
  });

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!authUser) return;
    if (typeof EventSource === "undefined") return;
    if (streamRef.current) return;

    const connect = () => {
      const es = new EventSource("/api/stream");
      streamRef.current = es;

      const refresh = () => {
        const now = Date.now();
        if (now - lastStreamRefreshRef.current < 2000) return;
        lastStreamRefreshRef.current = now;
        void refreshConversationsRef.current();
        const id = selectedIdRef.current;
        if (id) void refreshSelectedRef.current(id);
      };

      es.addEventListener("ping", refresh);
      es.onmessage = refresh;
      es.onerror = () => {
        es.close();
        if (streamRef.current === es) {
          streamRef.current = null;
        }
        setTimeout(() => {
          if (!streamRef.current && authUser) connect();
        }, 5000);
      };
    };

    connect();
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    };
  }, [authUser]);

  useEffect(() => {
    if (!authUser) return;
    const t = window.setInterval(() => {
      void refreshConversationsRef.current();
      const id = selectedIdRef.current;
      if (id) void refreshSelectedRef.current(id);
    }, 4000);
    return () => window.clearInterval(t);
  }, [authUser]);

  useEffect(() => {
    if (section !== "contacts") setSelectedContact(null);
  }, [section]);

  useEffect(() => {
    if (section !== "settings") return;
    setSettingsError(null);
    void (async () => {
      try {
        const [dealerResp, schedResp, usersResp] = await Promise.all([
          fetch("/api/dealer-profile", { cache: "no-store" }),
          fetch("/api/scheduler-config", { cache: "no-store" }),
          fetch("/api/users", { cache: "no-store" })
        ]);
        const dealerJson = await dealerResp.json();
        const schedJson = await schedResp.json();
        const usersJson = await usersResp.json();
        const profile = dealerJson?.profile ?? {};
        const followUp = profile.followUp ?? {};
        const buying = profile.buying ?? {};
        const weather = profile.weather ?? {};
        const pickupRadius = weather.pickupRadiusMiles ?? 25;
        const coldThreshold = weather.coldThresholdF ?? 50;
        const forecastHours = weather.forecastHours ?? 48;
        const buyingUsedEnabled = buying.usedBikesEnabled !== false;
        const taxRate = profile.taxRate ?? 8;
        const webSearch = profile.webSearch ?? {};
        const webSearchReferenceUrls = Array.isArray(webSearch.referenceUrls)
          ? webSearch.referenceUrls
              .map((v: any) => String(v ?? "").trim())
              .filter(Boolean)
          : [];
        const webSearchUseGooglePlacePhotos = webSearch.useGooglePlacePhotos === true;
        const webSearchGooglePlaceId = String(webSearch.googlePlaceId ?? "").trim();
        const campaign = profile.campaign ?? {};
        const campaignWebBannerWidth = Number(campaign.webBannerWidth ?? profile.webBannerWidth);
        const campaignWebBannerHeight = Number(campaign.webBannerHeight ?? profile.webBannerHeight);
        const campaignWebBannerInsetPercent = Number(
          campaign.webBannerInsetPercent ?? profile.webBannerInsetPercent
        );
        const campaignWebBannerFitRaw = String(campaign.webBannerFit ?? "").trim().toLowerCase();
        const campaignWebBannerFit =
          campaignWebBannerFitRaw === "contain" || campaignWebBannerFitRaw === "cover"
            ? campaignWebBannerFitRaw
            : "auto";
        const followUpMonths = Array.isArray(followUp.testRideMonths) ? followUp.testRideMonths : [4, 5, 6, 7, 8, 9, 10];
        setDealerProfile(profile);
        setDealerProfileForm({
          dealerName: profile.dealerName ?? "",
          agentName: profile.agentName ?? "",
          crmProvider: profile.crmProvider ?? "",
          websiteProvider: profile.websiteProvider ?? "",
          fromEmail: profile.fromEmail ?? "",
          replyToEmail: profile.replyToEmail ?? "",
          emailSignature: profile.emailSignature ?? "",
          logoUrl: profile.logoUrl ?? "",
          bookingUrl: profile.bookingUrl ?? "",
          bookingToken: profile.bookingToken ?? "",
          creditAppUrl: profile.creditAppUrl ?? "",
          lienHolderResponse:
            profile?.policies?.lienHolderResponse ??
            profile?.policies?.lienHolderText ??
            profile?.lienHolderResponse ??
            "",
          riderToRiderFinancingEnabled:
            profile?.policies?.riderToRiderFinancingEnabled === true ||
            profile?.policies?.riderToRiderFinanceEnabled === true ||
            profile?.policies?.offersRiderToRiderFinancing === true,
          phone: profile.phone ?? "",
          website: profile.website ?? "",
          addressLine1: profile.address?.line1 ?? "",
          city: profile.address?.city ?? "",
          state: profile.address?.state ?? "",
          zip: profile.address?.zip ?? "",
          testRideEnabled: followUp.testRideEnabled !== false,
          testRideMonths: followUpMonths,
          weatherPickupRadiusMiles: String(pickupRadius),
          weatherColdThresholdF: String(coldThreshold),
          weatherForecastHours: String(forecastHours),
          buyingUsedBikesEnabled: buyingUsedEnabled,
          webSearchReferenceUrls,
          webSearchUseGooglePlacePhotos,
          webSearchGooglePlaceId,
          campaignWebBannerWidth:
            Number.isFinite(campaignWebBannerWidth) && campaignWebBannerWidth > 0
              ? String(campaignWebBannerWidth)
              : "",
          campaignWebBannerHeight:
            Number.isFinite(campaignWebBannerHeight) && campaignWebBannerHeight > 0
              ? String(campaignWebBannerHeight)
              : "",
          campaignWebBannerInsetPercent:
            Number.isFinite(campaignWebBannerInsetPercent) && campaignWebBannerInsetPercent >= 0
              ? String(campaignWebBannerInsetPercent)
              : "",
          campaignWebBannerFit: campaignWebBannerFit as "auto" | "cover" | "contain",
          taxRate: String(taxRate)
        });
        setDealerHours(profile.hours ?? {});

        const cfg = schedJson?.config ?? {};
        setSchedulerConfig(cfg);
        setSchedulerForm({
          timezone: cfg.timezone ?? "America/New_York",
          assignmentMode: cfg.assignmentMode ?? "preferred",
          minLeadTimeHours: String(cfg.minLeadTimeHours ?? 4),
          minGapBetweenAppointmentsMinutes: String(cfg.minGapBetweenAppointmentsMinutes ?? 60),
          weekdayEarliest: cfg.bookingWindows?.weekday?.earliestStart ?? "09:30",
          weekdayLatest: cfg.bookingWindows?.weekday?.latestStart ?? "17:00",
          saturdayEarliest: cfg.bookingWindows?.saturday?.earliestStart ?? "09:30",
          saturdayLatest: cfg.bookingWindows?.saturday?.latestStart ?? "14:00"
        });
        setSchedulerHours(cfg.businessHours ?? {});
        setSalespeopleList(cfg.salespeople ?? []);
        setAvailabilityBlocks(cfg.availabilityBlocks ?? {});
        setPreferredOrderIds(cfg.preferredSalespeople ?? []);
        setUsersList((usersJson?.users ?? []).map(normalizeUserRow));
        const at = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
        setAppointmentTypesList(
          Object.entries(at).map(([key, val]: any) => ({
            key,
            durationMinutes: String(val?.durationMinutes ?? 60),
            colorId: val?.colorId ? String(val.colorId) : ""
          }))
        );
        const firstSp =
          (usersJson?.users ?? []).find((u: any) => u.role === "salesperson")?.id ??
          (cfg.salespeople ?? [])[0]?.id;
        setBlockForm(prev => ({ ...prev, salespersonId: prev.salespersonId || firstSp || "" }));
      } catch (err: any) {
        setSettingsError(err?.message ?? "Failed to load settings");
      }
    })();
  }, [section]);

  useEffect(() => {
    if (!dealerProfileForm.bookingToken) return;
    if (dealerProfileForm.bookingUrl) return;
    if (typeof window === "undefined") return;
    const token = dealerProfileForm.bookingToken.trim();
    if (!token) return;
    const url = `${window.location.origin}/book?token=${encodeURIComponent(token)}`;
    setDealerProfileForm(prev => (prev.bookingUrl ? prev : { ...prev, bookingUrl: url }));
  }, [dealerProfileForm.bookingToken, dealerProfileForm.bookingUrl]);

  const calendarUsers = useMemo(
    () => (usersList ?? []).filter((u: any) => !!u.calendarId),
    [usersList]
  );

  useEffect(() => {
    if (section !== "calendar") return;
    if (schedulerConfig) return;
    void (async () => {
      try {
        const resp = await fetch("/api/scheduler-config", { cache: "no-store" });
        const json = await resp.json();
        const cfg = json?.config ?? {};
        setSchedulerConfig(cfg);
        if (!calendarSalespeople.length && calendarUsers.length) {
          setCalendarSalespeople(calendarUsers.map(u => u.id));
        }
      } catch {
        // ignore
      }
    })();
  }, [section, schedulerConfig, calendarSalespeople.length, calendarUsers]);

  useEffect(() => {
    if (section !== "calendar") return;
    if (usersList.length) return;
    void (async () => {
      try {
        const resp = await fetch("/api/users", { cache: "no-store" });
        const json = await resp.json();
        setUsersList((json?.users ?? []).map(normalizeUserRow));
      } catch {
        // ignore
      }
    })();
  }, [section, usersList.length]);

  useEffect(() => {
    if (section !== "calendar") return;
    if (calendarSalespeople.length) return;
    if (!calendarUsers.length) return;
    setCalendarSalespeople(calendarUsers.map(u => u.id));
  }, [section, calendarSalespeople.length, calendarUsers]);

  useEffect(() => {
    if (section !== "calendar") return;
    if (!schedulerConfig?.timezone) return;
    const loadEvents = async () => {
      setCalendarLoading(true);
      try {
        const start = new Date(calendarDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        if (calendarView === "week") {
          end.setDate(end.getDate() + 7);
        } else {
          end.setDate(end.getDate() + 1);
        }
        const params = new URLSearchParams();
        params.set("start", start.toISOString());
        params.set("end", end.toISOString());
        if (calendarSalespeople.length) {
          params.set("userIds", calendarSalespeople.join(","));
        }
        const resp = await fetch(`/api/calendar/events?${params.toString()}`, { cache: "no-store" });
        const json = await resp.json();
        setCalendarEvents(buildCalendarEvents(json));
      } catch {
        setCalendarEvents([]);
      } finally {
        setCalendarLoading(false);
      }
    };
    void loadEvents();
  }, [section, schedulerConfig, calendarDate, calendarView, calendarSalespeople]);

  useEffect(() => {
    if (section !== "calendar" && !(section === "settings" && settingsTab === "notifications")) return;
    void (async () => {
      try {
        const resp = await fetch("/api/google/status", { cache: "no-store" });
        const json = await resp.json();
        if (json?.ok && typeof json.connected === "boolean") {
          setGoogleStatus({ connected: json.connected, reason: json.reason, error: json.error });
        } else {
          setGoogleStatus(null);
        }
      } catch {
        setGoogleStatus(null);
      }
    })();
  }, [section, settingsTab]);

  useEffect(() => {
    if (!manualApptOpen) return;
    if (schedulerConfig && salespeopleList.length) return;
    void (async () => {
      try {
        const resp = await fetch("/api/scheduler-config", { cache: "no-store" });
        const json = await resp.json();
        const cfg = json?.config ?? {};
        setSchedulerConfig(cfg);
        setSalespeopleList(cfg.salespeople ?? []);
        const at = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
        setAppointmentTypesList(
          Object.entries(at).map(([key, val]: any) => ({
            key,
            durationMinutes: String(val?.durationMinutes ?? 60),
            colorId: val?.colorId ? String(val.colorId) : ""
          }))
        );
      } catch {
        // ignore
      }
    })();
  }, [manualApptOpen, schedulerConfig, salespeopleList.length]);

  const defaultAppointmentTypes = [
    "inventory_visit",
    "test_ride",
    "trade_appraisal",
    "finance_discussion"
  ];
  const manualAppointmentTypes = useMemo(() => {
    const byKey = new Map<string, { key: string; durationMinutes: string; colorId?: string }>();
    appointmentTypesList.forEach(row => {
      const key = row.key.trim();
      if (!key) return;
      byKey.set(key, row);
    });
    defaultAppointmentTypes.forEach(key => {
      if (!byKey.has(key)) {
        byKey.set(key, { key, durationMinutes: "60", colorId: "" });
      }
    });
    return Array.from(byKey.values());
  }, [appointmentTypesList, defaultAppointmentTypes]);

  useEffect(() => {
    if (!manualApptOpen) return;
    if (!selectedConv) return;
    if (!salespeopleList.length) return;
    if (!manualApptForm.salespersonId) {
      const fallbackId = resolveDefaultSalespersonId();
      if (fallbackId) {
        setManualApptForm(prev => ({ ...prev, salespersonId: fallbackId }));
      }
    }
    if (manualApptForm.appointmentType && manualAppointmentTypes.some(row => row.key === manualApptForm.appointmentType)) {
      return;
    }
    const inferred = inferAppointmentTypeForConv(selectedConv);
    const nextType = manualAppointmentTypes.some(row => row.key === inferred)
      ? inferred
      : manualAppointmentTypes[0]?.key ?? "inventory_visit";
    setManualApptForm(prev => ({ ...prev, appointmentType: nextType }));
  }, [
    manualApptOpen,
    selectedConv,
    salespeopleList.length,
    manualApptForm.salespersonId,
    manualApptForm.appointmentType,
    manualAppointmentTypes
  ]);

  async function saveInventoryNote(stockId?: string, vin?: string) {
    const key = String(stockId ?? vin ?? "").trim().toLowerCase();
    if (!key) return;
    setInventorySaving(key);
    try {
      const notes = Array.isArray(inventoryNotes[key]) ? inventoryNotes[key] : [];
      const resp = await fetch("/api/inventory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stockId, vin, notes })
      });
      const json = await resp.json();
      if (!resp.ok || json?.ok === false) {
        throw new Error(json?.error ?? "Failed to save note");
      }
      setInventoryItems(prev =>
        prev.map(it => {
          const k = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
          if (k !== key) return it;
          return { ...it, notes };
        })
      );
      setSaveToast("Inventory note saved");
      setTimeout(() => setSaveToast(null), 2000);
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to save note");
    } finally {
      setInventorySaving(null);
    }
  }

  useEffect(() => {
    if (section !== "inventory") return;
    if (inventoryItems.length) return;
    void (async () => {
      setInventoryLoading(true);
      try {
        const resp = await fetch("/api/inventory", { cache: "no-store" });
        const json = await resp.json();
        const items = Array.isArray(json?.items) ? json.items : [];
        setInventoryItems(items);
        const noteMap: Record<string, any[]> = {};
        items.forEach((it: any) => {
          const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
          if (key) noteMap[key] = Array.isArray(it.notes) ? it.notes : [];
        });
        setInventoryNotes(noteMap);
      } catch {
        setInventoryItems([]);
      } finally {
        setInventoryLoading(false);
      }
    })();
  }, [section, inventoryItems.length]);

  useEffect(() => {
    if (!calendarEdit) return;
    const tz = schedulerConfig?.timezone ?? "America/New_York";
    const startIso = calendarEdit.start ?? "";
    const endIso = calendarEdit.end ?? "";
    const start = startIso ? new Date(startIso) : null;
    const end = endIso ? new Date(endIso) : null;
    const toTzParts = (d: Date | null) => {
      if (!d) return null;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).formatToParts(d);
      const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
      return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        time: `${get("hour")}:${get("minute")}`
      };
    };
    const minutesToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const localDay = calendarDate.toLocaleDateString("en-CA", { timeZone: tz });
    const dragStart = typeof calendarEdit._dragStart === "number" ? calendarEdit._dragStart : null;
    const dragEnd = typeof calendarEdit._dragEnd === "number" ? calendarEdit._dragEnd : null;
    const startParts = dragStart != null ? { date: localDay, time: minutesToTime(dragStart) } : toTzParts(start);
    const endParts = dragEnd != null ? { date: localDay, time: minutesToTime(dragEnd) } : toTzParts(end);
    setCalendarEditForm({
      summary: calendarEdit.summary ?? "",
      startDate: startParts?.date ?? "",
      startTime: startParts?.time ?? "",
      endDate: endParts?.date ?? "",
      endTime: endParts?.time ?? "",
      status: "scheduled",
      reason: "",
      colorId: calendarEdit.colorId ?? ""
    });
    if (calendarEdit.calendarId) {
      const sp = calendarUsers.find((u: any) => u.calendarId === calendarEdit.calendarId) ??
        calendarUsers.find((u: any) => u.id === calendarEdit.salespersonId);
      setCalendarEditSalespersonId(sp?.id ?? "");
    }
  }, [calendarEdit, calendarDate, schedulerConfig?.timezone, calendarUsers]);

  useEffect(() => {
    if (!selectedContact) return;
    setContactEdit(false);
    setContactForm({
      firstName: selectedContact.firstName ?? "",
      lastName: selectedContact.lastName ?? "",
      name: selectedContact.name ?? "",
      email: selectedContact.email ?? "",
      phone: selectedContact.phone ?? ""
    });
  }, [selectedContact?.id]);

  const selectedContactList = useMemo(
    () => contactLists.find(l => l.id === selectedContactListId) ?? null,
    [contactLists, selectedContactListId]
  );

  useEffect(() => {
    const list = contactLists.find(l => l.id === selectedContactListId) ?? null;
    setContactListFilterForm({
      condition: list?.filter?.condition ?? "",
      year: list?.filter?.year ?? "",
      make: list?.filter?.make ?? "",
      model: list?.filter?.model ?? ""
    });
  }, [selectedContactListId, contactLists]);

  useEffect(() => {
    if (selectedContactListId === "all") return;
    if (!selectedContact) return;
    const idSet = new Set((selectedContactList?.contactIds ?? []).map(v => String(v)));
    if (!idSet.has(String(selectedContact.id))) {
      setSelectedContact(null);
    }
  }, [selectedContactListId, selectedContact?.id, selectedContactList?.contactIds?.join("|")]);

  const isManager = authUser?.role === "manager";
  const isDepartmentUser =
    authUser?.role === "service" || authUser?.role === "parts" || authUser?.role === "apparel";
  const isConversationSection =
    section === "inbox" ||
    section === "todos" ||
    section === "questions" ||
    section === "watches" ||
    section === "contacts";
  const getSectionTitle = () =>
    section === "inbox"
      ? "Inbox"
      : section === "todos"
        ? "Task Inbox"
        : section === "questions"
          ? "Follow-up Schedule"
        : section === "contacts"
          ? "Contacts"
          : section === "inventory"
            ? "Inventory"
            : section === "watches"
              ? "Vehicle Watches"
              : section === "campaigns"
                ? "Campaign Studio"
              : section === "kpi"
                ? "KPI Overview"
              : section === "calendar"
                ? "Calendar"
                : section === "settings"
                  ? "Settings"
                  : "Suppression List";
  const getSectionSubTitle = () =>
    section === "inbox"
      ? `${conversations.length} conversations`
      : section === "todos"
        ? `${todos.length} open`
        : section === "questions"
          ? `${cadenceAlerts.length} scheduled`
        : section === "contacts"
          ? `${contacts.length} contacts`
          : section === "inventory"
            ? `${inventoryItems.length} bikes`
            : section === "watches"
              ? `${visibleWatchItems.length} active`
              : section === "campaigns"
                ? `${campaigns.length} campaigns`
              : section === "kpi"
                ? "Manager analytics"
              : section === "calendar"
                ? "Google Calendar view"
                : section === "settings"
                  ? "Configure dealer & scheduling"
                  : `${suppressions.length} suppressed`;

  useEffect(() => {
    if (!selectedId) setMobilePanel("list");
  }, [selectedId]);

  useEffect(() => {
    if (
      section === "calendar" ||
      section === "settings" ||
      section === "inventory" ||
      section === "suppressions" ||
      section === "campaigns" ||
      section === "kpi"
    ) {
      setMobilePanel("detail");
      return;
    }
    setMobilePanel("list");
  }, [section]);

  useEffect(() => {
    if (!isDepartmentUser) return;
    if (section !== "inbox" && section !== "todos") {
      setSection("inbox");
      setMobilePanel("list");
    }
  }, [isDepartmentUser, section]);

  useEffect(() => {
    if ((section === "kpi" || section === "campaigns") && !isManager) {
      setSection("inbox");
      setMobilePanel("list");
    }
  }, [section, isManager]);

  useEffect(() => {
    if (!isManager || section !== "kpi") return;
    void loadKpiOverview();
  }, [section, isManager, kpiSourceFilter, kpiLeadTypeFilter, kpiLeadScopeFilter, kpiOwnerFilter, kpiFrom, kpiTo]);

  useEffect(() => {
    if (!isManager || section !== "campaigns") return;
    void loadCampaigns();
    void loadMetaStatus();
  }, [section, isManager]);

  function openConversation(id: string) {
    setSelectedId(id);
    setMobilePanel("detail");
  }

  function goToSection(
    next:
      | "inbox"
      | "todos"
      | "questions"
      | "suppressions"
      | "contacts"
      | "watches"
      | "inventory"
      | "campaigns"
      | "kpi"
      | "settings"
      | "calendar"
  ) {
    const target = isDepartmentUser && next !== "inbox" && next !== "todos" ? "inbox" : next;
    setSection(target);
    setMobileNavOpen(false);
    if (
      target === "calendar" ||
      target === "settings" ||
      target === "inventory" ||
      target === "suppressions" ||
      target === "campaigns" ||
      target === "kpi"
    ) {
      setMobilePanel("detail");
    } else {
      setMobilePanel("list");
    }
  }

  const watchSalespeople = useMemo(() => {
    const fromUsers = (usersList ?? [])
      .filter((u: any) => u.role === "salesperson")
      .map((u: any) => ({
        id: u.id,
        name:
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.name ||
          u.email ||
          u.id
      }));
    const fromScheduler = (salespeopleList ?? []).map(sp => ({
      id: sp.id,
      name: sp.name || sp.id
    }));
    const merged = new Map<string, { id: string; name: string }>();
    fromScheduler.forEach(sp => merged.set(sp.id, sp));
    fromUsers.forEach(sp => merged.set(sp.id, sp));
    return Array.from(merged.values());
  }, [usersList, salespeopleList]);

  const reassignSalesOwnerOptions = useMemo(() => {
    const options = (usersList ?? [])
      .filter((u: any) => {
        const role = String(u?.role ?? "").trim().toLowerCase();
        if (role === "service" || role === "parts" || role === "apparel") return false;
        return true;
      })
      .map((u: any) => {
        const name =
          [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() ||
          String(u?.name ?? "").trim() ||
          String(u?.email ?? "").trim() ||
          String(u?.id ?? "").trim();
        return {
          id: String(u?.id ?? "").trim(),
          name
        };
      })
      .filter((u: any) => !!u.id && !!u.name);
    for (const conv of conversations ?? []) {
      const ownerId = String(conv?.leadOwner?.id ?? "").trim();
      const ownerName = String(conv?.leadOwner?.name ?? "").trim();
      if (!ownerId || !ownerName) continue;
      const lowered = ownerName.toLowerCase();
      if (
        lowered.includes("service department") ||
        lowered.includes("parts department") ||
        lowered.includes("apparel department")
      ) {
        continue;
      }
      options.push({ id: ownerId, name: ownerName });
    }
    const deduped = new Map<string, { id: string; name: string }>();
    for (const item of options) {
      if (!deduped.has(item.id)) deduped.set(item.id, item);
    }
    return Array.from(deduped.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
    );
  }, [usersList, conversations]);

  const departmentOwnerByRole = useMemo(() => {
    const empty = {
      service: null as { id: string; name: string } | null,
      parts: null as { id: string; name: string } | null,
      apparel: null as { id: string; name: string } | null
    };
    for (const raw of usersList ?? []) {
      const role = String(raw?.role ?? "").trim().toLowerCase();
      if (role !== "service" && role !== "parts" && role !== "apparel") continue;
      if (empty[role]) continue;
      const id = String(raw?.id ?? "").trim();
      const name =
        [raw?.firstName, raw?.lastName].filter(Boolean).join(" ").trim() ||
        String(raw?.name ?? "").trim() ||
        String(raw?.email ?? "").trim() ||
        `${role[0].toUpperCase()}${role.slice(1)} Department`;
      empty[role] = {
        id,
        name
      };
    }
    return empty;
  }, [usersList]);

  const ownerDirectory = useMemo(() => {
    const normalize = (v: string) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const byId = new Map<string, { name: string; role: string }>();
    const byExact = new Map<string, string>();
    const byFirst = new Map<string, Set<string>>();
    const addFirst = (firstRaw: string, name: string) => {
      const key = normalize(firstRaw);
      if (!key) return;
      if (!byFirst.has(key)) byFirst.set(key, new Set<string>());
      byFirst.get(key)?.add(name);
    };
    for (const user of usersList ?? []) {
      const first = String(user?.firstName ?? "").trim();
      const last = String(user?.lastName ?? "").trim();
      const name =
        [first, last].filter(Boolean).join(" ").trim() ||
        String(user?.name ?? "").trim() ||
        String(user?.email ?? "").trim() ||
        String(user?.id ?? "").trim();
      if (!name) continue;
      const role = String(user?.role ?? "").toLowerCase();
      const id = String(user?.id ?? "").trim();
      if (id) byId.set(id, { name, role });
      const exact = normalize(name);
      if (exact && !byExact.has(exact)) byExact.set(exact, name);
      addFirst(first || name.split(/\s+/)[0] || "", name);
    }
    return { normalize, byId, byExact, byFirst };
  }, [usersList]);

  const canonicalizeOwnerName = useCallback(
    (rawName: string, ownerId?: string | null): string => {
      const normalize = ownerDirectory.normalize;
      const id = String(ownerId ?? "").trim();
      if (id && ownerDirectory.byId.has(id)) {
        return ownerDirectory.byId.get(id)?.name ?? String(rawName ?? "").trim();
      }
      const name = String(rawName ?? "").trim();
      if (!name) return "";
      const exact = normalize(name);
      if (exact && ownerDirectory.byExact.has(exact)) {
        return ownerDirectory.byExact.get(exact) ?? name;
      }
      if (exact.length >= 3) {
        const exactFirst = ownerDirectory.byFirst.get(exact);
        if (exactFirst && exactFirst.size === 1) return Array.from(exactFirst)[0];
        const prefixMatches = new Set<string>();
        for (const [first, names] of ownerDirectory.byFirst.entries()) {
          if (first.startsWith(exact)) {
            for (const n of names) prefixMatches.add(n);
          }
        }
        if (prefixMatches.size === 1) return Array.from(prefixMatches)[0];
      }
      return name;
    },
    [ownerDirectory]
  );

  const inferOwnerDepartment = useCallback(
    (ownerNameRaw: string, ownerId?: string | null): "service" | "parts" | "apparel" | null => {
      const byIdHit = String(ownerId ?? "").trim();
      if (byIdHit && ownerDirectory.byId.has(byIdHit)) {
        const role = String(ownerDirectory.byId.get(byIdHit)?.role ?? "").toLowerCase();
        if (role === "service" || role === "parts" || role === "apparel") {
          return role as "service" | "parts" | "apparel";
        }
      }
      const name = String(ownerNameRaw ?? "").trim().toLowerCase();
      if (!name) return null;
      if (/\bservice\b/.test(name)) return "service";
      if (/\bparts\b/.test(name)) return "parts";
      if (/\bapparel\b/.test(name)) return "apparel";
      return null;
    },
    [ownerDirectory]
  );

  const inferDepartmentFromText = useCallback(
    (raw: string): "service" | "parts" | "apparel" | null => {
      const text = String(raw ?? "").trim().toLowerCase();
      if (!text) return null;
      if (/\bservice\b/.test(text)) return "service";
      if (/\bparts\b/.test(text)) return "parts";
      if (/\bapparel\b/.test(text)) return "apparel";
      return null;
    },
    []
  );

  const inferTodoDepartment = useCallback(
    (todo: TodoItem): "service" | "parts" | "apparel" | null => {
      const reason = String(todo.reason ?? "").toLowerCase();
      if (reason === "service" || reason === "parts" || reason === "apparel") {
        return reason as "service" | "parts" | "apparel";
      }
      const fromDepartmentOwner = inferDepartmentFromText(String(todo.departmentOwnerName ?? ""));
      if (fromDepartmentOwner) return fromDepartmentOwner;
      const ownerType = String(todo.ownerDisplayType ?? "").toLowerCase();
      if (ownerType === "department_owner" || ownerType === "department") {
        const fromDisplay = inferDepartmentFromText(
          String(todo.ownerDisplayName ?? todo.ownerName ?? "")
        );
        if (fromDisplay) return fromDisplay;
      }
      const fromDisplayFallback = inferDepartmentFromText(
        String(todo.ownerDisplayName ?? todo.ownerName ?? "")
      );
      if (fromDisplayFallback) return fromDisplayFallback;
      return null;
    },
    [inferDepartmentFromText]
  );

  const managerLeadOwnerOptions = useMemo(() => {
    const byName = new Map<string, string>();
    const addName = (raw: string, ownerId?: string | null) => {
      const name = canonicalizeOwnerName(raw, ownerId);
      if (!name) return;
      const key = name.toLowerCase();
      if (!byName.has(key)) byName.set(key, name);
    };
    for (const c of conversations) {
      const departmentOwner = inferOwnerDepartment(
        String(c.leadOwner?.name ?? "").trim(),
        String(c.leadOwner?.id ?? "").trim()
      );
      if (departmentOwner) continue;
      addName(String(c.leadOwner?.name ?? ""), c.leadOwner?.id);
    }
    for (const t of todos) {
      const departmentOwner = inferOwnerDepartment(String(t.leadOwnerName ?? "").trim());
      if (departmentOwner) continue;
      addName(String(t.leadOwnerName ?? ""));
    }
    for (const u of usersList ?? []) {
      const role = String(u?.role ?? "").toLowerCase();
      if (role !== "salesperson" && role !== "manager") continue;
      const fullName =
        [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() ||
        String(u?.name ?? "").trim();
      addName(fullName, String(u?.id ?? ""));
    }
    return Array.from(byName.values()).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
    );
  }, [conversations, todos, usersList, canonicalizeOwnerName, inferOwnerDepartment]);

  const conversationsById = useMemo(() => {
    const byId = new Map<string, ConversationListItem>();
    for (const c of conversations) byId.set(c.id, c);
    return byId;
  }, [conversations]);

  const {
    filteredTodos,
    groupedTodos,
    todoSectionDefs
  } = useTaskInboxData({
    todos,
    todoQuery,
    isManager,
    todoLeadOwnerFilter,
    todoTaskTypeFilter,
    canonicalizeOwnerName,
    inferOwnerDepartment,
    inferTodoDepartment,
    todoInboxSection
  });

  useEffect(() => {
    if (blockForm.salespersonId) return;
    const first = usersList.find(
      u => u.role === "salesperson" || (u.role === "manager" && u.includeInSchedule)
    )?.id;
    if (first) setBlockForm(prev => ({ ...prev, salespersonId: first }));
  }, [blockForm.salespersonId, usersList]);

  useEffect(() => {
    if (!editingUserId) return;
    setBlockForm(prev => ({ ...prev, salespersonId: editingUserId }));
  }, [editingUserId]);

  useEffect(() => {
    if (!saveToast) return;
    const t = setTimeout(() => setSaveToast(null), 2000);
    return () => clearTimeout(t);
  }, [saveToast]);
  useEffect(() => {
    if (authUser?.phone) {
      setCallMethod("cell");
    } else if (authUser?.extension) {
      setCallMethod("extension");
    }
  }, [authUser?.phone, authUser?.extension]);
  useEffect(() => {
    setOutcomeNoteOpen(false);
  }, [selectedConv?.id]);

  const pendingDraft = useMemo(() => {
    if (!selectedConv) return null;
    let lastDraftIdx = -1;
    let lastSentIdx = -1;
    for (let i = 0; i < selectedConv.messages.length; i++) {
      const m = selectedConv.messages[i];
      if (m.direction !== "out") continue;
      if (m.provider === "draft_ai" && m.draftStatus !== "stale") lastDraftIdx = i;
      if (m.provider === "human" || m.provider === "twilio") lastSentIdx = i;
    }
    if (lastDraftIdx > lastSentIdx) return selectedConv.messages[lastDraftIdx];
    return null;
  }, [selectedConv]);
  const callSummaryLookup = useMemo(() => {
    if (!selectedConv) {
      return { full: [] as any[], byId: new Map<string, string>(), indexById: new Map<string, number>() };
    }
    const full = selectedConv.messages ?? [];
    const byId = new Map<string, string>();
    const indexById = new Map<string, number>();
    for (let i = 0; i < full.length; i += 1) {
      const msg = full[i];
      indexById.set(msg.id, i);
      if (msg.provider === "voice_summary" && msg.providerMessageId) {
        byId.set(msg.providerMessageId, msg.body ?? "");
      }
    }
    return { full, byId, indexById };
  }, [selectedConv]);
  const emailDraft = useMemo(() => {
    return (selectedConv as any)?.emailDraft ?? null;
  }, [selectedConv]);
  const hasClearableDraft = useMemo(() => {
    if (messageFilter === "email") return !!emailDraft;
    if (messageFilter === "sms") return !!pendingDraft;
    return false;
  }, [messageFilter, emailDraft, pendingDraft?.id]);
  const filteredMessages = useMemo(() => {
    if (!selectedConv) return [] as Message[];
    return (selectedConv.messages ?? [])
      .filter(m => m.draftStatus !== "stale")
      .filter(m => {
        const provider = m.provider ?? "";
        const isEmail = provider === "sendgrid";
        const isCall =
          provider === "voice_call" ||
          provider === "voice_transcript" ||
          provider === "voice_summary";
        const isSms =
          provider === "twilio" ||
          provider === "human" ||
          provider === "draft_ai" ||
          provider === "sendgrid_adf";
        if (messageFilter === "email") return isEmail;
        if (messageFilter === "calls") return isCall && provider !== "voice_summary";
        return isSms;
      });
  }, [selectedConv, messageFilter]);
  const selectedListItem = useMemo(() => {
    if (!selectedId && !selectedConv?.id && !selectedConv?.leadKey) return null;
    return (
      conversations.find(
        c =>
          c.id === selectedId ||
          c.leadKey === selectedId ||
          c.id === selectedConv?.id ||
          c.leadKey === selectedConv?.id ||
          c.id === selectedConv?.leadKey ||
          c.leadKey === selectedConv?.leadKey
      ) ?? null
    );
  }, [conversations, selectedId, selectedConv?.id, selectedConv?.leadKey]);
  const isNoCustomerReplyManualHandoff = (followUp?: { mode?: string; reason?: string } | null) => {
    const mode = String(followUp?.mode ?? "").trim().toLowerCase();
    const reason = String(followUp?.reason ?? "").trim().toLowerCase();
    if (mode !== "manual_handoff") return false;
    return (
      reason.includes("dealer_ride_no_purchase") ||
      reason === "call_only" ||
      reason === "marketplace_relay"
    );
  };
  const inboundProcessing = useMemo(() => {
    if (!selectedConv || mode !== "suggest" || selectedConv.mode === "human") return false;
    const messages = selectedConv.messages ?? [];
    if (!messages.length) return false;
    const lastInbound = [...messages]
      .reverse()
      .find(
        m =>
          m.direction === "in" &&
          (m.provider === "twilio" || m.provider === "sendgrid" || m.provider === "sendgrid_adf")
      );
    if (!lastInbound?.at) return false;
    if (
      String(lastInbound.provider ?? "").toLowerCase() === "sendgrid_adf" &&
      isNoCustomerReplyManualHandoff(selectedConv.followUp ?? null)
    ) {
      return false;
    }
    if (isShortAckNoActionText(lastInbound.body ?? "")) return false;
    const lastInboundAt = new Date(lastInbound.at).getTime();
    if (!Number.isFinite(lastInboundAt)) return false;
    // Don't show "thinking" indefinitely when AI intentionally chooses no response.
    if (Date.now() - lastInboundAt > 90 * 1000) return false;
    const lastOutboundAfterInbound = [...messages]
      .reverse()
      .find(m => m.direction === "out" && new Date(m.at).getTime() >= lastInboundAt);
    if (lastOutboundAfterInbound) return false;
    return true;
  }, [selectedConv, mode]);
  const inboundProcessingFromList = useMemo(() => {
    if (mode !== "suggest") return false;
    if (selectedConv?.mode === "human") return false;
    if (!selectedListItem) return false;
    if (selectedListItem.lastMessage?.direction !== "in") return false;
    if (
      String(selectedListItem.lastMessage?.provider ?? "").toLowerCase() === "sendgrid_adf" &&
      isNoCustomerReplyManualHandoff(selectedListItem.followUp ?? null)
    ) {
      return false;
    }
    if (isShortAckNoActionText(selectedListItem.lastMessage?.body ?? "")) return false;
    const listUpdatedAt = Date.parse(String(selectedListItem.updatedAt ?? ""));
    const detailUpdatedAt = Date.parse(String(selectedConv?.updatedAt ?? ""));
    if (!Number.isFinite(listUpdatedAt)) return false;
    if (Date.now() - listUpdatedAt > 90 * 1000) return false;
    if (!Number.isFinite(detailUpdatedAt)) return true;
    return listUpdatedAt > detailUpdatedAt;
  }, [mode, selectedConv?.mode, selectedConv?.updatedAt, selectedListItem]);
  const appointmentSalespersonName = useMemo(() => {
    const id = selectedConv?.appointment?.bookedSalespersonId ?? "";
    if (!id) return "";
    return (
      salespeopleList.find(sp => sp.id === id)?.name ||
      usersList.find(u => u.id === id)?.name ||
      ""
    );
  }, [selectedConv?.appointment?.bookedSalespersonId, salespeopleList, usersList]);
  const headerAppointment = useMemo(() => {
    const appt = selectedConv?.appointment;
    if (!appt) return null;
    const status = String(appt.status ?? "").trim().toLowerCase();
    if (status !== "confirmed") return null;
    const whenIso = String(appt.whenIso ?? "").trim();
    if (!whenIso) return null;
    const when = new Date(whenIso);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now()) return null;
    const whenText = when.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
    return {
      whenText,
      bookedEventLink: appt.bookedEventLink ?? null
    };
  }, [
    selectedConv?.appointment?.status,
    selectedConv?.appointment?.whenIso,
    selectedConv?.appointment?.bookedEventLink
  ]);
  const soldByOptions = useMemo(() => {
    const fromScheduler = (salespeopleList ?? []).map(sp => {
      const name = sp.name || "";
      const first = name.trim().split(/\s+/).filter(Boolean)[0] || "";
      return { id: sp.id, name, firstName: first };
    });
    const fromUsers = (usersList ?? [])
      .filter((u: any) => u.role === "salesperson" || (u.role === "manager" && u.includeInSchedule))
      .map((u: any) => {
        const name =
          [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name || u.email || u.id;
        const first =
          String(u.firstName ?? "").trim() ||
          String(u.name ?? "").trim().split(/\s+/).filter(Boolean)[0] ||
          "";
        return { id: u.id, name, firstName: first };
      });
    const source = fromUsers.length ? fromUsers : fromScheduler;
    const deduped = new Map<string, { id: string; name: string; firstName?: string }>();
    source.forEach(sp => {
      if (sp?.id && !deduped.has(sp.id)) {
        deduped.set(sp.id, { id: sp.id, name: sp.name, firstName: sp.firstName });
      }
    });
    return Array.from(deduped.values());
  }, [salespeopleList, usersList]);
  useEffect(() => {
    if (closeReason !== "sold") return;
    if (soldByOptions.length) return;
    void reloadUsers();
    if (!salespeopleList.length) {
      void (async () => {
        try {
          const resp = await fetch("/api/scheduler-config", { cache: "no-store" });
          const json = await resp.json();
          const cfg = json?.config ?? {};
          if (Array.isArray(cfg.salespeople)) {
            setSalespeopleList(cfg.salespeople);
          }
        } catch {
          // ignore
        }
      })();
    }
  }, [closeReason, soldByOptions.length, salespeopleList.length]);
  useEffect(() => {
    if (section !== "watches") return;
    if (!isManager) return;
    if (watchSalespeople.length) return;
    void reloadUsers();
  }, [section, isManager, watchSalespeople.length]);
  useEffect(() => {
    if (!selectedConv || closeReason !== "sold") return;
    if (soldById) return;
    const existing = selectedConv.sale?.soldById;
    if (existing) {
      setSoldById(existing);
      return;
    }
    if (authUser?.id && soldByOptions.some(sp => sp.id === authUser.id)) {
      setSoldById(authUser.id);
      return;
    }
    const apptSp = selectedConv.appointment?.bookedSalespersonId;
    if (apptSp && soldByOptions.some(sp => sp.id === apptSp)) {
      setSoldById(apptSp);
      return;
    }
    if (soldByOptions.length === 1) {
      setSoldById(soldByOptions[0].id);
    }
  }, [selectedConv, closeReason, soldById, authUser?.id, soldByOptions]);
  const cadenceAlert = useMemo(() => {
    if (!selectedConv) return null;
    const listItem = conversations.find(
      c =>
        c.id === selectedConv.id ||
        c.leadKey === selectedConv.id ||
        c.id === selectedConv.leadKey ||
        c.leadKey === selectedConv.leadKey
    );
    const cadence = selectedConv.followUpCadence ?? listItem?.followUpCadence ?? undefined;
    return getCadenceAlert(cadence);
  }, [selectedConv, conversations]);
  const selectedCadence = useMemo(() => {
    if (!selectedConv) return null;
    const listItem = conversations.find(
      c =>
        c.id === selectedConv.id ||
        c.leadKey === selectedConv.id ||
        c.id === selectedConv.leadKey ||
        c.leadKey === selectedConv.leadKey
    );
    return selectedConv.followUpCadence ?? listItem?.followUpCadence ?? null;
  }, [selectedConv, conversations]);
  const cadenceAlerts = useMemo(() => {
    const alerts = conversations
      .map(c => {
        const alert = getCadenceAlert(c.followUpCadence ?? undefined);
        if (!alert) return null;
        return {
          convId: c.id,
          leadKey: c.leadKey,
          leadName: c.leadName ?? null,
          sendAt: alert.sendAt
        };
      })
      .filter(Boolean) as Array<{
      convId: string;
      leadKey: string;
      leadName: string | null;
      sendAt: Date;
    }>;
    return alerts.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
  }, [conversations]);
  const crmAlerts = useMemo(() => {
    return questions.filter(q => {
      const type = (q.type ?? "").toLowerCase();
      if (type === "crm") return true;
      const text = (q.text ?? "").toLowerCase();
      return text.includes("tlp log failed") || text.includes("crm");
    });
  }, [questions]);
  const hasNotifications = useMemo(() => {
    const googleAlert = googleStatus ? !googleStatus.connected : false;
    return googleAlert || crmAlerts.length > 0;
  }, [googleStatus, crmAlerts.length]);
  const watchItems = useMemo(() => {
    return conversations.flatMap(conv => {
      const watches =
        conv.inventoryWatches && conv.inventoryWatches.length
          ? conv.inventoryWatches
          : conv.inventoryWatch
            ? [conv.inventoryWatch]
            : [];
      const activeWatches = watches.filter(w => (w?.status ?? "active") !== "paused");
      if (!activeWatches.length) return [];
      return [
        {
          key: conv.id,
          convId: conv.id,
          leadKey: conv.leadKey,
          leadName: conv.leadName ?? null,
          ownerId:
            conv.scheduler?.preferredSalespersonId ??
            (conv as any)?.leadOwner?.id ??
            null,
          ownerName:
            conv.scheduler?.preferredSalespersonName ??
            (conv as any)?.leadOwner?.name ??
            null,
          watches: activeWatches
        }
      ];
    });
  }, [conversations]);
  const activeWatchItems = useMemo(() => watchItems, [watchItems]);
  const watchCount = useMemo(() => {
    if (isManager) return activeWatchItems.length;
    const userId = authUser?.id;
    if (!userId) return 0;
    return activeWatchItems.filter(item => item.ownerId === userId).length;
  }, [activeWatchItems, authUser?.id, isManager]);
  const visibleWatchItems = useMemo(() => {
    let items = activeWatchItems;
    if (!isManager) {
      const userId = authUser?.id;
      items = userId ? items.filter(item => item.ownerId === userId) : [];
    } else if (watchSalespersonFilter !== "all") {
      items = items.filter(item => item.ownerId === watchSalespersonFilter);
    }
    if (watchQuery.trim()) {
      const q = watchQuery.trim().toLowerCase();
      items = items.filter(item => {
        const haystack = [
          item.leadName,
          item.leadKey,
          ...((item.watches ?? []).flatMap(w => [
            w?.model,
            w?.make,
            w?.trim,
            w?.color
          ]) as string[])
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    return items;
  }, [activeWatchItems, authUser?.id, isManager, watchQuery, watchSalespersonFilter]);
  const displaySendBody = useMemo(() => {
    if (sendBodySource === "user") return sendBody;
    if (messageFilter === "calls") return "";
    if (messageFilter === "email") {
      if (!emailManualMode && emailDraft) return maskBookingLink(emailDraft);
      return sendBody;
    }
    if (pendingDraft?.body) return pendingDraft.body;
    return sendBody;
  }, [sendBodySource, sendBody, pendingDraft?.body, messageFilter, emailDraft, emailManualMode]);

  useEffect(() => {
    const el = sendBoxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [displaySendBody]);

  useEffect(() => {
    if (!listActionsOpenId) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-actions-menu]") || target.closest("[data-actions-button]")) {
        return;
      }
      setListActionsOpenId(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [listActionsOpenId]);

  useEffect(() => {
    if (!listActionsOpenId) {
      setTodoInlineOpenId(null);
      setTodoInlineText("");
      setTodoInlineTarget(isManager ? "lead_owner" : "self");
      setContactInlineOpenId(null);
      setContactInlineSaving(false);
      setContactInlineForm({ firstName: "", lastName: "", phone: "", email: "" });
      setReassignInlineOpenId(null);
      setReassignInlineTarget("department:service");
      setReassignInlineSummary("");
      setReassignInlineSaving(false);
    }
  }, [listActionsOpenId, isManager]);

  useEffect(() => {
    if (!selectedId) return;
    if (pendingDraft) return;
    const listItem = conversations.find(c => c.id === selectedId);
    if (!listItem?.pendingDraft) return;
    void loadConversation(selectedId);
  }, [conversations, selectedId, pendingDraft]);

  const filteredContacts = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    let rows = contacts;
    if (selectedContactListId !== "all" && selectedContactList?.contactIds?.length) {
      const idSet = new Set((selectedContactList.contactIds ?? []).map(v => String(v)));
      rows = rows.filter(c => idSet.has(String(c.id)));
    } else if (selectedContactListId !== "all") {
      rows = [];
    }

    const searched = !q
      ? rows
      : rows.filter(c => {
      const haystack = [
        c.name,
        c.firstName,
        c.lastName,
        c.email,
        c.phone,
        c.leadSource,
        c.leadRef,
        c.vehicleDescription,
        c.vehicle,
        c.model,
        c.make,
        c.trim,
        c.color,
        c.condition,
        c.stockId,
        c.vin,
        c.year,
        c.inquiry,
        c.leadKey,
        c.conversationId
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
      });

    return [...searched].sort((a, b) => {
      const aLast = String(a.lastName ?? "").trim();
      const bLast = String(b.lastName ?? "").trim();
      const aFirst = String(a.firstName ?? "").trim();
      const bFirst = String(b.firstName ?? "").trim();
      const aName = String(a.name ?? "").trim();
      const bName = String(b.name ?? "").trim();
      const aKey = [aLast, aFirst, aName].filter(Boolean).join(" ").toLowerCase();
      const bKey = [bLast, bFirst, bName].filter(Boolean).join(" ").toLowerCase();
      return aKey.localeCompare(bKey, undefined, { sensitivity: "base", numeric: true });
    });
  }, [contacts, contactQuery, selectedContactListId, selectedContactList]);

  const filteredContactIdsKey = useMemo(
    () => filteredContacts.map(c => c.id).join("|"),
    [filteredContacts]
  );

  useEffect(() => {
    if (section !== "contacts") return;
    if (!filteredContacts.length) {
      if (selectedContact) setSelectedContact(null);
      return;
    }
    const exists =
      selectedContact && filteredContacts.some(c => String(c.id) === String(selectedContact.id));
    if (!exists) {
      setSelectedContact(filteredContacts[0]);
    }
  }, [section, filteredContactIdsKey, selectedContact?.id]);

  const isConversationOnHold = (c: ConversationListItem) => {
    const status = String(c.status ?? "").trim().toLowerCase();
    if (status === "closed") return false;
    const closedReason = String(c.closedReason ?? "").trim().toLowerCase();
    const soldByReason = closedReason === "sold" || /\bsold\b/.test(closedReason);
    const soldByCadence = String(c.followUpCadence?.kind ?? "").trim().toLowerCase() === "post_sale";
    if (!!c.sale?.soldAt || soldByCadence || (status === "closed" && soldByReason)) return false;
    return (
      c.followUpCadence?.pauseReason === "manual_hold" ||
      c.followUpCadence?.pauseReason === "unit_hold" ||
      c.followUpCadence?.pauseReason === "order_hold" ||
      c.followUpCadence?.stopReason === "unit_hold" ||
      c.followUpCadence?.stopReason === "order_hold" ||
      c.followUp?.reason === "manual_hold" ||
      c.followUp?.reason === "unit_hold" ||
      c.followUp?.reason === "order_hold" ||
      !!c.hold
    );
  };

  const isSoldDealConversation = (c: ConversationListItem) => {
    const status = String(c.status ?? "").trim().toLowerCase();
    const closedReason = String(c.closedReason ?? "").trim().toLowerCase();
    const soldByReason = closedReason === "sold" || /\bsold\b/.test(closedReason);
    const soldByCadence = String(c.followUpCadence?.kind ?? "").trim().toLowerCase() === "post_sale";
    return !!c.sale?.soldAt || soldByCadence || (status === "closed" && soldByReason);
  };

  const isArchivedConversation = (c: ConversationListItem) => {
    const status = String(c.status ?? "").trim().toLowerCase();
    const closedReason = String(c.closedReason ?? "").trim().toLowerCase();
    if (isSoldDealConversation(c)) return false;
    if (status === "closed") return true;
    const holdDeal =
      /\bhold\b/.test(closedReason) ||
      c.followUpCadence?.pauseReason === "manual_hold" ||
      c.followUpCadence?.pauseReason === "unit_hold" ||
      c.followUpCadence?.pauseReason === "order_hold" ||
      c.followUpCadence?.stopReason === "unit_hold" ||
      c.followUpCadence?.stopReason === "order_hold" ||
      c.followUp?.reason === "manual_hold" ||
      c.followUp?.reason === "unit_hold" ||
      c.followUp?.reason === "order_hold" ||
      !!c.hold;
    if (holdDeal) return false;
    return /archive/.test(closedReason);
  };

  const PURCHASE_INTENT_BUCKETS = new Set(["inventory_interest", "test_ride", "pricing_payments"]);
  const PURCHASE_INTENT_CTAS = new Set([
    "check_availability",
    "request_a_quote",
    "schedule_test_ride",
    "value_my_trade",
    "sell_my_bike",
    "hdfs_coa",
    "book_appointment",
    "schedule_appointment"
  ]);
  const NON_DEAL_BUCKETS = new Set(["service", "parts", "apparel"]);
  const NON_DEAL_CTAS = new Set(["service_request", "parts_request", "apparel_request"]);
  const getConversationRecencyMs = (c: ConversationListItem) => {
    const atCandidates = [c.updatedAt, c.engagement?.at];
    for (const at of atCandidates) {
      const atMs = Date.parse(String(at ?? ""));
      if (Number.isFinite(atMs)) return atMs;
    }
    return NaN;
  };

  const hasPurchaseIntentSignal = (c: ConversationListItem) => {
    const bucket = String(c.classification?.bucket ?? "").trim().toLowerCase();
    const cta = String(c.classification?.cta ?? "").trim().toLowerCase();
    if (NON_DEAL_BUCKETS.has(bucket) || NON_DEAL_CTAS.has(cta)) return false;
    if (PURCHASE_INTENT_BUCKETS.has(bucket) || PURCHASE_INTENT_CTAS.has(cta)) return true;
    const engagementReason = String(c.engagement?.reason ?? "").trim().toLowerCase();
    if (
      engagementReason === "purchase" ||
      engagementReason === "schedule" ||
      engagementReason === "trade" ||
      engagementReason === "finance" ||
      engagementReason === "pricing" ||
      engagementReason === "availability"
    ) {
      return true;
    }

    const apptStatus = String(c.appointment?.status ?? "").trim().toLowerCase();
    if (apptStatus && apptStatus !== "cancelled" && apptStatus !== "no_show") return true;
    if (c.inventoryWatch || (Array.isArray(c.inventoryWatches) && c.inventoryWatches.length > 0)) {
      return true;
    }
    const lastText = String(c.lastMessage?.body ?? "").trim().toLowerCase();
    const hasInventoryListSignal =
      /\btop options:\b/.test(lastText) ||
      /\bwe have\s+\d+\s+(?:new|used|pre[-\s]?owned)?[\s\S]{0,80}\bin stock\b/.test(lastText) ||
      /\bhttps?:\/\/\S*\/inventory\/\S+/i.test(lastText);
    if (hasInventoryListSignal) return true;

    return false;
  };

  const isPrequalLead = (c: ConversationListItem) => {
    const leadSource = String(c.leadSource ?? "").trim().toLowerCase();
    const bucket = String(c.classification?.bucket ?? "").trim().toLowerCase();
    const cta = String(c.classification?.cta ?? "").trim().toLowerCase();
    if (bucket === "finance_prequal" || cta === "prequalify") return true;
    return (
      leadSource.includes("marketplace - prequal") ||
      leadSource.includes("prequal")
    );
  };

  const isCoaLead = (c: ConversationListItem) => {
    const leadSource = String(c.leadSource ?? "").trim().toLowerCase();
    const cta = String(c.classification?.cta ?? "").trim().toLowerCase();
    if (cta === "hdfs_coa") return true;
    return (
      leadSource.includes("hdfs coa") ||
      leadSource.includes("coa online") ||
      leadSource.includes("credit application")
    );
  };

  const isAdfTestRideException = (c: ConversationListItem) => {
    const leadSource = String(c.leadSource ?? "").trim().toLowerCase();
    const bucket = String(c.classification?.bucket ?? "").trim().toLowerCase();
    const cta = String(c.classification?.cta ?? "").trim().toLowerCase();
    if (bucket === "test_ride" || cta === "schedule_test_ride") return true;
    return leadSource.includes("test ride");
  };

  const isHotDealConversation = (c: ConversationListItem) => {
    const explicitTemperature = String(c.dealTemperature ?? "").trim().toLowerCase();
    if (explicitTemperature === "hot") return true;
    if (explicitTemperature === "warm" || explicitTemperature === "cold") return false;
    if (isSoldDealConversation(c)) return false;
    if (isConversationOnHold(c)) return false;
    if (c.status === "closed") return false;
    const nowMs = Date.now();
    const cutoffMs = 30 * 24 * 60 * 60 * 1000;
    const recentAtMs = getConversationRecencyMs(c);
    if (!Number.isFinite(recentAtMs)) return false;
    if (nowMs - recentAtMs > cutoffMs) return false;
    if (isPrequalLead(c)) return false;
    if (Boolean(c.hotDealSticky)) return true;
    if (isCoaLead(c) || isAdfTestRideException(c)) {
      return true;
    }
    const twilioEngaged =
      Boolean(c.hasInboundTwilio) ||
      c.engagement?.source === "sms" ||
      (Array.isArray((c as any)?.messages) &&
        (c as any).messages.some((m: any) => m?.direction === "in" && m?.provider === "twilio"));
    if (!twilioEngaged) return false;
    return hasPurchaseIntentSignal(c);
  };

  const getDealTemperature = (c: ConversationListItem | null | undefined): "hot" | "warm" | "cold" | null => {
    if (!c) return null;
    const explicitTemperature = String(c.dealTemperature ?? "").trim().toLowerCase();
    if (explicitTemperature === "hot" || explicitTemperature === "warm" || explicitTemperature === "cold") {
      return explicitTemperature as "hot" | "warm" | "cold";
    }
    return isHotDealConversation(c) ? "hot" : null;
  };

  const renderDealTemperatureIcon = (
    temperature: "hot" | "warm" | "cold" | null,
    sizeClass = "text-lg"
  ) => {
    if (!temperature) return null;
    if (temperature === "hot") {
      return (
        <span className={`text-orange-500 leading-none ${sizeClass}`} title="Hot deal" aria-label="Hot deal">
          🔥
        </span>
      );
    }
    if (temperature === "warm") {
      return (
        <span className={`text-amber-500 leading-none ${sizeClass}`} title="Warm deal" aria-label="Warm deal">
          ♨️
        </span>
      );
    }
    return (
      <span className={`text-sky-500 leading-none ${sizeClass}`} title="Cold deal" aria-label="Cold deal">
        ❄️
      </span>
    );
  };

  const isCampaignOnlyConversation = useCallback((c: ConversationListItem | null | undefined) => {
    if (!c) return false;
    return String(c.campaignThread?.status ?? "").trim().toLowerCase() === "campaign";
  }, []);

  const isCampaignConversation = useCallback((c: ConversationListItem | null | undefined) => {
    if (!c) return false;
    const status = String(c.campaignThread?.status ?? "").trim().toLowerCase();
    return status === "campaign" || status === "linked_open";
  }, []);

  const {
    inboxTodoOwnerByConv,
    filteredConversations,
    inboxDealCounts,
    groupedConversations
  } = useInboxSectionData({
    conversations,
    todos,
    view,
    inboxQuery,
    inboxOwnerFilter,
    inboxDealFilter,
    isManager,
    canonicalizeOwnerName,
    inferOwnerDepartment,
    inferTodoDepartment,
    isHotDealConversation,
    isSoldDealConversation,
    isConversationOnHold,
    isArchivedConversation,
    isCampaignOnlyConversation,
    isCampaignConversation
  });

  const contactLookup = useMemo(() => {
    const byConversationId = new Map<string, ContactItem>();
    const byLeadKey = new Map<string, ContactItem>();
    const byPhoneDigits = new Map<string, ContactItem>();
    for (const contact of contacts) {
      const convId = String(contact.conversationId ?? "").trim();
      if (convId && !byConversationId.has(convId)) {
        byConversationId.set(convId, contact);
      }
      const leadKey = String(contact.leadKey ?? "").trim();
      if (leadKey) {
        const normalizedLeadKey = leadKey.toLowerCase();
        if (!byLeadKey.has(normalizedLeadKey)) {
          byLeadKey.set(normalizedLeadKey, contact);
        }
        const leadKeyDigits = leadKey.replace(/\D/g, "");
        if (leadKeyDigits && !byPhoneDigits.has(leadKeyDigits)) {
          byPhoneDigits.set(leadKeyDigits, contact);
        }
      }
      const phoneDigits = String(contact.phone ?? "").replace(/\D/g, "");
      if (phoneDigits && !byPhoneDigits.has(phoneDigits)) {
        byPhoneDigits.set(phoneDigits, contact);
      }
    }
    return { byConversationId, byLeadKey, byPhoneDigits };
  }, [contacts]);

  const findLinkedContactForConversation = useCallback(
    (conv: ConversationListItem): ContactItem | null => {
      const convId = String(conv.id ?? "").trim();
      if (convId) {
        const byConv = contactLookup.byConversationId.get(convId);
        if (byConv) return byConv;
      }
      const leadKey = String(conv.leadKey ?? "").trim();
      if (leadKey) {
        const byLeadKey = contactLookup.byLeadKey.get(leadKey.toLowerCase());
        if (byLeadKey) return byLeadKey;
        const digits = leadKey.replace(/\D/g, "");
        if (digits) {
          const byPhone = contactLookup.byPhoneDigits.get(digits);
          if (byPhone) return byPhone;
        }
      }
      return null;
    },
    [contactLookup]
  );

  const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  const followUpMonths = [
    { value: 1, label: "Jan" },
    { value: 2, label: "Feb" },
    { value: 3, label: "Mar" },
    { value: 4, label: "Apr" },
    { value: 5, label: "May" },
    { value: 6, label: "Jun" },
    { value: 7, label: "Jul" },
    { value: 8, label: "Aug" },
    { value: 9, label: "Sep" },
    { value: 10, label: "Oct" },
    { value: 11, label: "Nov" },
    { value: 12, label: "Dec" }
  ];
  const isUsTimeZone = (tz?: string) => (tz ?? "").startsWith("America/");
  const formatTimeLabel = (t: string, tz?: string) => {
    if (!isUsTimeZone(tz)) return t;
    const [h, m] = t.split(":").map(Number);
    const hour12 = ((h + 11) % 12) + 1;
    const ampm = h >= 12 ? "PM" : "AM";
    return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
  };
  const availableAppointmentTypes = useMemo(() => {
    return defaultAppointmentTypes.filter(
      key => !appointmentTypesList.some(row => row.key.trim().toLowerCase() === key.toLowerCase())
    );
  }, [appointmentTypesList]);
  const canViewConversation =
    section === "inbox" || section === "todos" || section === "questions" || section === "watches";
  const preferredOrder = useMemo(() => {
    const base = preferredOrderIds.length ? preferredOrderIds : salespeopleList.map(sp => sp.id);
    return [...base, ...salespeopleList.map(sp => sp.id).filter(id => !base.includes(id))];
  }, [preferredOrderIds, salespeopleList]);
  const inferAppointmentTypeForConv = (conv?: ConversationDetail | null) => {
    const bucket = conv?.classification?.bucket ?? "";
    const cta = conv?.classification?.cta ?? "";
    if (bucket === "test_ride" || cta === "schedule_test_ride") return "test_ride";
    if (bucket === "trade_in_sell" || cta === "value_my_trade" || cta === "sell_my_bike") {
      return "trade_appraisal";
    }
    if (bucket === "finance_prequal" || cta === "prequalify" || cta === "hdfs_coa") {
      return "finance_discussion";
    }
    return "inventory_visit";
  };
  const resolveDefaultSalespersonId = () => {
    if (authUser?.id && salespeopleList.some(sp => sp.id === authUser.id)) {
      return authUser.id;
    }
    if (salespeopleList.length === 1) return salespeopleList[0]?.id ?? "";
    return "";
  };


  const buildCalendarEvents = (json: any) => {
    if (Array.isArray(json?.events)) {
      return json.events.filter((e: any) => e?.status !== "cancelled");
    }
    const byId = new Map(calendarUsers.map(u => [u.id, u]));
    const busyByUserId = json?.busyByUserId ?? {};
    const events: any[] = [];
    for (const [userId, blocks] of Object.entries(busyByUserId)) {
      const user = byId.get(userId);
      if (!user) continue;
      const list = Array.isArray(blocks) ? blocks : [];
      for (const block of list) {
        const startIso = block?.start ?? null;
        const endIso = block?.end ?? null;
        if (!startIso || !endIso) continue;
        events.push({
          id: `${userId}-${startIso}`,
          summary: "Busy",
          start: startIso,
          end: endIso,
          status: "busy",
          calendarId: user.calendarId,
          salespersonId: userId,
          salespersonName: user.name || user.email || user.id,
          readOnly: true,
          colorId: "8"
        });
      }
    }
    return events;
  };
  const getEventTitle = (ev: any) => ev?.fullName || ev?.customerName || ev?.summary || "Busy";
  const getEventStyle = (ev: any) => {
    if (ev?.readOnly) return undefined;
    const c = getCalendarColor(ev?.colorId);
    if (!c) return undefined;
    return {
      backgroundColor: c.bg,
      borderColor: c.border,
      color: c.text
    };
  };
  const getEventDetails = (ev: any) => {
    const parts = [];
    if (ev?.phone) parts.push(`Phone: ${ev.phone}`);
    if (ev?.email) parts.push(`Email: ${ev.email}`);
    if (ev?.stock) parts.push(`Stock: ${ev.stock}`);
    if (ev?.vin) parts.push(`VIN: ${ev.vin}`);
    if (ev?.source) parts.push(`Source: ${ev.source}`);
    return parts.join(" • ");
  };
  const getEventTimeRangeLabel = (ev: any, tz: string) => {
    const start = ev?.start ? new Date(ev.start) : null;
    const end = ev?.end ? new Date(ev.end) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(start);
    const startHour = Number(parts.find(p => p.type === "hour")?.value ?? "0");
    const startMinute = Number(parts.find(p => p.type === "minute")?.value ?? "0");
    const endParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(end);
    const endHour = Number(endParts.find(p => p.type === "hour")?.value ?? "0");
    const endMinute = Number(endParts.find(p => p.type === "minute")?.value ?? "0");
    const startLabel = formatTimeLabel(
      `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`,
      tz
    );
    const endLabel = formatTimeLabel(
      `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`,
      tz
    );
    return `${startLabel}-${endLabel}`;
  };

  useEffect(() => {
    if (appointmentTypeToAdd === "custom") return;
    if (availableAppointmentTypes.length === 0) return;
    if (!availableAppointmentTypes.includes(appointmentTypeToAdd)) {
      setAppointmentTypeToAdd(availableAppointmentTypes[0]);
    }
  }, [availableAppointmentTypes, appointmentTypeToAdd]);
  const timeZones = [
    "Africa/Abidjan","Africa/Accra","Africa/Addis_Ababa","Africa/Algiers","Africa/Asmara","Africa/Bamako","Africa/Bangui","Africa/Banjul","Africa/Bissau","Africa/Blantyre","Africa/Brazzaville","Africa/Bujumbura","Africa/Cairo","Africa/Casablanca","Africa/Ceuta","Africa/Conakry","Africa/Dakar","Africa/Dar_es_Salaam","Africa/Djibouti","Africa/Douala","Africa/El_Aaiun","Africa/Freetown","Africa/Gaborone","Africa/Harare","Africa/Johannesburg","Africa/Juba","Africa/Kampala","Africa/Khartoum","Africa/Kigali","Africa/Kinshasa","Africa/Lagos","Africa/Libreville","Africa/Lome","Africa/Luanda","Africa/Lubumbashi","Africa/Lusaka","Africa/Malabo","Africa/Maputo","Africa/Maseru","Africa/Mbabane","Africa/Mogadishu","Africa/Monrovia","Africa/Nairobi","Africa/Ndjamena","Africa/Niamey","Africa/Nouakchott","Africa/Ouagadougou","Africa/Porto-Novo","Africa/Sao_Tome","Africa/Tripoli","Africa/Tunis","Africa/Windhoek",
    "America/Adak","America/Anchorage","America/Anguilla","America/Antigua","America/Araguaina","America/Argentina/Buenos_Aires","America/Argentina/Catamarca","America/Argentina/Cordoba","America/Argentina/Jujuy","America/Argentina/La_Rioja","America/Argentina/Mendoza","America/Argentina/Rio_Gallegos","America/Argentina/Salta","America/Argentina/San_Juan","America/Argentina/San_Luis","America/Argentina/Tucuman","America/Argentina/Ushuaia","America/Aruba","America/Asuncion","America/Atikokan","America/Bahia","America/Bahia_Banderas","America/Barbados","America/Belem","America/Belize","America/Blanc-Sablon","America/Boa_Vista","America/Bogota","America/Boise","America/Cambridge_Bay","America/Campo_Grande","America/Cancun","America/Caracas","America/Cayenne","America/Cayman","America/Chicago","America/Chihuahua","America/Costa_Rica","America/Creston","America/Cuiaba","America/Curacao","America/Danmarkshavn","America/Dawson","America/Dawson_Creek","America/Denver","America/Detroit","America/Dominica","America/Edmonton","America/Eirunepe","America/El_Salvador","America/Fort_Nelson","America/Fortaleza","America/Glace_Bay","America/Godthab","America/Goose_Bay","America/Grand_Turk","America/Grenada","America/Guadeloupe","America/Guatemala","America/Guayaquil","America/Guyana","America/Halifax","America/Havana","America/Hermosillo","America/Indiana/Indianapolis","America/Indiana/Knox","America/Indiana/Marengo","America/Indiana/Petersburg","America/Indiana/Tell_City","America/Indiana/Vevay","America/Indiana/Vincennes","America/Indiana/Winamac","America/Inuvik","America/Iqaluit","America/Jamaica","America/Juneau","America/Kentucky/Louisville","America/Kentucky/Monticello","America/Kralendijk","America/La_Paz","America/Lima","America/Los_Angeles","America/Lower_Princes","America/Maceio","America/Managua","America/Manaus","America/Marigot","America/Martinique","America/Matamoros","America/Mazatlan","America/Menominee","America/Merida","America/Metlakatla","America/Mexico_City","America/Miquelon","America/Moncton","America/Monterrey","America/Montevideo","America/Montserrat","America/Nassau","America/New_York","America/Nipigon","America/Nome","America/Noronha","America/North_Dakota/Beulah","America/North_Dakota/Center","America/North_Dakota/New_Salem","America/Nuuk","America/Ojinaga","America/Panama","America/Pangnirtung","America/Paramaribo","America/Phoenix","America/Port-au-Prince","America/Port_of_Spain","America/Porto_Velho","America/Puerto_Rico","America/Punta_Arenas","America/Rainy_River","America/Rankin_Inlet","America/Recife","America/Regina","America/Resolute","America/Rio_Branco","America/Santarem","America/Santiago","America/Santo_Domingo","America/Sao_Paulo","America/Scoresbysund","America/Sitka","America/St_Barthelemy","America/St_Johns","America/St_Kitts","America/St_Lucia","America/St_Thomas","America/St_Vincent","America/Swift_Current","America/Tegucigalpa","America/Thule","America/Thunder_Bay","America/Tijuana","America/Toronto","America/Tortola","America/Vancouver","America/Whitehorse","America/Winnipeg","America/Yakutat","America/Yellowknife",
    "Antarctica/Casey","Antarctica/Davis","Antarctica/DumontDUrville","Antarctica/Macquarie","Antarctica/Mawson","Antarctica/McMurdo","Antarctica/Palmer","Antarctica/Rothera","Antarctica/Syowa","Antarctica/Troll","Antarctica/Vostok",
    "Asia/Aden","Asia/Almaty","Asia/Amman","Asia/Anadyr","Asia/Aqtau","Asia/Aqtobe","Asia/Ashgabat","Asia/Atyrau","Asia/Baghdad","Asia/Bahrain","Asia/Baku","Asia/Bangkok","Asia/Barnaul","Asia/Beirut","Asia/Bishkek","Asia/Brunei","Asia/Chita","Asia/Choibalsan","Asia/Colombo","Asia/Damascus","Asia/Dhaka","Asia/Dili","Asia/Dubai","Asia/Dushanbe","Asia/Famagusta","Asia/Gaza","Asia/Hebron","Asia/Ho_Chi_Minh","Asia/Hong_Kong","Asia/Hovd","Asia/Irkutsk","Asia/Jakarta","Asia/Jayapura","Asia/Jerusalem","Asia/Kabul","Asia/Kamchatka","Asia/Karachi","Asia/Kathmandu","Asia/Khandyga","Asia/Kolkata","Asia/Krasnoyarsk","Asia/Kuala_Lumpur","Asia/Kuching","Asia/Kuwait","Asia/Macau","Asia/Magadan","Asia/Makassar","Asia/Manila","Asia/Muscat","Asia/Nicosia","Asia/Novokuznetsk","Asia/Novosibirsk","Asia/Omsk","Asia/Oral","Asia/Phnom_Penh","Asia/Pontianak","Asia/Pyongyang","Asia/Qatar","Asia/Qostanay","Asia/Qyzylorda","Asia/Riyadh","Asia/Sakhalin","Asia/Samarkand","Asia/Seoul","Asia/Shanghai","Asia/Singapore","Asia/Srednekolymsk","Asia/Taipei","Asia/Tashkent","Asia/Tbilisi","Asia/Tehran","Asia/Thimphu","Asia/Tokyo","Asia/Tomsk","Asia/Ulaanbaatar","Asia/Urumqi","Asia/Ust-Nera","Asia/Vientiane","Asia/Vladivostok","Asia/Yakutsk","Asia/Yangon","Asia/Yekaterinburg","Asia/Yerevan",
    "Atlantic/Azores","Atlantic/Bermuda","Atlantic/Canary","Atlantic/Cape_Verde","Atlantic/Faroe","Atlantic/Madeira","Atlantic/Reykjavik","Atlantic/South_Georgia","Atlantic/St_Helena","Atlantic/Stanley",
    "Australia/Adelaide","Australia/Brisbane","Australia/Broken_Hill","Australia/Darwin","Australia/Eucla","Australia/Hobart","Australia/Lindeman","Australia/Lord_Howe","Australia/Melbourne","Australia/Perth","Australia/Sydney",
    "Europe/Amsterdam","Europe/Andorra","Europe/Astrakhan","Europe/Athens","Europe/Belgrade","Europe/Berlin","Europe/Brussels","Europe/Bucharest","Europe/Budapest","Europe/Chisinau","Europe/Copenhagen","Europe/Dublin","Europe/Gibraltar","Europe/Helsinki","Europe/Istanbul","Europe/Kaliningrad","Europe/Kiev","Europe/Kirov","Europe/Lisbon","Europe/London","Europe/Luxembourg","Europe/Madrid","Europe/Malta","Europe/Minsk","Europe/Monaco","Europe/Moscow","Europe/Oslo","Europe/Paris","Europe/Prague","Europe/Riga","Europe/Rome","Europe/Samara","Europe/Saratov","Europe/Simferopol","Europe/Sofia","Europe/Stockholm","Europe/Tallinn","Europe/Tirane","Europe/Ulyanovsk","Europe/Uzhgorod","Europe/Vienna","Europe/Vilnius","Europe/Volgograd","Europe/Warsaw","Europe/Zaporozhye","Europe/Zurich",
    "Indian/Chagos","Indian/Christmas","Indian/Cocos","Indian/Comoro","Indian/Kerguelen","Indian/Mahe","Indian/Maldives","Indian/Mauritius","Indian/Mayotte","Indian/Reunion",
    "Pacific/Apia","Pacific/Auckland","Pacific/Bougainville","Pacific/Chatham","Pacific/Chuuk","Pacific/Easter","Pacific/Efate","Pacific/Enderbury","Pacific/Fakaofo","Pacific/Fiji","Pacific/Funafuti","Pacific/Galapagos","Pacific/Gambier","Pacific/Guadalcanal","Pacific/Guam","Pacific/Honolulu","Pacific/Kanton","Pacific/Kiritimati","Pacific/Kosrae","Pacific/Kwajalein","Pacific/Majuro","Pacific/Marquesas","Pacific/Midway","Pacific/Nauru","Pacific/Niue","Pacific/Norfolk","Pacific/Noumea","Pacific/Pago_Pago","Pacific/Palau","Pacific/Pitcairn","Pacific/Pohnpei","Pacific/Port_Moresby","Pacific/Rarotonga","Pacific/Saipan","Pacific/Tahiti","Pacific/Tarawa","Pacific/Tongatapu","Pacific/Wake","Pacific/Wallis"
  ];
  const timeOptions = useMemo(() => {
    const out: string[] = [];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 30) {
        out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      }
    }
    return out;
  }, []);

  function updateHours(
    setter: (next: Record<string, { open: string | null; close: string | null }> | ((prev: Record<string, { open: string | null; close: string | null }>) => Record<string, { open: string | null; close: string | null }>)) => void,
    day: string,
    field: "open" | "close",
    value: string
  ) {
    setter(prev => ({
      ...prev,
      [day]: {
        open: field === "open" ? (value || null) : (prev?.[day]?.open ?? null),
        close: field === "close" ? (value || null) : (prev?.[day]?.close ?? null)
      }
    }));
  }

  useEffect(() => {
    if (messageFilter !== "email") {
      setEmailManualMode(false);
      return;
    }
    setEmailManualMode(false);
  }, [selectedConv?.id, messageFilter]);

  useEffect(() => {
    if (messageFilter === "calls") {
      setSendBody("");
      setSendBodySource("system");
      setLastDraftId(null);
      return;
    }
    if (messageFilter === "email") {
      if (emailDraft) {
        setSendBody(emailDraft);
        setSendBodySource("draft");
      } else if (sendBodySource !== "user") {
        setSendBody("");
        setSendBodySource("system");
      }
      setLastDraftId(null);
      return;
    }
    if (!pendingDraft) return;
    const hasUserEdits = sendBodySource === "user" && sendBody.trim().length > 0;
    if (hasUserEdits && pendingDraft.id !== lastDraftId) return;
    setSendBody(pendingDraft.body);
    setSendBodySource("draft");
    setLastDraftId(pendingDraft.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraft?.id, messageFilter, emailDraft]);

  useEffect(() => {
    if (messageFilter === "calls") {
      setSendBody("");
      setSendBodySource("system");
      setLastDraftId(null);
      return;
    }
    if (messageFilter === "email") {
      if (emailDraft) {
        setSendBody(emailDraft);
        setSendBodySource("draft");
      } else {
        setSendBody("");
        setSendBodySource("system");
      }
      setLastDraftId(null);
      return;
    }
    if (pendingDraft) {
      setSendBody(pendingDraft.body);
      setSendBodySource("draft");
      setLastDraftId(pendingDraft.id ?? null);
      return;
    }
    setSendBody("");
    setSendBodySource("system");
    setLastDraftId(null);
  }, [selectedConv?.id, pendingDraft?.id, messageFilter, emailDraft]);

  useEffect(() => {
    if (messageFilter !== "email") {
      if (emailAttachments.length) setEmailAttachments([]);
    } else if (selectedConv?.id) {
      if (emailAttachments.length) setEmailAttachments([]);
    }

    if (messageFilter !== "sms") {
      if (smsAttachments.length) setSmsAttachments([]);
    } else if (selectedConv?.id) {
      if (smsAttachments.length) setSmsAttachments([]);
    }
  }, [messageFilter, selectedConv?.id]);

  async function markTodoDone(
    todo: TodoItem,
    resolution = "resume",
    appointmentOutcome?: string,
    appointmentOutcomeNote?: string,
    appointmentPrimaryOutcome?: string,
    appointmentSecondaryOutcome?: string
  ) {
    await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        convId: todo.convId,
        todoId: todo.id,
        resolution,
        appointmentOutcome: appointmentOutcome || undefined,
        appointmentOutcomeNote: appointmentOutcomeNote || undefined,
        appointmentPrimaryOutcome: appointmentPrimaryOutcome || undefined,
        appointmentSecondaryOutcome: appointmentSecondaryOutcome || undefined
      })
    });
    await load();
  }

  async function markQuestionDone(q: QuestionItem) {
    const outcome = questionOutcomeById[q.id] ?? q.outcome ?? "";
    const followUpAction = questionFollowUpById[q.id] ?? q.followUpAction ?? "";
    await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        convId: q.convId,
        questionId: q.id,
        outcome: outcome || undefined,
        followUpAction: followUpAction || undefined
      })
    });
    await load();
  }

  async function retryCrmLog(q: QuestionItem) {
    try {
      const convResp = await fetch(`/api/conversations/${encodeURIComponent(q.convId)}`);
      const convData = await convResp.json().catch(() => null);
      const leadRef =
        convData?.conversation?.lead?.leadRef ?? convData?.conversation?.leadRef ?? null;
      if (!leadRef) {
        window.alert("Missing leadRef for this conversation.");
        return;
      }
      const resp = await fetch("/api/crm/tlp/log-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadRef, conversationId: q.convId })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        window.alert(data?.error ?? "CRM update failed");
        return;
      }
      if (data?.skipped) {
        window.alert("No new messages to log to CRM.");
        return;
      }
      await markQuestionDone(q);
      setSaveToast("CRM updated");
    } catch {
      window.alert("CRM update failed");
    }
  }

  async function doSend(payload: {
    body: string;
    draftId?: string;
    editNote?: string;
    manualTakeover?: boolean;
    skipEmailSignature?: boolean;
    attachments?: { name: string; type: string; size: number; content: string }[];
    mediaUrls?: string[];
    forceEmail?: boolean;
    channel?: "sms" | "email";
  }): Promise<boolean> {
    if (!selectedConv) return false;
    const sendChannel = payload.channel ?? (messageFilter === "email" ? "email" : "sms");
    setComposeSending(true);
    try {
      const resp = await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          manualTakeover: payload.manualTakeover ?? !payload.draftId,
          skipEmailSignature: payload.skipEmailSignature === true,
          channel: sendChannel,
          forceEmail: payload.forceEmail === true,
          attachments:
            sendChannel === "email"
              ? (payload.attachments || []).map(att => ({
                  content: att.content,
                  filename: att.name,
                  type: att.type
                }))
              : undefined,
          mediaUrls: sendChannel === "sms" ? payload.mediaUrls ?? [] : undefined
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        if (
          sendChannel === "email" &&
          data?.error === "email opt-in not present for this lead" &&
          !payload.forceEmail
        ) {
          const ok = window.confirm(
            "Email opt-in is missing for this lead. Send anyway?"
          );
          if (ok) {
            return await doSend({ ...payload, forceEmail: true });
          }
          return false;
        }
        const errorText =
          data?.details && typeof data.details === "string"
            ? `${data?.error ?? "Send failed"} (${data.details})`
            : (data?.error ?? "Send failed");
        window.alert(errorText);
        return false;
      }
      if (sendChannel === "email") {
        const attachmentCount = payload.attachments?.length ?? 0;
        setEmailAttachments([]);
        setEmailAttachmentsBusy(false);
        setSaveToast(
          attachmentCount > 0
            ? `Email sent with ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}.`
            : "Email sent."
        );
      } else if (sendChannel === "sms") {
        const mediaCount = payload.mediaUrls?.length ?? 0;
        setSmsAttachments([]);
        setSmsAttachmentsBusy(false);
        if (mediaCount > 0) {
          setSaveToast(`SMS sent with ${mediaCount} attachment${mediaCount === 1 ? "" : "s"}.`);
        }
      }
      setSendBody("");
      setSendBodySource("system");
      setLastDraftId(null);
      if (data?.conversation) {
        const conv = data.conversation;
        if (Array.isArray(conv.messages)) {
          // Keep composer clear immediately after a send by staling any draft message
          // that is older than the latest sent outbound.
          let lastSentIdx = -1;
          conv.messages.forEach((m: any, idx: number) => {
            if (m?.direction !== "out") return;
            if (m?.provider === "twilio" || m?.provider === "human" || m?.provider === "sendgrid") {
              lastSentIdx = idx;
            }
          });
          if (lastSentIdx >= 0) {
            conv.messages = conv.messages.map((m: any, idx: number) => {
              if (
                idx <= lastSentIdx &&
                m?.direction === "out" &&
                m?.provider === "draft_ai" &&
                m?.draftStatus !== "stale"
              ) {
                return { ...m, draftStatus: "stale" };
              }
              return m;
            });
          }
        }
        if (payload.draftId && Array.isArray(conv.messages)) {
          const msg = conv.messages.find((m: any) => m.id === payload.draftId);
          if (msg) {
            msg.body = payload.body;
            msg.provider = data?.sent === true ? "twilio" : msg.provider ?? "human";
            msg.draftStatus = undefined;
            msg.at = new Date().toISOString();
          }
        }
        setSelectedConv(conv);
        setConversations(prev =>
          prev.map(c => {
            if (c.id !== conv.id) return c;
            const last = conv.messages?.[conv.messages.length - 1];
            return {
              ...c,
              updatedAt: conv.updatedAt ?? c.updatedAt,
              lastMessage: last?.body ?? c.lastMessage,
              messageCount: conv.messages?.length ?? c.messageCount,
              pendingDraft: false,
              pendingDraftPreview: null,
              mode: conv.mode ?? c.mode
            };
          })
        );
      } else {
        void loadConversation(selectedConv.id).catch(() => {});
      }
      // Don't block "Sending..." on full list refresh; update in background.
      void load().catch(() => {});
      return true;
    } finally {
      setComposeSending(false);
    }
  }

  async function send() {
    if (!selectedConv) return;
    if (composeSending) return;
    if (messageFilter === "calls") return;
    const sendChannel: "sms" | "email" = messageFilter === "email" ? "email" : "sms";
    if (sendChannel === "sms" && selectedConv.contactPreference === "call_only") {
      return;
    }
    const leadEmail = String(selectedConv.lead?.email ?? "").trim();
    const hasLeadEmail = leadEmail.includes("@");
    if (sendChannel === "email" && !hasLeadEmail) {
      window.alert("No email address is on this lead. Add an email first, or send SMS instead.");
      return;
    }
    if (sendChannel === "email" && emailAttachmentsBusy) {
      window.alert("Attachments are still processing. Please wait a moment.");
      return;
    }
    if (sendChannel === "sms" && smsAttachmentsBusy) {
      window.alert("Media is still uploading. Please wait a moment.");
      return;
    }
    const useEmailDraft = sendChannel === "email" && !!emailDraft && !emailManualMode;
    const effectiveDraft = sendChannel === "email" ? null : pendingDraft;
    const bodySource =
      sendBodySource === "user"
        ? sendBody
        : useEmailDraft
          ? emailDraft
          : (pendingDraft?.body ?? sendBody);
    let body = bodySource.trim();
    if (sendChannel === "email") {
      const bookingUrl = extractBookingUrl(emailDraft);
      if (bookingUrl && !/https?:\/\//i.test(body)) {
        body = injectBookingUrl(body, bookingUrl);
      }
    }
    const smsMmsMediaUrls =
      sendChannel === "sms"
        ? smsAttachments.filter(att => att.mode === "mms").map(att => att.url)
        : [];
    const smsLinkAttachments =
      sendChannel === "sms" ? smsAttachments.filter(att => att.mode === "link") : [];
    const smsLinkSuffix =
      sendChannel === "sms" && smsLinkAttachments.length
        ? `\n\n${smsLinkAttachments
            .map(att => `${att.name || "Media"}: ${att.url}`)
            .join("\n")}`
        : "";
    if (smsLinkSuffix) {
      body = `${body}${smsLinkSuffix}`.trim();
    }
    if (!body && !(sendChannel === "sms" && smsMmsMediaUrls.length > 0)) return;
    const draftId = effectiveDraft?.id;
    const normalizeDraftCompare = (text: string) => text.replace(/\r\n/g, "\n").trim();
    const edited =
      !!effectiveDraft &&
      normalizeDraftCompare(effectiveDraft.body) !== normalizeDraftCompare(body);
    if (edited) {
      setPendingSend({
        body,
        draftId,
        mediaUrls: sendChannel === "sms" ? smsMmsMediaUrls : undefined,
        channel: sendChannel
      });
      setEditNote("");
      setEditPromptOpen(true);
      return;
    }
    const manualTakeover = sendChannel === "email" ? emailManualMode : !draftId;
    const attachments = sendChannel === "email" ? emailAttachments : undefined;
    const isManualEmail = sendChannel === "email" && emailManualMode;
    await doSend(
      draftId
        ? {
            body,
            draftId,
            manualTakeover,
            attachments,
            mediaUrls: sendChannel === "sms" ? smsMmsMediaUrls : undefined,
            channel: sendChannel,
            skipEmailSignature: isManualEmail
          }
        : {
            body,
            manualTakeover: isManualEmail ? true : manualTakeover,
            attachments,
            mediaUrls: sendChannel === "sms" ? smsMmsMediaUrls : undefined,
            channel: sendChannel,
            skipEmailSignature: isManualEmail
          }
    );
  }

  async function handleEmailAttachments(files: FileList | null) {
    if (!files || files.length === 0) return;
    setEmailAttachmentsBusy(true);
    const maxPerFile = 7 * 1024 * 1024;
    const maxTotal = 15 * 1024 * 1024;
    const currentTotal = emailAttachments.reduce((sum, f) => sum + (f.size || 0), 0);
    const selected = Array.from(files);
    const next: { name: string; type: string; size: number; content: string }[] = [];
    let runningTotal = currentTotal;

    for (const file of selected) {
      if (file.size > maxPerFile) {
        window.alert(`"${file.name}" is too large (max 7MB per file).`);
        continue;
      }
      if (runningTotal + file.size > maxTotal) {
        window.alert("Total attachments exceed 15MB.");
        break;
      }
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("read failed"));
        reader.onload = () => {
          const result = String(reader.result ?? "");
          const base64 = result.includes(",") ? result.split(",")[1] : result;
          resolve(base64);
        };
        reader.readAsDataURL(file);
      }).catch(() => "");
      if (!content) continue;
      next.push({
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        content
      });
      runningTotal += file.size;
    }

    if (next.length) {
      setEmailAttachments(prev => [...prev, ...next]);
    }
    setEmailAttachmentsBusy(false);
  }

  function removeEmailAttachment(index: number) {
    setEmailAttachments(prev => prev.filter((_, i) => i !== index));
  }

  async function handleSmsAttachments(files: FileList | null) {
    if (!selectedConv) return;
    if (!files || files.length === 0) return;
    setSmsAttachmentsBusy(true);
    const selected = Array.from(files);
    const maxPerFile = 100 * 1024 * 1024;

    for (const file of selected) {
      if (file.size > maxPerFile) {
        window.alert(`"${file.name}" is too large (max 100MB).`);
        continue;
      }
      if (!(file.type.startsWith("image/") || file.type.startsWith("video/"))) {
        window.alert(`"${file.name}" must be an image or video file.`);
        continue;
      }

      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/media`, {
        method: "POST",
        body: fd
      });
      const payload = await resp.json().catch(() => null);
      if (!resp.ok || !payload?.url) {
        window.alert(payload?.error ?? `Failed to upload "${file.name}".`);
        continue;
      }
      const nextAttachment = {
        name: String(payload.name ?? file.name),
        type: String((payload.type ?? file.type) || "application/octet-stream"),
        size: Number(payload.size ?? file.size ?? 0),
        url: String(payload.url),
        mode:
          (typeof payload.mmsEligible === "boolean"
            ? payload.mmsEligible
            : file.size <= 5 * 1024 * 1024)
            ? ("mms" as const)
            : ("link" as const)
      };
      setSmsAttachments(prev => [...prev, nextAttachment]);
    }

    setSmsAttachmentsBusy(false);
  }

  function removeSmsAttachment(index: number) {
    setSmsAttachments(prev => prev.filter((_, i) => i !== index));
  }

  async function regenerateDraft() {
    if (!selectedConv) return;
    if (messageFilter === "calls") {
      window.alert("Switch to SMS or Email to regenerate a draft.");
      return;
    }
    if (mode !== "suggest") {
      window.alert("Regenerate is available in Suggest mode only.");
      return;
    }
    if (selectedConv.mode === "human") {
      window.alert("This conversation is in Human mode. Switch it back to AI to regenerate.");
      return;
    }
    setRegenBusy(true);
    try {
      const resp = await fetch(
        `/api/conversations/${encodeURIComponent(selectedConv.id)}/regenerate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: messageFilter })
        }
      );
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const errCode = String(data?.error ?? "").trim();
        const friendly =
          errCode === "regenerate_requires_suggest_mode"
            ? "Regenerate is available in Suggest mode only."
            : errCode === "human_override"
              ? "This conversation is in Human mode. Switch it back to AI to regenerate."
              : data?.error ?? "Regenerate failed";
        window.alert(friendly);
        return;
      }
      if (data?.skipped) {
        try {
          await fetch(
            `/api/conversations/${encodeURIComponent(selectedConv.id)}/draft/clear`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ clearSmsDraft: true, clearEmailDraft: true })
            }
          );
        } catch {
          // best-effort cleanup only
        }
        setSendBody("");
        setSendBodySource("system");
        setLastDraftId(null);
        const skipMsg = String(data?.draft ?? data?.note ?? "").trim();
        setSaveToast(skipMsg || "No customer reply needed.");
      }
      if (data?.conversation) {
        if (messageFilter === "email") setEmailManualMode(false);
        const conv = data.conversation;
        const convForUi =
          data?.skipped && Array.isArray(conv?.messages)
            ? {
                ...conv,
                messages: conv.messages.map((m: any) =>
                  m?.direction === "out" &&
                  m?.provider === "draft_ai" &&
                  m?.draftStatus !== "stale"
                    ? { ...m, draftStatus: "stale" }
                    : m
                )
              }
            : conv;
        setSelectedConv(convForUi);
        setConversations(prev =>
          prev.map(c => {
            if (c.id !== convForUi.id) return c;
            const last = convForUi.messages?.[convForUi.messages.length - 1];
            return {
              ...c,
              updatedAt: convForUi.updatedAt ?? c.updatedAt,
              lastMessage: last?.body ?? c.lastMessage,
              messageCount: convForUi.messages?.length ?? c.messageCount,
              pendingDraft: data?.skipped ? false : true,
              pendingDraftPreview: data?.skipped ? null : last?.body ?? c.pendingDraftPreview ?? null,
              mode: convForUi.mode ?? c.mode
            };
          })
        );
        if (!data?.skipped) {
          setSaveToast("Draft regenerated.");
        }
      } else {
        await loadConversation(selectedConv.id);
        setSaveToast("Draft regenerated.");
      }
      await load();
    } catch {
      window.alert("Regenerate failed");
    } finally {
      setRegenBusy(false);
    }
  }

  async function clearDraft() {
    if (!selectedConv) return;
    if (messageFilter === "calls") return;
    if (!hasClearableDraft) return;
    setClearDraftBusy(true);
    try {
      const resp = await fetch(
        `/api/conversations/${encodeURIComponent(selectedConv.id)}/draft/clear`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clearEmailDraft: messageFilter === "email",
            clearSmsDraft: messageFilter !== "email"
          })
        }
      );
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        window.alert(data?.error ?? "Failed to clear draft");
        return;
      }
      setLastDraftId(null);
      if (messageFilter === "sms" && sendBodySource === "draft") {
        setSendBody("");
        setSendBodySource("system");
      }
      if (messageFilter === "email" && !emailManualMode) {
        setSendBody("");
        setSendBodySource("system");
      }
      await loadConversation(selectedConv.id);
      await load();
    } catch {
      window.alert("Failed to clear draft");
    } finally {
      setClearDraftBusy(false);
    }
  }

  async function submitMessageFeedback(messageId: string, rating: "up" | "down") {
    if (!selectedConv) return;
    const existing = (selectedConv.messages ?? []).find(m => m.id === messageId);
    if (!existing) return;
    const shouldClear = existing.feedback?.rating === rating;
    let note = "";
    if (!shouldClear && rating === "down") {
      const input = window.prompt("Optional: what was wrong with this response?");
      if (input === null) return;
      note = input.trim();
    }

    setMessageFeedbackBusy(prev => ({ ...prev, [messageId]: true }));
    try {
      const resp = await fetch(
        `/api/conversations/${encodeURIComponent(selectedConv.id)}/messages/${encodeURIComponent(messageId)}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            shouldClear
              ? { clear: true }
              : {
                  rating,
                  note: note || undefined
                }
          )
        }
      );
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        window.alert(data?.error ?? "Failed to save feedback");
        return;
      }

      if (data?.conversation) {
        const conv = data.conversation;
        setSelectedConv(conv);
        setConversations(prev =>
          prev.map(c =>
            c.id === conv.id
              ? {
                  ...c,
                  updatedAt: conv.updatedAt ?? c.updatedAt,
                  messageCount: conv.messages?.length ?? c.messageCount
                }
              : c
          )
        );
      }
      setSaveToast(shouldClear ? "Feedback removed." : rating === "up" ? "Marked helpful." : "Marked needs work.");
    } catch {
      window.alert("Failed to save feedback");
    } finally {
      setMessageFeedbackBusy(prev => ({ ...prev, [messageId]: false }));
    }
  }

  function printCurrentConversationWindow() {
    if (!selectedConv) return;
    const label =
      messageFilter === "email" ? "Email" : messageFilter === "calls" ? "Call Script" : "SMS";
    const leadName =
      selectedConv.lead?.name ||
      [selectedConv.lead?.firstName, selectedConv.lead?.lastName].filter(Boolean).join(" ") ||
      selectedConv.leadKey;
    const rows = filteredMessages
      .map(m => {
        const provider = m.provider ?? "?";
        const providerLabel =
          provider === "voice_call"
            ? "call"
            : provider === "voice_transcript"
              ? "call transcript"
              : provider === "voice_summary"
                ? "call summary"
                : provider;
        const body =
          m.direction === "in" && provider === "sendgrid"
            ? cleanInboundEmailForDisplay(m.body)
            : m.direction === "in" && provider === "sendgrid_adf"
              ? cleanAdfLeadForDisplay(m.body)
              : m.body;
        const summaryText = (() => {
          if (provider !== "voice_transcript") return "";
          const id = m.providerMessageId ?? "";
          if (id && callSummaryLookup.byId.has(id)) return callSummaryLookup.byId.get(id) ?? "";
          const idxFull = callSummaryLookup.indexById.get(m.id);
          if (idxFull == null) return "";
          const prev = callSummaryLookup.full[idxFull - 1];
          const next = callSummaryLookup.full[idxFull + 1];
          if (prev?.provider === "voice_summary") return String(prev.body ?? "");
          if (next?.provider === "voice_summary") return String(next.body ?? "");
          return "";
        })();
        const bodyHtml = escapeHtml(String(body ?? "")).replace(/\n/g, "<br>");
        const summaryHtml = summaryText
          ? `<div class="summary"><strong>Call Summary:</strong><br>${escapeHtml(summaryText).replace(/\n/g, "<br>")}</div>`
          : "";
        return `<div class="msg">
  <div class="meta">${escapeHtml(m.direction.toUpperCase())} • ${escapeHtml(providerLabel)} • ${escapeHtml(
          new Date(m.at).toLocaleString()
        )}</div>
  <div class="body">${bodyHtml || "&nbsp;"}</div>
  ${summaryHtml}
</div>`;
      })
      .join("\n");
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(label)} - ${escapeHtml(leadName)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    h1 { margin: 0 0 4px; font-size: 20px; }
    .sub { margin: 0 0 16px; color: #555; font-size: 13px; }
    .msg { border: 1px solid #ddd; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
    .meta { font-size: 12px; color: #666; margin-bottom: 6px; }
    .body { font-size: 14px; line-height: 1.4; white-space: normal; }
    .summary { margin-top: 8px; font-size: 13px; background: #f7f7f7; border: 1px solid #e5e5e5; border-radius: 6px; padding: 8px; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom: 12px;">
    <button aria-label="Print" title="Print" onclick="window.print()" style="padding:6px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 9V2h12v7"></path>
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v5a2 2 0 0 1-2 2h-2"></path>
        <rect x="6" y="14" width="12" height="8"></rect>
      </svg>
    </button>
  </div>
  <h1>${escapeHtml(label)} Conversation</h1>
  <p class="sub">${escapeHtml(leadName)}${selectedConv.lead?.phone ? ` • ${escapeHtml(selectedConv.lead.phone)}` : ""}</p>
  ${rows || "<p>No messages in this view.</p>"}
</body>
</html>`;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    try {
      printWindow.focus();
      const triggerPrint = () => {
        try {
          printWindow.print();
        } catch {}
      };
      if (printWindow.document.readyState === "complete") {
        setTimeout(triggerPrint, 150);
      } else {
        printWindow.onload = () => setTimeout(triggerPrint, 150);
      }
    } catch {}
  }

  async function startCall(
    method?: "cell" | "extension",
    convOverride?: ConversationDetail | null
  ) {
    const target = convOverride ?? selectedConv;
    if (!target || callBusy) return;
    if (!authUser?.phone && !authUser?.extension) {
      window.alert("No phone or extension configured for your user.");
      return;
    }
    setCallBusy(true);
    try {
      const methodToUse = method ?? callMethod;
      const resp = await fetch(`/api/conversations/${encodeURIComponent(target.id)}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useExtension: methodToUse === "extension" })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        window.alert(data?.error ?? "Call failed");
      } else {
        setSaveToast("Call started");
        await refreshTodos();
      }
    } catch {
      window.alert("Call failed");
    } finally {
      setCallBusy(false);
    }
  }

  async function openCallFromTodo(todo: TodoItem) {
    if (callBusy) return;
    if (!authUser?.phone && !authUser?.extension) {
      window.alert("No phone or extension configured for your user.");
      return;
    }
    openConversation(todo.convId);
    const conv = await fetchConversationDetail(todo.convId);
    if (conv) setSelectedConv(conv);
    if (authUser?.phone && authUser?.extension) {
      setCallPickerOpen(true);
      return;
    }
    if (authUser?.extension && !authUser?.phone) {
      await startCall("extension", conv ?? selectedConv);
      return;
    }
    await startCall("cell", conv ?? selectedConv);
  }

  function openManualAppointment() {
    if (!selectedConv) return;
    const tz = schedulerConfig?.timezone ?? "America/New_York";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const inferred = inferAppointmentTypeForConv(selectedConv);
    const hasInferred = manualAppointmentTypes.some(row => row.key === inferred);
    const type = hasInferred ? inferred : manualAppointmentTypes[0]?.key ?? "inventory_visit";
    const defaultTime = schedulerConfig?.bookingWindows?.weekday?.earliestStart ?? "09:30";
    setManualApptForm({
      date: today,
      time: defaultTime,
      appointmentType: type,
      salespersonId: resolveDefaultSalespersonId(),
      notes: ""
    });
    setManualApptError(null);
    setManualApptOpen(true);
  }

  async function saveManualAppointment() {
    if (!selectedConv) return;
    setManualApptSaving(true);
    setManualApptError(null);
    try {
      if (!manualApptForm.salespersonId) {
        throw new Error("Select a salesperson.");
      }
      const resp = await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/appointment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: manualApptForm.date.trim(),
          time: manualApptForm.time.trim(),
          appointmentType: manualApptForm.appointmentType,
          salespersonId: manualApptForm.salespersonId,
          notes: manualApptForm.notes
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Failed to set appointment");
      }
      if (data?.conversation) {
        setSelectedConv(data.conversation);
      } else {
        await loadConversation(selectedConv.id);
      }
      if (data?.sms?.sent === false) {
        const reason = String(data?.sms?.reason ?? "");
        const label = reason ? `SMS not sent (${reason})` : "SMS not sent";
        setSaveToast(`Appointment set — ${label}.`);
      } else if (data?.sms?.sent === true) {
        setSaveToast("Appointment set and confirmation sent.");
      }
      await load();
      setManualApptOpen(false);
    } catch (err: any) {
      setManualApptError(err?.message ?? "Failed to set appointment");
    } finally {
      setManualApptSaving(false);
    }
  }

  async function clearContactPreference() {
    if (!selectedConv) return;
    const ok = window.confirm(
      "This lead requested call only. Allow SMS for this lead?"
    );
    if (!ok) return;
    await fetch(
      `/api/conversations/${encodeURIComponent(selectedConv.id)}/contact-preference`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactPreference: null })
      }
    );
    await loadConversation(selectedConv.id);
    await load();
  }

  const stopAgentContextSpeech = useCallback(() => {
    try {
      agentContextSpeechRef.current?.stop();
    } catch {}
    setAgentContextSpeechListening(false);
  }, []);

  const startAgentContextSpeech = useCallback(() => {
    if (agentContextSpeechListening) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setAgentContextSpeechSupported(false);
      setAgentContextSpeechError("Voice input is not supported on this device/browser.");
      return;
    }
    let recognizer = agentContextSpeechRef.current;
    if (!recognizer) {
      recognizer = new Ctor();
      recognizer.lang = "en-US";
      recognizer.continuous = true;
      recognizer.interimResults = true;
      recognizer.maxAlternatives = 1;
      recognizer.onresult = (event: any) => {
        if (!event?.results) return;
        let interim = "";
        const from = Number.isFinite(Number(event?.resultIndex)) ? Number(event.resultIndex) : 0;
        for (let i = from; i < event.results.length; i += 1) {
          const text = String(event.results?.[i]?.[0]?.transcript ?? "").trim();
          if (!text) continue;
          if (event.results[i]?.isFinal) {
            agentContextSpeechFinalRef.current = `${agentContextSpeechFinalRef.current} ${text}`.trim();
          } else {
            interim = `${interim} ${text}`.trim();
          }
        }
        const combined = [
          agentContextSpeechBaseRef.current,
          agentContextSpeechFinalRef.current,
          interim
        ]
          .map(s => String(s ?? "").trim())
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        setAgentContextText(combined);
      };
      recognizer.onerror = (event: any) => {
        const code = String(event?.error ?? "").trim().toLowerCase();
        const msg =
          code === "not-allowed" || code === "service-not-allowed"
            ? "Microphone access is blocked. Allow microphone permission and try again."
            : code === "no-speech"
              ? "No speech detected. Tap start, speak, then tap stop."
              : code
                ? `Voice input error: ${code}`
                : "Voice input failed.";
        setAgentContextSpeechError(msg);
      };
      recognizer.onend = () => {
        setAgentContextSpeechListening(false);
      };
      agentContextSpeechRef.current = recognizer;
    }
    agentContextSpeechBaseRef.current = String(agentContextText ?? "").trim();
    agentContextSpeechFinalRef.current = "";
    setAgentContextSpeechError(null);
    try {
      recognizer.start();
      setAgentContextSpeechListening(true);
    } catch (err: any) {
      const message = String(err?.message ?? err ?? "");
      if (/already started/i.test(message)) {
        setAgentContextSpeechListening(true);
        return;
      }
      setAgentContextSpeechError("Could not start voice input. Try again.");
    }
  }, [agentContextSpeechListening, agentContextText]);

  async function saveAgentContext(opts?: { addNote?: boolean }) {
    if (!selectedConv) return;
    setAgentContextSaving(true);
    setAgentContextError(null);
    try {
      const text = agentContextText.trim();
      const addNote = opts?.addNote === true;
      if (addNote && !text) {
        throw new Error("Enter a context note first.");
      }
      const expiresInput = agentContextExpiresAt.trim();
      let expiresAt: string | undefined;
      if (expiresInput) {
        const d = new Date(expiresInput);
        if (Number.isNaN(d.getTime())) {
          throw new Error("Invalid expiration date/time.");
        }
        expiresAt = d.toISOString();
      }
      const resp = await fetch(
        `/api/conversations/${encodeURIComponent(selectedConv.id)}/agent-context`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            mode: agentContextMode,
            expiresAt,
            addNote
          })
        }
      );
      const data = await resp.json().catch(() => null);
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Failed to save agent context");
      }
      if (data?.conversation) {
        setSelectedConv(data.conversation);
      } else {
        await loadConversation(selectedConv.id);
      }
      await load();
      if (addNote) {
        setAgentContextText("");
        setSaveToast("Context note added.");
      } else {
        setSaveToast(text ? "Agent context saved." : "Agent context cleared.");
      }
    } catch (err: any) {
      setAgentContextError(err?.message ?? "Failed to save agent context");
    } finally {
      setAgentContextSaving(false);
    }
  }

  async function clearAgentContextNow() {
    if (!selectedConv) return;
    setAgentContextSaving(true);
    setAgentContextError(null);
    try {
      const resp = await fetch(
        `/api/conversations/${encodeURIComponent(selectedConv.id)}/agent-context`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear: true })
        }
      );
      const data = await resp.json().catch(() => null);
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Failed to clear agent context");
      }
      setAgentContextText("");
      setAgentContextMode("persistent");
      setAgentContextExpiresAt("");
      if (data?.conversation) {
        setSelectedConv(data.conversation);
      } else {
        await loadConversation(selectedConv.id);
      }
      await load();
      setSaveToast("Agent context cleared.");
    } catch (err: any) {
      setAgentContextError(err?.message ?? "Failed to clear agent context");
    } finally {
      setAgentContextSaving(false);
    }
  }

  async function closeConv() {
    if (!selectedConv) return;
    if (!closeReason) {
      window.alert("Please choose a lead update option.");
      return;
    }
    if (closeReason === "hold") {
      await openHoldModal(selectedConv.id);
      return;
    }
    if (closeReason === "sold" && !soldById && soldByOptions.length) {
      window.alert("Please select who sold the bike.");
      return;
    }
    if (closeReason === "sold") {
      await openSoldModal(selectedConv.id);
      return;
    }
    await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: closeReason })
    });
    await loadConversation(selectedConv.id);
    await load();
  }

  async function reopenConv() {
    if (!selectedConv) return;
    await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/reopen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    await loadConversation(selectedConv.id);
    await load();
  }

  async function deleteConv() {
    if (!selectedConv) return;
    const ok = window.confirm(
      "Delete this conversation permanently? This cannot be undone."
    );
    if (!ok) return;
    await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}`, {
      method: "DELETE"
    });
    setSelectedConv(null);
    setSelectedId(null);
    setConversations(prev => prev.filter(c => c.id !== selectedConv.id));
    await load();
  }

  async function deleteConvFromList(id: string) {
    const ok = window.confirm("Delete this conversation permanently? This cannot be undone.");
    if (!ok) return;
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (selectedId === id) {
      setSelectedConv(null);
      setSelectedId(null);
    }
    setConversations(prev => prev.filter(c => c.id !== id));
    await load();
  }

  function openReassignLeadInline(conv: ConversationListItem) {
    setTodoInlineOpenId(null);
    setTodoInlineText("");
    setReminderInlineOpenId(null);
    setReminderInlineText("");
    setReminderInlineTarget(isManager ? "lead_owner" : "self");
    setReminderInlineDueAt("");
    setReminderInlineLeadMinutes("30");
    setContactInlineOpenId(null);
    const currentOwnerId = String(conv.leadOwner?.id ?? "").trim();
    const hasCurrentOwnerOption = reassignSalesOwnerOptions.some(o => o.id === currentOwnerId);
    setReassignInlineTarget(hasCurrentOwnerOption ? `owner:${currentOwnerId}` : "department:service");
    setReassignInlineSummary("");
    setReassignInlineOpenId(conv.id);
  }

  async function reassignLeadInline(conv: ConversationListItem) {
    const summary = reassignInlineSummary.trim();
    setReassignInlineSaving(true);
    const isOwnerTarget = reassignInlineTarget.startsWith("owner:");
    const resp = isOwnerTarget
      ? await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/lead-owner`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ownerId: reassignInlineTarget.slice("owner:".length)
          })
        })
      : await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/department`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            department: reassignInlineTarget.replace("department:", ""),
            summary:
              summary ||
              `Manual reassignment to ${reassignInlineTarget.replace("department:", "")} department`
          })
        });
    const data = await resp.json().catch(() => null);
    setReassignInlineSaving(false);
    if (!resp.ok || data?.ok === false) {
      window.alert(data?.error ?? "Failed to reassign lead");
      return;
    }
    setReassignInlineOpenId(null);
    setReassignInlineTarget("department:service");
    setReassignInlineSummary("");
    setListActionsOpenId(null);
    if (selectedId === conv.id) {
      await loadConversation(conv.id);
    }
    await load();
  }

  async function submitTodoInline(conv: ConversationListItem) {
    const summary = todoInlineText.trim();
    if (!summary) {
      window.alert("Please enter what the salesperson should do.");
      return;
    }
    const target = isManager ? todoInlineTarget : "self";
    let reason = "other";
    let ownerId = "";
    let ownerName = "";
    if (target === "lead_owner") {
      ownerId = String(conv.leadOwner?.id ?? "").trim();
      ownerName = String(conv.leadOwner?.name ?? "").trim();
    } else if (target.startsWith("owner:")) {
      ownerId = target.slice("owner:".length).trim();
      if (ownerId) {
        ownerName = reassignSalesOwnerOptions.find(o => o.id === ownerId)?.name ?? "";
      }
    } else if (target.startsWith("department:")) {
      const role = target.slice("department:".length).trim().toLowerCase();
      if (role === "service" || role === "parts" || role === "apparel") {
        reason = role;
        ownerId = String(departmentOwnerByRole[role]?.id ?? "").trim();
        ownerName =
          String(departmentOwnerByRole[role]?.name ?? "").trim() ||
          `${role[0].toUpperCase()}${role.slice(1)} Department`;
      }
    }
    const resp = await fetch("/api/todos/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        convId: conv.id,
        summary,
        reason,
        ownerId: ownerId || undefined,
        ownerName: ownerName || undefined
      })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || data?.ok === false) {
      window.alert(data?.error ?? "Failed to create To Do");
      return;
    }
    setTodoInlineOpenId(null);
    setTodoInlineText("");
    setTodoInlineTarget(isManager ? "lead_owner" : "self");
    setListActionsOpenId(null);
    await load();
  }

  async function submitReminderInline(conv: ConversationListItem) {
    const summary = reminderInlineText.trim();
    if (!summary) {
      window.alert("Please enter what to remind about.");
      return;
    }
    const dueLocal = reminderInlineDueAt.trim();
    if (!dueLocal) {
      window.alert("Please select reminder date and time.");
      return;
    }
    const dueDate = new Date(dueLocal);
    if (Number.isNaN(dueDate.getTime())) {
      window.alert("Invalid reminder date/time.");
      return;
    }
    const reminderLeadRaw = Number(reminderInlineLeadMinutes);
    const reminderLeadMinutes =
      Number.isFinite(reminderLeadRaw) && reminderLeadRaw > 0 ? Math.round(reminderLeadRaw) : 30;
    const dueAt = dueDate.toISOString();
    const reminderAt = new Date(dueDate.getTime() - reminderLeadMinutes * 60 * 1000).toISOString();

    const target = isManager ? reminderInlineTarget : "self";
    let ownerId = "";
    let ownerName = "";
    if (target === "lead_owner") {
      ownerId = String(conv.leadOwner?.id ?? "").trim();
      ownerName = String(conv.leadOwner?.name ?? "").trim();
    } else if (target.startsWith("owner:")) {
      ownerId = target.slice("owner:".length).trim();
      if (ownerId) {
        ownerName = reassignSalesOwnerOptions.find(o => o.id === ownerId)?.name ?? "";
      }
    } else if (target.startsWith("department:")) {
      const role = target.slice("department:".length).trim().toLowerCase();
      if (role === "service" || role === "parts" || role === "apparel") {
        ownerId = String(departmentOwnerByRole[role]?.id ?? "").trim();
        ownerName =
          String(departmentOwnerByRole[role]?.name ?? "").trim() ||
          `${role[0].toUpperCase()}${role.slice(1)} Department`;
      }
    }

    setReminderInlineSaving(true);
    try {
      const resp = await fetch("/api/todos/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          convId: conv.id,
          summary,
          reason: "call",
          taskClass: "reminder",
          dueAt,
          reminderAt,
          reminderLeadMinutes,
          ownerId: ownerId || undefined,
          ownerName: ownerName || undefined
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || data?.ok === false) {
        window.alert(data?.error ?? "Failed to set reminder");
        return;
      }
      setReminderInlineOpenId(null);
      setReminderInlineText("");
      setReminderInlineTarget(isManager ? "lead_owner" : "self");
      setReminderInlineDueAt("");
      setReminderInlineLeadMinutes("30");
      setListActionsOpenId(null);
      await load();
    } finally {
      setReminderInlineSaving(false);
    }
  }

  function openInlineContactFromConversation(c: ConversationListItem) {
    const linkedContact = findLinkedContactForConversation(c);
    const selectedLead = selectedConv?.id === c.id ? selectedConv.lead : null;
    const name = splitContactName(c.leadName ?? selectedLead?.name ?? "");
    const leadKey = String(c.leadKey ?? "").trim();
    const phone =
      String(linkedContact?.phone ?? "").trim() ||
      String(selectedLead?.phone ?? "").trim() ||
      (isLikelyPhoneLeadKey(leadKey) ? leadKey : "");
    const email =
      String(linkedContact?.email ?? "").trim() ||
      String(selectedLead?.email ?? "").trim() ||
      (leadKey.includes("@") ? leadKey : "");
    setContactInlineForm({
      firstName:
        String(linkedContact?.firstName ?? "").trim() ||
        String(selectedLead?.firstName ?? "").trim() ||
        name.firstName,
      lastName:
        String(linkedContact?.lastName ?? "").trim() ||
        String(selectedLead?.lastName ?? "").trim() ||
        name.lastName,
      phone,
      email
    });
    setTodoInlineOpenId(null);
    setTodoInlineText("");
    setTodoInlineTarget(isManager ? "lead_owner" : "self");
    setReminderInlineOpenId(null);
    setReminderInlineText("");
    setReminderInlineTarget(isManager ? "lead_owner" : "self");
    setReminderInlineDueAt("");
    setReminderInlineLeadMinutes("30");
    setContactInlineOpenId(c.id);
  }

  async function submitInlineContact(c: ConversationListItem) {
    const body = {
      firstName: contactInlineForm.firstName.trim(),
      lastName: contactInlineForm.lastName.trim(),
      phone: contactInlineForm.phone.trim(),
      email: contactInlineForm.email.trim()
    };
    if (!body.phone && !body.email) {
      window.alert("Please enter at least phone or email.");
      return;
    }
    setContactInlineSaving(true);
    try {
      const resp = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          name: [body.firstName, body.lastName].filter(Boolean).join(" ").trim() || undefined,
          leadKey: c.leadKey,
          conversationId: c.id
        })
      });
      const payload = await resp.json().catch(() => null);
      if (!resp.ok || !payload?.ok) {
        window.alert(payload?.error ?? "Failed to create contact");
        return;
      }
      setContactInlineOpenId(null);
      setContactInlineForm({ firstName: "", lastName: "", phone: "", email: "" });
      setListActionsOpenId(null);
      setSaveToast("Contact saved");
      setTimeout(() => setSaveToast(null), 2000);
      await load();
      if (payload?.contact?.id) {
        setSelectedContact(payload.contact as ContactItem);
      }
    } finally {
      setContactInlineSaving(false);
    }
  }

  async function setHumanMode(next: "human" | "suggest") {
    if (!selectedConv) return;
    await setHumanModeForId(selectedConv.id, next, true);
  }

  async function setHumanModeForId(id: string, next: "human" | "suggest", updateSelected = false) {
    setModeSaving(true);
    setModeError(null);
    if (updateSelected) {
      setSelectedConv(prev => (prev ? { ...prev, mode: next } : prev));
    }
    const resp = await fetch(`/api/conversations/${encodeURIComponent(id)}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next })
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || payload?.ok === false) {
      setModeError(payload?.error ?? "Failed to update mode");
    }
    if (payload?.conversation && updateSelected) setSelectedConv(payload.conversation);
    await load();
    setModeSaving(false);
  }

  async function addSuppression() {
    const phone = newSuppression.trim();
    if (!phone) return;
    await fetch("/api/suppressions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, reason: "manual" })
    });
    setNewSuppression("");
    await load();
  }

  async function removeSuppression(phone: string) {
    await fetch(`/api/suppressions?phone=${encodeURIComponent(phone)}`, { method: "DELETE" });
    await load();
  }

  async function saveContact() {
    if (!selectedContact) return;
    const resp = await fetch(`/api/contacts/${encodeURIComponent(selectedContact.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contactForm)
    });
    const payload = await resp.json().catch(() => null);
    if (payload?.contact) {
      const updated = payload.contact as ContactItem;
      setSelectedContact(updated);
      setContacts(prev => prev.map(c => (c.id === updated.id ? { ...c, ...updated } : c)));
      setContactEdit(false);
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSection("inbox");
      setSaveToast("Saved");
    }
  }

  async function deleteContact() {
    if (!selectedContact) return;
    const ok = window.confirm("Delete this contact permanently? This cannot be undone.");
    if (!ok) return;
    await fetch(`/api/contacts/${encodeURIComponent(selectedContact.id)}`, { method: "DELETE" });
    setContacts(prev => prev.filter(c => c.id !== selectedContact.id));
    setSelectedContact(null);
  }

  async function createContactGroup() {
    const name = newContactListName.trim();
    if (!name) return;
    const resp = await fetch("/api/contacts/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, source: "manual" })
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || !payload?.ok) return;
    setNewContactListName("");
    setContactLists(prev => [payload.list as ContactListItem, ...prev]);
    setSelectedContactListId(payload.list.id);
  }

  async function saveGroupFilter() {
    if (selectedContactListId === "all") return;
    const body = {
      filter: {
        condition: contactListFilterForm.condition.trim(),
        year: contactListFilterForm.year.trim(),
        make: contactListFilterForm.make.trim(),
        model: contactListFilterForm.model.trim()
      }
    };
    const resp = await fetch(`/api/contacts/lists/${encodeURIComponent(selectedContactListId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || !payload?.ok) return;
    await load();
  }

  async function deleteGroup() {
    if (selectedContactListId === "all") return;
    const ok = window.confirm("Delete this group?");
    if (!ok) return;
    await fetch(`/api/contacts/lists/${encodeURIComponent(selectedContactListId)}`, {
      method: "DELETE"
    });
    setSelectedContactListId("all");
    await load();
  }

  async function createNewContact() {
    const body = {
      firstName: newContactForm.firstName.trim(),
      lastName: newContactForm.lastName.trim(),
      phone: newContactForm.phone.trim(),
      email: newContactForm.email.trim()
    };
    if (!body.phone && !body.email) return;
    const resp = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || !payload?.ok) return;
    setNewContactOpen(false);
    setNewContactForm({ firstName: "", lastName: "", phone: "", email: "" });
    await load();
    if (payload?.contact?.id) {
      setSelectedContact(payload.contact as ContactItem);
    }
  }

  async function importContactsCsv(file: File) {
    setImportBusy(true);
    try {
      const raw = await file.text();
      const rows = parseContactCsv(raw);
      if (!rows.length) {
        setBroadcastResult("No valid rows found. Include at least phone or email columns.");
        return;
      }
      const listName = importListName.trim() || file.name.replace(/\.csv$/i, "");
      const resp = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, listName })
      });
      const payload = await resp.json().catch(() => null);
      if (!resp.ok || !payload?.ok) {
        setBroadcastResult(payload?.error ?? "CSV import failed");
        return;
      }
      setImportListName("");
      setBroadcastResult(`Imported ${payload.imported ?? 0} contacts.`);
      await load();
      if (payload?.list?.id) {
        setSelectedContactListId(payload.list.id);
      }
    } finally {
      setImportBusy(false);
    }
  }

  async function sendBroadcastToSelectedGroup() {
    if (selectedContactListId === "all") {
      setBroadcastResult("Select a group first.");
      return;
    }
    const message = broadcastBody.trim();
    if (!message) return;
    setBroadcastBusy(true);
    setBroadcastResult(null);
    try {
      const selectedCampaign = campaigns.find(c => c.id === campaignSelectedId) ?? null;
      const campaignName =
        String(selectedCampaign?.name ?? "").trim() ||
        campaignForm.name.trim() ||
        String(selectedContactList?.name ?? "").trim() ||
        undefined;
      const resp = await fetch("/api/contacts/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listId: selectedContactListId,
          message,
          campaignId: selectedCampaign?.id || undefined,
          campaignName
        })
      });
      const payload = await resp.json().catch(() => null);
      if (!resp.ok || !payload?.ok) {
        setBroadcastResult(payload?.error ?? "Broadcast failed");
        return;
      }
      setBroadcastResult(
        `Sent ${payload.sent}/${payload.attempted}. Skipped ${payload.skipped}, failed ${payload.failed}.`
      );
    } finally {
      setBroadcastBusy(false);
    }
  }


  async function saveDealerProfile() {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const hours = dealerHours ?? {};
      const existingPolicies =
        dealerProfile &&
        typeof dealerProfile === "object" &&
        dealerProfile.policies &&
        typeof dealerProfile.policies === "object"
          ? dealerProfile.policies
          : {};
      const existingCampaign =
        dealerProfile &&
        typeof dealerProfile === "object" &&
        dealerProfile.campaign &&
        typeof dealerProfile.campaign === "object"
          ? dealerProfile.campaign
          : {};
      const campaignWebBannerWidthFromForm = Number(dealerProfileForm.campaignWebBannerWidth);
      const campaignWebBannerHeightFromForm = Number(dealerProfileForm.campaignWebBannerHeight);
      const campaignWebBannerInsetPercentFromForm = Number(dealerProfileForm.campaignWebBannerInsetPercent);
      const campaignWebBannerWidthFallback = Number(
        (existingCampaign as any)?.webBannerWidth ?? (dealerProfile as any)?.webBannerWidth
      );
      const campaignWebBannerHeightFallback = Number(
        (existingCampaign as any)?.webBannerHeight ?? (dealerProfile as any)?.webBannerHeight
      );
      const campaignWebBannerInsetPercentFallback = Number(
        (existingCampaign as any)?.webBannerInsetPercent ?? (dealerProfile as any)?.webBannerInsetPercent
      );
      const campaignWebBannerWidth =
        Number.isFinite(campaignWebBannerWidthFromForm) && campaignWebBannerWidthFromForm > 0
          ? Math.round(campaignWebBannerWidthFromForm)
          : Number.isFinite(campaignWebBannerWidthFallback) && campaignWebBannerWidthFallback > 0
            ? Math.round(campaignWebBannerWidthFallback)
            : undefined;
      const campaignWebBannerHeight =
        Number.isFinite(campaignWebBannerHeightFromForm) && campaignWebBannerHeightFromForm > 0
          ? Math.round(campaignWebBannerHeightFromForm)
          : Number.isFinite(campaignWebBannerHeightFallback) && campaignWebBannerHeightFallback > 0
            ? Math.round(campaignWebBannerHeightFallback)
            : undefined;
      const campaignWebBannerInsetPercent =
        Number.isFinite(campaignWebBannerInsetPercentFromForm) && campaignWebBannerInsetPercentFromForm >= 0
          ? Math.max(0, Math.min(25, campaignWebBannerInsetPercentFromForm))
          : Number.isFinite(campaignWebBannerInsetPercentFallback) && campaignWebBannerInsetPercentFallback >= 0
            ? Math.max(0, Math.min(25, campaignWebBannerInsetPercentFallback))
            : undefined;
      const payload = {
        dealerName: dealerProfileForm.dealerName.trim(),
        agentName: dealerProfileForm.agentName.trim(),
        crmProvider: dealerProfileForm.crmProvider.trim(),
        websiteProvider: dealerProfileForm.websiteProvider.trim(),
        fromEmail: dealerProfileForm.fromEmail.trim(),
        replyToEmail: dealerProfileForm.replyToEmail.trim(),
        emailSignature: dealerProfileForm.emailSignature,
        logoUrl: dealerProfileForm.logoUrl.trim(),
        bookingUrl: dealerProfileForm.bookingUrl.trim(),
        bookingToken: dealerProfileForm.bookingToken.trim(),
        creditAppUrl: dealerProfileForm.creditAppUrl.trim(),
        policies: {
          ...existingPolicies,
          lienHolderResponse: dealerProfileForm.lienHolderResponse.trim(),
          riderToRiderFinancingEnabled: !!dealerProfileForm.riderToRiderFinancingEnabled
        },
        phone: dealerProfileForm.phone.trim(),
        website: dealerProfileForm.website.trim(),
        address: {
          line1: dealerProfileForm.addressLine1.trim(),
          city: dealerProfileForm.city.trim(),
          state: dealerProfileForm.state.trim(),
          zip: dealerProfileForm.zip.trim()
        },
        hours,
        followUp: {
          testRideEnabled: !!dealerProfileForm.testRideEnabled,
          testRideMonths: dealerProfileForm.testRideMonths ?? [4, 5, 6, 7, 8, 9, 10]
        },
        weather: {
          pickupRadiusMiles: Number(dealerProfileForm.weatherPickupRadiusMiles) || 25,
          coldThresholdF: Number(dealerProfileForm.weatherColdThresholdF) || 50,
          forecastHours: Number(dealerProfileForm.weatherForecastHours) || 48
        },
        buying: {
          usedBikesEnabled: !!dealerProfileForm.buyingUsedBikesEnabled
        },
        webSearch: {
          referenceUrls: (dealerProfileForm.webSearchReferenceUrls ?? [])
            .map(v => String(v ?? "").trim())
            .filter(Boolean),
          useGooglePlacePhotos: !!dealerProfileForm.webSearchUseGooglePlacePhotos,
          googlePlaceId: String(dealerProfileForm.webSearchGooglePlaceId ?? "").trim()
        },
        campaign: {
          ...(existingCampaign as Record<string, any>),
          webBannerWidth: campaignWebBannerWidth,
          webBannerHeight: campaignWebBannerHeight,
          webBannerInsetPercent: campaignWebBannerInsetPercent,
          webBannerFit:
            dealerProfileForm.campaignWebBannerFit === "contain" ||
            dealerProfileForm.campaignWebBannerFit === "cover"
              ? dealerProfileForm.campaignWebBannerFit
              : "auto"
        },
        taxRate: Number(dealerProfileForm.taxRate) || 0
      };
      const resp = await fetch("/api/dealer-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to save dealer profile");
      const saved = json?.profile ?? payload;
      setDealerProfile(saved);
      setDealerHours(saved?.hours ?? hours);
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to save dealer profile");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function saveSchedulerConfig() {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const businessHours = normalizeBusinessHours(schedulerHours ?? {});
      const invalidDays = Object.entries(businessHours)
        .filter(([, v]) => v.open && v.close && v.close <= v.open)
        .map(([day]) => day);
      if (invalidDays.length) {
        setSettingsError(`Close time must be after open time: ${invalidDays.join(", ")}`);
        setSettingsSaving(false);
        return;
      }
      const salespeople = (usersList ?? [])
        .filter(
          (u: any) =>
            !!u.calendarId &&
            (u.role === "salesperson" || (u.role === "manager" && u.includeInSchedule))
        )
        .map((u: any) => ({
          id: String(u.id),
          name: String(u.name || u.email || u.id),
          calendarId: String(u.calendarId || "")
        }))
        .filter((s: any) => s.id && s.name && s.calendarId);
      const appointmentTypes = appointmentTypesList.reduce<Record<string, { durationMinutes: number; colorId?: string }>>(
        (acc, row) => {
          const key = row.key.trim();
          if (!key) return acc;
          const mins = Number(row.durationMinutes || 0);
          const colorId = String(row.colorId ?? "").trim();
          acc[key] = { durationMinutes: mins > 0 ? mins : 60, ...(colorId ? { colorId } : {}) };
          return acc;
        },
        {}
      );
      const payload = {
        ...(schedulerConfig ?? {}),
        timezone: schedulerForm.timezone.trim(),
        assignmentMode: schedulerForm.assignmentMode,
        minLeadTimeHours: Number(schedulerForm.minLeadTimeHours || 0),
        minGapBetweenAppointmentsMinutes: Number(schedulerForm.minGapBetweenAppointmentsMinutes || 0),
        bookingWindows: {
          weekday: {
            earliestStart: schedulerForm.weekdayEarliest.trim(),
            latestStart: schedulerForm.weekdayLatest.trim()
          },
          saturday: {
            earliestStart: schedulerForm.saturdayEarliest.trim(),
            latestStart: schedulerForm.saturdayLatest.trim()
          }
        },
        businessHours,
        salespeople,
        preferredSalespeople: preferredOrderIds,
        appointmentTypes,
        availabilityBlocks
      };
      const resp = await fetch("/api/scheduler-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to save scheduler config");
      const saved = json?.config ?? payload;
      setSchedulerConfig(saved);
      setSchedulerHours(saved?.businessHours ?? businessHours);
      setSchedulerForm({
        timezone: saved.timezone ?? schedulerForm.timezone,
        assignmentMode: saved.assignmentMode ?? schedulerForm.assignmentMode,
        minLeadTimeHours: String(saved.minLeadTimeHours ?? schedulerForm.minLeadTimeHours),
        minGapBetweenAppointmentsMinutes: String(
          saved.minGapBetweenAppointmentsMinutes ?? schedulerForm.minGapBetweenAppointmentsMinutes
        ),
        weekdayEarliest: saved.bookingWindows?.weekday?.earliestStart ?? schedulerForm.weekdayEarliest,
        weekdayLatest: saved.bookingWindows?.weekday?.latestStart ?? schedulerForm.weekdayLatest,
        saturdayEarliest: saved.bookingWindows?.saturday?.earliestStart ?? schedulerForm.saturdayEarliest,
        saturdayLatest: saved.bookingWindows?.saturday?.latestStart ?? schedulerForm.saturdayLatest
      });
      setSalespeopleList(saved?.salespeople ?? salespeople);
      setPreferredOrderIds(saved?.preferredSalespeople ?? []);
      setAvailabilityBlocks(saved?.availabilityBlocks ?? availabilityBlocks);
      const at = saved?.appointmentTypes ?? {};
      setAppointmentTypesList(
        Object.entries(at).map(([key, val]: any) => ({
          key,
          durationMinutes: String(val?.durationMinutes ?? 60),
          colorId: val?.colorId ? String(val.colorId) : ""
        }))
      );
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to save scheduler config");
    } finally {
      setSettingsSaving(false);
    }
  }

  const dayToRrule: Record<string, string> = {
    monday: "MO",
    tuesday: "TU",
    wednesday: "WE",
    thursday: "TH",
    friday: "FR",
    saturday: "SA",
    sunday: "SU"
  };

  function toggleBlockDay(day: string) {
    setBlockForm(prev => {
      const has = prev.days.includes(day);
      const nextDays = has ? prev.days.filter(d => d !== day) : [...prev.days, day];
      return { ...prev, days: nextDays.length ? nextDays : [day] };
    });
  }

  function normalizeBusinessHours(hours: Record<string, { open: string | null; close: string | null }>) {
    const next: Record<string, { open: string | null; close: string | null }> = {};
    for (const [day, val] of Object.entries(hours ?? {})) {
      const open = val?.open ?? null;
      let close = val?.close ?? null;
      if (open && close && close <= open) {
        const [h, m] = close.split(":").map(Number);
        if (!Number.isNaN(h)) {
          const bumped = h + 12;
          if (bumped <= 23) {
            const mm = String(m ?? 0).padStart(2, "0");
            close = `${String(bumped).padStart(2, "0")}:${mm}`;
          }
        }
      }
      next[day] = { open, close };
    }
    return next;
  }

  async function addAvailabilityBlock() {
    setSettingsError(null);
    const salespersonId = blockForm.salespersonId.trim();
    if (!salespersonId) {
      setSettingsError("Select a salesperson for the availability block.");
      return;
    }
    const daysSelected = blockForm.days.filter(Boolean);
    if (!daysSelected.length) {
      setSettingsError("Select at least one day.");
      return;
    }
    const title = blockForm.title.trim() || "Busy";
    const byDay = daysSelected.map(d => dayToRrule[d]).filter(Boolean);
    const rrule = `RRULE:FREQ=WEEKLY;BYDAY=${byDay.join(",")}`;
    const start = blockForm.allDay ? "00:00" : blockForm.start;
    const end = blockForm.allDay ? "23:59" : blockForm.end;
    try {
      const resp = await fetch("/api/scheduler/availability-blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salespersonId, title, rrule, start, end, days: daysSelected })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to add block");
      setAvailabilityBlocks(json?.config?.availabilityBlocks ?? availabilityBlocks);
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to add block");
    }
  }

  async function deleteAvailabilityBlock(salespersonId: string, eventId: string) {
    try {
      console.log("[availability] delete", { salespersonId, eventId });
      const resp = await fetch(
        `/api/scheduler/availability-blocks/${encodeURIComponent(salespersonId)}/${encodeURIComponent(eventId)}`,
        { method: "DELETE" }
      );
      const json = await resp.json();
      console.log("[availability] delete response", json);
      if (!resp.ok) throw new Error(json?.error ?? "Failed to delete block");
      if (json?.config?.availabilityBlocks) {
        setAvailabilityBlocks(json.config.availabilityBlocks);
        setSaveToast("Saved");
        return;
      }
      setAvailabilityBlocks(prev => ({
        ...prev,
        [salespersonId]: (prev[salespersonId] ?? []).filter(b => b.id !== eventId)
      }));
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to delete block");
    }
  }

  async function reloadUsers() {
    try {
      const resp = await fetch("/api/users", { cache: "no-store" });
      const json = await resp.json();
      if (resp.ok) setUsersList((json?.users ?? []).map(normalizeUserRow));
    } catch {
      // ignore
    }
  }

  async function reloadScheduler() {
    try {
      const resp = await fetch("/api/scheduler-config", { cache: "no-store" });
      const json = await resp.json();
      if (!resp.ok) return;
      const cfg = json?.config ?? {};
      setSchedulerConfig(cfg);
      if (section === "calendar" && Array.isArray(cfg.salespeople)) {
        setCalendarSalespeople(cfg.salespeople.map((s: any) => s.id));
      }
    } catch {
      // ignore
    }
  }

  async function addUser() {
    setSettingsError(null);
    try {
      const fullName = [userForm.firstName, userForm.lastName].filter(Boolean).join(" ").trim();
      const resp = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...userForm,
          name: fullName || userForm.name
        })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to add user");
      setUsersList(prev => [...prev, normalizeUserRow(json.user)]);
      await reloadScheduler();
      setEditingUserId(json.user?.id ?? null);
      setShowNewUserForm(false);
      if (json.user?.id) {
        setBlockForm(prev => ({ ...prev, salespersonId: json.user.id }));
      }
      setUserForm({
        email: "",
        password: "",
        name: "",
        firstName: "",
        lastName: "",
        emailSignature: "",
        phone: "",
        extension: "",
        role: "salesperson",
        includeInSchedule: false,
        calendarId: "",
        permissions: {
          canEditAppointments: false,
          canToggleHumanOverride: false,
          canAccessTodos: false,
          canAccessSuppressions: false
        }
      });
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to add user");
    }
  }

  async function updateUserRow(userId: string, patch: any) {
    setSettingsError(null);
    try {
      const resp = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to update user");
      const normalized = normalizeUserRow(json.user);
      setUsersList(prev => prev.map(u => (u.id === userId ? normalized : u)));
      if (authUser?.id === userId) {
        setAuthUser(normalized);
      }
      await reloadScheduler();
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to update user");
    }
  }

  async function deleteUserRow(userId: string) {
    setSettingsError(null);
    try {
      const resp = await fetch(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to delete user");
      setUsersList(prev => prev.filter(u => u.id !== userId));
      await reloadScheduler();
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to delete user");
    }
  }

  async function submitLogin() {
    setAuthError(null);
    try {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginForm.email, password: loginForm.password })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Login failed");
      setAuthUser(json?.user ?? null);
      setLoginForm({ email: "", password: "", name: "" });
      await load();
    } catch (err: any) {
      setAuthError(err?.message ?? "Login failed");
    }
  }

  async function submitForgotPassword() {
    setForgotError(null);
    setForgotMessage(null);
    const email = String(forgotEmail || loginForm.email || "").trim();
    if (!email) {
      setForgotError("Enter your email address.");
      return;
    }
    setForgotBusy(true);
    try {
      const resp = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to request reset link");
      setForgotMessage(json?.message ?? "If that account exists, a reset link has been sent.");
    } catch (err: any) {
      setForgotError(err?.message ?? "Failed to request reset link");
    } finally {
      setForgotBusy(false);
    }
  }

  async function saveCalendarEdit() {
    if (!calendarEdit?.calendarId) {
      setSaveToast("Missing calendar owner.");
      return;
    }
    if (!calendarEditForm.startDate || !calendarEditForm.startTime || !calendarEditForm.endDate || !calendarEditForm.endTime) {
      setSaveToast("Please set start and end date/time.");
      return;
    }
    const isCreate = !calendarEdit?.id;
    try {
      const url = isCreate
        ? "/api/calendar/events"
        : `/api/calendar/events/${encodeURIComponent(calendarEdit.calendarId)}/${encodeURIComponent(
            calendarEdit.id
          )}`;
      const resp = await fetch(url, {
        method: isCreate ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...calendarEditForm,
          timeZone: schedulerConfig?.timezone ?? "America/New_York",
          calendarId: calendarEditSalespersonId
            ? calendarUsers.find((u: any) => u.id === calendarEditSalespersonId)?.calendarId
            : calendarEdit.calendarId
        })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to update event");
      setCalendarEdit(null);
      setCalendarEditForm({
        summary: "",
        startDate: "",
        startTime: "",
        endDate: "",
        endTime: "",
        status: "scheduled",
        reason: "",
        colorId: ""
      });
      // refresh calendar
      const start = new Date(calendarDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      if (calendarView === "week") {
        end.setDate(end.getDate() + 7);
      } else {
        end.setDate(end.getDate() + 1);
      }
      const params = new URLSearchParams();
      params.set("start", start.toISOString());
      params.set("end", end.toISOString());
      if (calendarSalespeople.length) {
        params.set("userIds", calendarSalespeople.join(","));
      }
      const refresh = await fetch(`/api/calendar/events?${params.toString()}`, { cache: "no-store" });
      const refreshJson = await refresh.json();
      setCalendarEvents(buildCalendarEvents(refreshJson));
      setSaveToast("Saved");
    } catch (err: any) {
      const message = err?.message ?? "Failed to update event";
      setSettingsError(message);
      setSaveToast(message);
    }
  }

  async function updateCalendarEventTime(ev: any, startMin: number, endMin: number) {
    if (!schedulerConfig?.timezone) return;
    const day = calendarDate.toLocaleDateString("en-CA", { timeZone: schedulerConfig.timezone });
    const toHHMM = (m: number) => {
      const h = Math.floor(m / 60);
      const min = m % 60;
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    };
    const payload = {
      summary: ev.summary ?? "",
      startDate: day,
      startTime: toHHMM(startMin),
      endDate: day,
      endTime: toHHMM(endMin),
      status: "scheduled",
      reason: "",
      timeZone: schedulerConfig.timezone
    };
    try {
      const resp = await fetch(
        `/api/calendar/events/${encodeURIComponent(ev.calendarId)}/${encodeURIComponent(ev.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to update event");
      setSaveToast("Saved");
      setCalendarEvents(prev =>
        prev.map(item =>
          item.id === ev.id
            ? { ...item, _dragStart: undefined, _dragEnd: undefined }
            : item
        )
      );
      // refresh events
      const start = new Date(calendarDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      if (calendarView === "week") {
        end.setDate(end.getDate() + 7);
      } else {
        end.setDate(end.getDate() + 1);
      }
      const params = new URLSearchParams();
      params.set("start", start.toISOString());
      params.set("end", end.toISOString());
      if (calendarSalespeople.length) {
        params.set("userIds", calendarSalespeople.join(","));
      }
      const refresh = await fetch(`/api/calendar/events?${params.toString()}`, { cache: "no-store" });
      const refreshJson = await refresh.json();
      setCalendarEvents(buildCalendarEvents(refreshJson));
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to update event");
    }
  }

  function applyDragAt(clientY: number) {
    const state = dragStateRef.current;
    if (!state.mode || !state.event) return;
    const spId = state.event.salespersonId;
    const rect = calendarColumnRefs.current[spId]?.getBoundingClientRect();
    if (!rect) return;
    const totalMinutes = state.closeWindow - state.openWindow;
    const y = clientY - rect.top;
    const minutesFromTop = Math.max(0, Math.min(totalMinutes, (y / rect.height) * totalMinutes));
    const snap = 30;
    state.didMove = true;
    if (state.mode === "move") {
      const deltaMinutes = minutesFromTop - (state.origStartMin - state.openWindow);
      const rawStart = state.origStartMin + deltaMinutes;
      const duration = state.origEndMin - state.origStartMin;
      let nextStart = Math.round(rawStart / snap) * snap;
      let nextEnd = nextStart + duration;
      if (nextStart < state.openWindow) {
        nextStart = state.openWindow;
        nextEnd = nextStart + duration;
      }
      if (nextEnd > state.closeWindow) {
        nextEnd = state.closeWindow;
        nextStart = nextEnd - duration;
      }
      setCalendarEvents(prev =>
        prev.map(ev =>
          ev.id === state.event.id
            ? { ...ev, _dragStart: nextStart, _dragEnd: nextEnd }
            : ev
        )
      );
    } else if (state.mode === "resize") {
      const snapEnd = Math.round((state.openWindow + minutesFromTop) / snap) * snap;
      let nextEnd = Math.max(snapEnd, state.origStartMin + snap);
      if (nextEnd > state.closeWindow) nextEnd = state.closeWindow;
      setCalendarEvents(prev =>
        prev.map(ev =>
          ev.id === state.event.id
            ? { ...ev, _dragStart: state.origStartMin, _dragEnd: nextEnd }
            : ev
        )
      );
    }
  }

  function finalizeDrag() {
    const state = dragStateRef.current;
    if (!state.mode || !state.event) return;
    const current = calendarEventsRef.current.find(e => e.id === state.event.id);
    const startMin = current?._dragStart ?? state.origStartMin;
    const endMin = current?._dragEnd ?? state.origEndMin;
    dragStateRef.current = {
      mode: null,
      event: null,
      startY: 0,
      origStartMin: 0,
      origEndMin: 0,
      openWindow: state.openWindow,
      closeWindow: state.closeWindow,
      didMove: false
    };
    dragGuardRef.current.blockUntil = Date.now() + 400;
    updateCalendarEventTime(state.event, startMin, endMin);
  }

  useEffect(() => {
    function handleMove(e: MouseEvent) {
      applyDragAt(e.clientY);
    }
    function handleUp() {
      finalizeDrag();
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  async function submitBootstrap() {
    setAuthError(null);
    try {
      const resp = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: loginForm.email,
          password: loginForm.password,
          name: loginForm.name,
          role: "manager"
        })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to create user");
      setNeedsBootstrap(false);
      await submitLogin();
    } catch (err: any) {
      setAuthError(err?.message ?? "Failed to create user");
    }
  }


  if (authLoading) {
    return (
      <main className="lr-auth-shell">
        <div className="lr-auth-loading">Loading…</div>
      </main>
    );
  }

  if (needsBootstrap || !authUser) {
    return (
      <main className="lr-auth-shell">
        <div className="lr-auth-card w-full max-w-sm space-y-4">
          <div className="lr-auth-title text-lg font-semibold">
            {needsBootstrap ? "Create manager account" : "Sign in"}
          </div>
          {needsBootstrap ? (
            <input
              className="lr-auth-input w-full px-3 py-2 text-sm"
              placeholder="Name"
              value={loginForm.name}
              onChange={e => setLoginForm({ ...loginForm, name: e.target.value })}
            />
          ) : null}
          <input
            className="lr-auth-input w-full px-3 py-2 text-sm"
            placeholder="Email"
            value={loginForm.email}
            onChange={e => setLoginForm({ ...loginForm, email: e.target.value })}
          />
          <input
            className="lr-auth-input w-full px-3 py-2 text-sm"
            placeholder="Password"
            type="password"
            value={loginForm.password}
            onChange={e => setLoginForm({ ...loginForm, password: e.target.value })}
          />
          {!needsBootstrap ? (
            <button
              className="lr-auth-link text-xs underline"
              type="button"
              onClick={() => {
                const nextOpen = !forgotOpen;
                setForgotOpen(nextOpen);
                setForgotError(null);
                setForgotMessage(null);
                if (nextOpen && !forgotEmail && loginForm.email) setForgotEmail(loginForm.email);
              }}
            >
              Forgot password?
            </button>
          ) : null}
          {forgotOpen && !needsBootstrap ? (
            <div className="lr-auth-forgot-panel rounded p-3 space-y-2">
              <div className="text-xs font-medium lr-auth-forgot-title">Reset password by email</div>
              <input
                className="lr-auth-input w-full px-3 py-2 text-sm"
                placeholder="Email"
                value={forgotEmail}
                onChange={e => setForgotEmail(e.target.value)}
              />
              <button
                className="lr-auth-secondary-btn px-3 py-2 rounded text-sm"
                type="button"
                onClick={submitForgotPassword}
                disabled={forgotBusy}
              >
                {forgotBusy ? "Sending..." : "Send reset link"}
              </button>
              {forgotError ? <div className="text-xs lr-auth-error">{forgotError}</div> : null}
              {forgotMessage ? <div className="text-xs lr-auth-success">{forgotMessage}</div> : null}
            </div>
          ) : null}
          {authError ? <div className="text-xs lr-auth-error">{authError}</div> : null}
          <button
            className="lr-auth-primary-btn w-full px-3 py-2 rounded text-sm"
            onClick={needsBootstrap ? submitBootstrap : submitLogin}
          >
            {needsBootstrap ? "Create account" : "Sign in"}
          </button>
        </div>
      </main>
    );
  }

  const isCampaignSection = section === "campaigns";
  const rootThemeClass = isCampaignSection ? "lr-campaign-theme" : "lr-app-theme";

  return (
    <main
      className={`h-screen flex flex-col md:flex-row bg-[var(--background)] text-[var(--foreground)] ${rootThemeClass}`}
      data-campaign-theme={isCampaignSection ? "true" : "false"}
    >
      {saveToast ? (
        <div className="fixed top-4 right-4 z-[60] px-3 py-2 rounded border bg-white text-sm shadow">
          {saveToast}
        </div>
      ) : null}
      {mobileNavOpen ? (
        <div
          className="fixed inset-0 bg-black/40 z-40 md:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
      <div className="md:hidden w-full flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="w-[60px] shrink-0">
          <button
            className="px-2 py-1 border rounded text-sm"
            onClick={() => setMobileNavOpen(true)}
            title="Menu"
          >
            ☰
          </button>
        </div>
        <div className="min-w-0 flex-1 text-center text-sm font-semibold truncate">{getSectionTitle()}</div>
        <div className="w-[60px] shrink-0 flex justify-end">
          {isConversationSection && mobilePanel === "detail" ? (
            <button
              className="px-2 py-1 border rounded text-sm"
              onClick={() => setMobilePanel("list")}
            >
              Back
            </button>
          ) : null}
        </div>
      </div>
      <div className="flex-1 flex md:flex-row flex-col min-h-0">
      <aside className={`fixed inset-y-0 left-0 md:relative md:inset-auto z-50 w-16 md:h-screen border-r border-[var(--palette-graphite)] bg-[var(--palette-graphite)] text-white flex flex-col items-center py-3 cursor-pointer overflow-x-visible overflow-y-hidden transform transition-transform duration-200 ${mobileNavOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"} md:flex`}>
        <div className="text-lg font-semibold shrink-0">TI</div>
        <div className="mt-3 flex-1 min-h-0 w-full overflow-y-auto flex flex-col items-center gap-4 px-2 pb-3">
        <button
          className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "inbox" ? "bg-white/10" : "hover:bg-white/5"}`}
          title="Inbox"
          onClick={() => {
            goToSection("inbox");
            setEditingUserId(null);
            setShowNewUserForm(false);
            setSelectedContact(null);
          }}
        >
          📥
        </button>
        {(authUser?.role === "manager" || authUser?.role === "salesperson" || isDepartmentUser || authUser?.permissions?.canAccessTodos) ? (
          <button
            className={`relative w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "todos" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="To Dos"
            onClick={() => goToSection("todos")}
          >
            ✅
            {todos.length > 0 ? (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center border border-white">
                {todos.length > 99 ? "99+" : todos.length}
              </span>
            ) : null}
          </button>
        ) : null}
        {!isDepartmentUser ? (
          <button
            className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "contacts" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="Contacts"
            onClick={() => goToSection("contacts")}
          >
            👥
          </button>
        ) : null}
        {!isDepartmentUser && (authUser?.role === "manager" || authUser?.permissions?.canAccessSuppressions) ? (
          <button
            className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "suppressions" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="Suppressions"
            onClick={() => goToSection("suppressions")}
          >
            ⛔
          </button>
        ) : null}
        {!isDepartmentUser && (authUser?.role === "manager" || authUser?.permissions?.canEditAppointments) ? (
          <button
            className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "calendar" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="Calendar"
            onClick={() => goToSection("calendar")}
          >
            📅
          </button>
        ) : null}
        {!isDepartmentUser ? (
          <button
            className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "inventory" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="Inventory"
            onClick={() => goToSection("inventory")}
          >
            📦
          </button>
        ) : null}
        {!isDepartmentUser && (authUser?.role === "manager" || authUser?.role === "salesperson") ? (
        <button
          className={`relative w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "watches" ? "bg-white/10" : "hover:bg-white/5"}`}
          title="Watches"
          onClick={() => goToSection("watches")}
        >
          👀
          {watchCount > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center border border-white">
              {watchCount > 99 ? "99+" : watchCount}
            </span>
          ) : null}
        </button>
        ) : null}
        {!isDepartmentUser && authUser?.role === "manager" ? (
          <button
            className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "campaigns" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="Campaign Studio"
            onClick={() => goToSection("campaigns")}
          >
            📣
          </button>
        ) : null}
        {!isDepartmentUser && authUser?.role === "manager" ? (
          <button
            className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "kpi" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="KPI Overview"
            onClick={() => goToSection("kpi")}
          >
            📈
          </button>
        ) : null}
        {!isDepartmentUser ? (
          <button
            className={`relative w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "questions" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="Questions"
            onClick={() => goToSection("questions")}
          >
            🔔
            {questions.length > 0 ? (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center border border-white">
                {questions.length > 99 ? "99+" : questions.length}
              </span>
            ) : null}
          </button>
        ) : null}
        </div>
        <div className="shrink-0 sticky bottom-0 w-full flex flex-col items-center gap-2 pt-3 border-t border-white/10 bg-[var(--palette-graphite)] pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
          <div className="text-xs text-white/60">{loading ? "…" : ""}</div>
          <div className="relative">
            <button
              className="w-11 h-11 md:w-10 md:h-10 rounded flex items-center justify-center border border-white/20 hover:bg-white/5 relative"
              title="Settings"
              onClick={() => setSettingsOpen(v => !v)}
            >
              ⚙️
              {hasNotifications ? (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-600 border border-white" />
              ) : null}
            </button>
          </div>
        </div>
      </aside>

      {settingsOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[9999]"
              onClick={() => setSettingsOpen(false)}
            >
              <div
                className="absolute left-[4.5rem] bottom-4 w-56 bg-white border border-gray-200 rounded-lg shadow-lg p-2 text-gray-900"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-2 py-1">
                  <div className="text-xs font-semibold text-gray-600">Settings</div>
                  <button
                    className="text-xs px-1.5 py-0.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
                    onClick={() => setSettingsOpen(false)}
                    aria-label="Close settings menu"
                  >
                    X
                  </button>
                </div>
                {isManager ? (
                  <>
                    <button
                      className="w-full text-left px-2 py-2 rounded hover:bg-gray-50 text-sm"
                      onClick={() => {
                        setSettingsTab("dealer");
                        goToSection("settings");
                        setSettingsOpen(false);
                      }}
                    >
                      Dealer Profile
                    </button>
                    <button
                      className="w-full text-left px-2 py-2 rounded hover:bg-gray-50 text-sm"
                      onClick={() => {
                        setSettingsTab("users");
                        goToSection("settings");
                        setSettingsOpen(false);
                      }}
                    >
                      Users
                    </button>
                    <button
                      className="w-full text-left px-2 py-2 rounded hover:bg-gray-50 text-sm"
                      onClick={() => {
                        setSettingsTab("scheduler");
                        goToSection("settings");
                        setSettingsOpen(false);
                      }}
                    >
                      Scheduling
                    </button>
                    <button
                      className="w-full text-left px-2 py-2 rounded hover:bg-gray-50 text-sm"
                      onClick={() => {
                        setSettingsTab("notifications");
                        goToSection("settings");
                        setSettingsOpen(false);
                      }}
                    >
                      Notifications
                    </button>
                  </>
                ) : (
                  <div className="px-2 py-2 text-xs text-gray-500 border-t border-gray-100 mt-1">
                    Dealer Profile and policy toggles are available to manager users.
                  </div>
                )}
                <button
                  className="w-full text-left px-2 py-2 rounded hover:bg-gray-50 text-sm text-red-600"
                  onClick={async () => {
                    await fetch("/api/auth/logout", { method: "POST" });
                    setSettingsOpen(false);
                    setAuthUser(null);
                  }}
                >
                  Sign out
                </button>
              </div>
            </div>,
            document.body
          )
        : null}

      <section
        className={`w-full ${
          section === "contacts" ? "md:w-[620px]" : "md:w-96"
        } border-r border-[var(--border)] bg-[var(--surface)] p-4 overflow-y-auto shadow-[0_10px_30px_rgba(0,0,0,0.08)] lr-app-sidebar-panel ${
          isCampaignSection ? "lr-campaign-sidebar" : ""
        } ${section === "calendar" ? "hidden" : ""} ${isConversationSection && mobilePanel === "detail" ? "hidden md:block" : ""}`}
        data-campaign-sidebar={isCampaignSection ? "true" : "false"}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{getSectionTitle()}</h1>
            <p className="text-xs text-gray-600 mt-1">
              {getSectionSubTitle()}
            </p>
          </div>
          {section !== "contacts" ? (
            <div className="border border-[var(--border)] rounded-lg p-2 bg-[var(--surface-2)]">
              <div className="text-[10px] text-[var(--palette-graphite)]">System Mode</div>
              <div className="mt-1 flex gap-1">
                  <button
                    className={`px-2 py-1 border border-[var(--border)] rounded text-xs cursor-pointer ${mode === "suggest" ? "font-semibold bg-[var(--accent)] text-white border-[var(--accent)]" : "hover:bg-white"}`}
                  onClick={() => updateMode("suggest")}
                >
                  Suggest
                </button>
                  <button
                    className={`px-2 py-1 border border-[var(--border)] rounded text-xs cursor-pointer ${mode === "autopilot" ? "font-semibold bg-[var(--accent)] text-white border-[var(--accent)]" : "hover:bg-white"}`}
                  onClick={() => updateMode("autopilot")}
                  title="Autopilot will auto-reply on inbound SMS"
                >
                  AI
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {section === "inventory" ? (
          <div className="mt-4 space-y-3">
            <input
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Search inventory..."
              value={inventoryQuery}
              onChange={e => setInventoryQuery(e.target.value)}
            />
            {inventoryLoading ? (
              <div className="text-sm text-gray-500">Loading inventory...</div>
            ) : inventoryItems.length === 0 ? (
              <div className="text-sm text-gray-500">No inventory loaded.</div>
            ) : (
              <div className="text-xs text-gray-500">
                Showing {inventoryItems.length} bikes
              </div>
            )}
          </div>
        ) : section === "watches" ? (
          <div className="mt-4 space-y-3">
            <input
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Search watches..."
              value={watchQuery}
              onChange={e => setWatchQuery(e.target.value)}
            />
            {isManager ? (
              <select
                className="w-full border rounded px-3 py-2 text-sm"
                value={watchSalespersonFilter}
                onChange={e => setWatchSalespersonFilter(e.target.value)}
              >
                <option value="all">All salespeople</option>
                {watchSalespeople.map(sp => (
                  <option key={sp.id} value={sp.id}>
                    {sp.name}
                  </option>
                ))}
              </select>
            ) : null}
            {visibleWatchItems.length === 0 ? (
              <div className="text-sm text-gray-500">No active watches.</div>
            ) : (
              <div className="border border-[var(--border)] rounded-lg divide-y bg-[var(--surface)]">
                {visibleWatchItems.map(item => {
                  const labels = (item.watches ?? []).map(w => formatWatchLabel(w));
                  const createdAt = formatWatchDate(
                    (item.watches ?? [])
                      .map(w => w?.createdAt)
                      .filter(Boolean)
                      .sort()[0]
                  );
                  const lastNotified = formatWatchDate(
                    (item.watches ?? [])
                      .map(w => w?.lastNotifiedAt)
                      .filter(Boolean)
                      .sort()
                      .slice(-1)[0]
                  );
                  const note = (item.watches ?? [])
                    .map(w => String(w?.note ?? "").trim())
                    .find(n => n);
                  const ownerName = item.ownerId
                    ? watchSalespeople.find(sp => sp.id === item.ownerId)?.name ||
                      item.ownerName ||
                      "Unassigned"
                    : "Unassigned";
                  return (
                    <div
                      key={item.key}
                      className={`flex items-stretch ${
                        selectedId === item.convId ? "bg-[var(--surface-2)]" : ""
                      }`}
                    >
                      <button
                        onClick={() => openConversation(item.convId)}
                        className="flex-1 text-left p-4 hover:bg-[var(--surface-2)]"
                      >
                        <div className="font-medium truncate">
                          {item.leadName && item.leadName.length > 0 ? item.leadName : item.leadKey}
                        </div>
                        <div className="text-xs text-gray-600 mt-1">
                          {labels.join(" • ")}
                        </div>
                        {note ? (
                          <div className="text-xs text-gray-500 mt-1">Note: {note}</div>
                        ) : null}
                        {createdAt ? (
                          <div className="text-[11px] text-gray-500 mt-1">
                            Created: {createdAt}
                          </div>
                        ) : null}
                        {lastNotified ? (
                          <div className="text-[11px] text-gray-500">
                            Last notified: {lastNotified}
                          </div>
                        ) : null}
                        {isManager ? (
                          <div className="text-[11px] text-gray-500 mt-1">
                            Salesperson: {ownerName}
                          </div>
                        ) : null}
                      </button>
                      <div className="flex flex-col border-l">
                        <button
                          className="w-10 h-10 text-xs text-gray-600 hover:text-gray-900 hover:bg-[var(--surface-2)]"
                          title="Edit watch"
                          onClick={e => {
                            e.stopPropagation();
                            openWatchEdit(item.convId);
                          }}
                        >
                          ✏️
                        </button>
                        <button
                          className="w-10 h-10 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                          title="Delete watch"
                          onClick={e => {
                            e.stopPropagation();
                            void deleteWatchForConv(item.convId);
                          }}
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : section === "campaigns" ? (
          <div className="mt-4 space-y-3 lr-campaign-list">
            <div className="flex gap-2">
              <button
                className="flex-1 px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)]"
                onClick={() => resetCampaignDraft()}
                disabled={campaignSaving || campaignGenerating}
              >
                New campaign
              </button>
              <button
                className="px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)]"
                onClick={() => {
                  void loadCampaigns();
                }}
                disabled={campaignLoading}
              >
                Refresh
              </button>
            </div>
            {campaignError ? <div className="text-xs text-red-600">{campaignError}</div> : null}
            <div className="grid grid-cols-2 gap-2">
              <button
                className={`border rounded p-2 text-left hover:bg-[var(--surface)] lr-campaign-filter-card ${
                  campaignListFilter === "all" ? "bg-[var(--surface)] ring-1 ring-[var(--accent)]" : "bg-[var(--surface-2)]"
                }`}
                onClick={() => setCampaignListFilter("all")}
                title="Show all campaigns"
              >
                <div className="text-[11px] text-gray-500">All</div>
                <div className="text-sm font-semibold">{campaigns.length}</div>
              </button>
              <button
                className={`border rounded p-2 text-left hover:bg-[var(--surface)] lr-campaign-filter-card ${
                  campaignListFilter === "send" ? "bg-[var(--surface)] ring-1 ring-[var(--accent)]" : "bg-[var(--surface-2)]"
                }`}
                onClick={() => openQueuedCampaign("send")}
                title={campaignSendQueue.length ? "Open newest Send Queue campaign" : "Send Queue is empty"}
              >
                <div className="text-[11px] text-gray-500">Send Queue</div>
                <div className="text-sm font-semibold">{campaignSendQueue.length}</div>
              </button>
            </div>
            {campaignSendQueue.length ? (
              <div className="border rounded-lg bg-[var(--surface)]">
                <div className="px-3 py-2 text-xs font-semibold border-b">Send Queue</div>
                <div className="divide-y max-h-32 overflow-y-auto">
                  {campaignSendQueue.map(item => {
                    const actionBusy = campaignQueueActionBusyKey.startsWith(`send:${item.id}:`);
                    return (
                      <div key={`send-queue-${item.id}`} className="flex items-stretch">
                        <button
                          className={`flex-1 text-left px-3 py-2 text-xs hover:bg-[var(--surface-2)] ${
                            campaignSelectedId === item.id ? "bg-[var(--surface-2)]" : ""
                          }`}
                          onClick={() => openCampaignFromQueue(item, "send", { toast: false })}
                        >
                          <div className="font-medium truncate">{item.name || "Untitled campaign"}</div>
                          <div className="text-[11px] text-gray-500">
                            Queued{" "}
                            {campaignQueueEntry(item, "send")?.queuedAt
                              ? new Date(String(campaignQueueEntry(item, "send")?.queuedAt)).toLocaleString()
                              : "recently"}
                          </div>
                        </button>
                        <button
                          className="px-2 text-[10px] border-l text-[var(--accent)] hover:bg-[var(--surface-2)] disabled:opacity-60"
                          disabled={Boolean(campaignQueueActionBusyKey) || actionBusy || campaignGenerating || campaignSaving}
                          onClick={() => {
                            openSendQueueSendDialog(item);
                          }}
                          title="Open queued send window"
                        >
                          {actionBusy ? "Sending..." : "Send…"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {campaignLoading ? (
              <div className="text-sm text-gray-500">Loading campaigns...</div>
            ) : campaignVisibleList.length === 0 ? (
              <div className="text-sm text-gray-500 border rounded p-3 bg-[var(--surface-2)]">
                {campaignListFilter === "all"
                  ? "No campaigns yet. Create a draft to get started."
                  : "No campaigns in Send Queue."}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <div className="text-[11px] text-gray-600">
                    Showing: <span className="font-semibold text-gray-800">{campaignListFilterLabel}</span>
                  </div>
                  {campaignListFilter !== "all" ? (
                    <button
                      className="text-[11px] text-[var(--accent)] hover:underline"
                      onClick={() => setCampaignListFilter("all")}
                    >
                      Show all
                    </button>
                  ) : null}
                </div>
                <div className="border rounded-lg divide-y bg-[var(--surface)] max-h-[55vh] overflow-y-auto">
                {campaignVisibleList.map(item => {
                  const selected = campaignSelectedId === item.id;
                  const status = String(item.status ?? "draft").toLowerCase() === "generated" ? "Generated" : "Draft";
                  const updated = item.updatedAt || item.createdAt;
                  const tags = Array.isArray(item.tags) ? item.tags : [];
                  const inSendQueue = campaignIsQueued(item, "send");
                  return (
                    <div
                      key={item.id}
                      className={`flex items-stretch ${selected ? "bg-[var(--surface-2)] lr-campaign-list-row-selected" : "lr-campaign-list-row"}`}
                    >
                      <button
                        className="flex-1 w-full text-left p-3 hover:bg-[var(--surface-2)] lr-campaign-list-row-btn"
                        onClick={() => {
                          setCampaignSelectedId(item.id);
                          applyCampaignToForm(item);
                        }}
                      >
                        <div className="text-sm font-medium truncate lr-campaign-list-row-title">{item.name || "Untitled campaign"}</div>
                        <div className="text-[11px] text-gray-500 mt-1 lr-campaign-list-row-meta">
                          {status}
                          {updated ? ` • ${new Date(updated).toLocaleString()}` : ""}
                        </div>
                        {tags.length ? (
                          <div className="text-[11px] text-gray-600 mt-1 truncate lr-campaign-list-row-meta">
                            {tags.join(" • ")}
                          </div>
                        ) : null}
                        {inSendQueue ? (
                          <div className="text-[11px] text-gray-600 mt-1 truncate lr-campaign-list-row-meta">
                            In Send Queue
                          </div>
                        ) : null}
                      </button>
                      <button
                        className="w-10 h-10 text-xs border-l text-red-600 hover:text-red-700 hover:bg-red-50 disabled:opacity-60"
                        title="Delete campaign"
                        disabled={
                          campaignDeletingId === item.id ||
                          campaignSaving ||
                          campaignGenerating
                        }
                        onClick={e => {
                          e.stopPropagation();
                          void deleteCampaignById(item.id);
                        }}
                      >
                        {campaignDeletingId === item.id ? "…" : "🗑️"}
                      </button>
                    </div>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        ) : section === "kpi" ? (
          <div className="mt-4 space-y-3">
            <div className="text-xs text-gray-600">Date range</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                className="w-full border rounded px-2 py-2 text-sm"
                value={kpiFrom}
                onChange={e => setKpiFrom(e.target.value)}
              />
              <input
                type="date"
                className="w-full border rounded px-2 py-2 text-sm"
                value={kpiTo}
                onChange={e => setKpiTo(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                className="px-2 py-1.5 border rounded text-xs hover:bg-[var(--surface-2)]"
                onClick={() => {
                  setKpiFrom(dateInputOffset(30));
                  setKpiTo(dateInputOffset(0));
                }}
              >
                30d
              </button>
              <button
                className="px-2 py-1.5 border rounded text-xs hover:bg-[var(--surface-2)]"
                onClick={() => {
                  setKpiFrom(dateInputOffset(60));
                  setKpiTo(dateInputOffset(0));
                }}
              >
                60d
              </button>
              <button
                className="px-2 py-1.5 border rounded text-xs hover:bg-[var(--surface-2)]"
                onClick={() => {
                  setKpiFrom(dateInputOffset(90));
                  setKpiTo(dateInputOffset(0));
                }}
              >
                90d
              </button>
            </div>
            <select
              className="w-full border rounded px-3 py-2 text-sm"
              value={kpiLeadScopeFilter}
              onChange={e =>
                setKpiLeadScopeFilter((e.target.value as KpiLeadScope) || "online_only")
              }
            >
              <option value="online_only">Online</option>
              <option value="walkin_only">Walk-in</option>
              <option value="include_walkins">All</option>
            </select>
            <select
              className="w-full border rounded px-3 py-2 text-sm"
              value={kpiSourceFilter}
              onChange={e => setKpiSourceFilter(e.target.value)}
            >
              <option value="all">All sources</option>
              {kpiOverview?.bySource?.map(row => (
                <option key={`kpi-source-${row.source}`} value={row.source}>
                  {row.source}
                </option>
              ))}
            </select>
            <select
              className="w-full border rounded px-3 py-2 text-sm"
              value={kpiOwnerFilter}
              onChange={e => setKpiOwnerFilter(e.target.value)}
            >
              <option value="all">All salespeople</option>
              {kpiOwnerOptions.map(owner => (
                <option key={`kpi-owner-${owner.id}`} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
            <button
              className="w-full px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)]"
              onClick={() => {
                void loadKpiOverview();
              }}
            >
              Refresh KPI
            </button>
            <div className="border rounded p-2 bg-[var(--surface-2)]">
              <div className="text-xs text-gray-600 mb-1">Call details filter</div>
              <select
                className="w-full border rounded px-2 py-2 text-sm"
                value={kpiCallOwnerFilter}
                onChange={e => setKpiCallOwnerFilter(e.target.value)}
              >
                <option value="all">All salespeople</option>
                {kpiCallOwnerOptions.map(owner => (
                  <option key={`kpi-call-owner-${owner.id}`} value={owner.id}>
                    {owner.name}
                  </option>
                ))}
              </select>
            </div>
            {kpiError ? <div className="text-xs text-red-600">{kpiError}</div> : null}
          </div>
        ) : section === "inbox" ? (
          <InboxSection
            view={view}
            setView={setView}
            filteredConversations={filteredConversations}
            openCompose={openCompose}
            inboxQuery={inboxQuery}
            setInboxQuery={setInboxQuery}
            isManager={isManager}
            inboxOwnerFilter={inboxOwnerFilter}
            setInboxOwnerFilter={setInboxOwnerFilter}
            managerLeadOwnerOptions={managerLeadOwnerOptions}
            inboxDealCounts={inboxDealCounts}
            inboxDealFilter={inboxDealFilter}
            setInboxDealFilter={setInboxDealFilter}
            getInboxDealFilterButtonClass={getInboxDealFilterButtonClass}
            groupedConversations={groupedConversations}
            campaignInboxExpanded={campaignInboxExpanded}
            setCampaignInboxExpanded={setCampaignInboxExpanded}
            selectedId={selectedId}
            openConversation={openConversation}
            getDealTemperature={getDealTemperature}
            renderDealTemperatureIcon={renderDealTemperatureIcon}
            setHumanModeForId={setHumanModeForId}
            listActionsOpenId={listActionsOpenId}
            setListActionsOpenId={setListActionsOpenId}
            todoInlineOpenId={todoInlineOpenId}
            setTodoInlineOpenId={setTodoInlineOpenId}
            todoInlineTarget={todoInlineTarget}
            setTodoInlineTarget={setTodoInlineTarget}
            reassignSalesOwnerOptions={reassignSalesOwnerOptions}
            todoInlineText={todoInlineText}
            setTodoInlineText={setTodoInlineText}
            submitTodoInline={submitTodoInline}
            reminderInlineOpenId={reminderInlineOpenId}
            setReminderInlineOpenId={setReminderInlineOpenId}
            reminderInlineTarget={reminderInlineTarget}
            setReminderInlineTarget={setReminderInlineTarget}
            reminderInlineText={reminderInlineText}
            setReminderInlineText={setReminderInlineText}
            reminderInlineDueAt={reminderInlineDueAt}
            setReminderInlineDueAt={setReminderInlineDueAt}
            reminderInlineLeadMinutes={reminderInlineLeadMinutes}
            setReminderInlineLeadMinutes={setReminderInlineLeadMinutes}
            reminderInlineSaving={reminderInlineSaving}
            submitReminderInline={submitReminderInline}
            contactInlineOpenId={contactInlineOpenId}
            setContactInlineOpenId={setContactInlineOpenId}
            findLinkedContactForConversation={findLinkedContactForConversation}
            contactInlineForm={contactInlineForm}
            setContactInlineForm={setContactInlineForm}
            contactInlineSaving={contactInlineSaving}
            submitInlineContact={submitInlineContact}
            reassignInlineOpenId={reassignInlineOpenId}
            setReassignInlineOpenId={setReassignInlineOpenId}
            reassignInlineTarget={reassignInlineTarget}
            setReassignInlineTarget={setReassignInlineTarget}
            reassignInlineSummary={reassignInlineSummary}
            setReassignInlineSummary={setReassignInlineSummary}
            reassignInlineSaving={reassignInlineSaving}
            reassignLeadInline={reassignLeadInline}
            openInlineContactFromConversation={openInlineContactFromConversation}
            openReassignLeadInline={openReassignLeadInline}
            authUser={authUser}
            deleteConvFromList={deleteConvFromList}
            inboxTodoOwnerByConv={inboxTodoOwnerByConv}
            renderBookingLinkLine={renderBookingLinkLine}
            loading={loading}
          />
        ) : null}

        {section === "todos" &&
        (authUser?.role === "manager" || authUser?.role === "salesperson" || isDepartmentUser || authUser?.permissions?.canAccessTodos) ? (
          <TaskInboxSection
            todoQuery={todoQuery}
            setTodoQuery={setTodoQuery}
            isManager={isManager}
            todoLeadOwnerFilter={todoLeadOwnerFilter}
            setTodoLeadOwnerFilter={setTodoLeadOwnerFilter}
            managerLeadOwnerOptions={managerLeadOwnerOptions}
            todoTaskTypeFilter={todoTaskTypeFilter}
            setTodoTaskTypeFilter={setTodoTaskTypeFilter}
            todoSectionDefs={todoSectionDefs}
            groupedTodos={groupedTodos}
            getTodoSectionTheme={getTodoSectionTheme}
            conversationsById={conversationsById}
            todoInboxSection={todoInboxSection}
            todoActionLabel={todoActionLabel}
            todoRequestedCallTimeLabel={todoRequestedCallTimeLabel}
            todoAppointmentTimeLabel={todoAppointmentTimeLabel}
            formatAppointmentOutcomeDisplay={formatAppointmentOutcomeDisplay}
            reassignInlineOpenId={reassignInlineOpenId}
            reassignInlineTarget={reassignInlineTarget}
            setReassignInlineTarget={setReassignInlineTarget}
            reassignSalesOwnerOptions={reassignSalesOwnerOptions}
            reassignInlineSummary={reassignInlineSummary}
            setReassignInlineSummary={setReassignInlineSummary}
            setReassignInlineOpenId={setReassignInlineOpenId}
            reassignInlineSaving={reassignInlineSaving}
            reassignLeadInline={reassignLeadInline}
            openConversation={openConversation}
            authUser={authUser}
            openReassignLeadInline={openReassignLeadInline}
            openCallFromTodo={openCallFromTodo}
            setAppointmentCloseTarget={setAppointmentCloseTarget}
            setAppointmentClosePrimaryOutcome={setAppointmentClosePrimaryOutcome}
            setAppointmentCloseSecondaryOutcome={setAppointmentCloseSecondaryOutcome}
            setAppointmentCloseNote={setAppointmentCloseNote}
            setAppointmentCloseOpen={setAppointmentCloseOpen}
            markTodoDone={markTodoDone}
            renderDealTemperatureIcon={renderDealTemperatureIcon}
            getDealTemperature={getDealTemperature}
            loading={loading}
            filteredTodos={filteredTodos}
          />
        ) : null}

        {section === "questions" ? (
          <div className="mt-3 border rounded-lg divide-y">
            {cadenceAlerts.length ? (
              <>
                {cadenceAlerts.map(alert => (
                  <div key={`cadence-${alert.convId}`} className="p-4 flex items-start justify-between gap-4 bg-amber-50">
                    <div>
                      <div className="text-sm font-medium">
                        {alert.leadName ? `${alert.leadName}` : alert.leadKey}
                      </div>
                      {alert.leadName ? (
                        <div className="text-xs text-gray-600 mt-1">{alert.leadKey}</div>
                      ) : null}
                      <div className="text-xs text-amber-800 mt-2">
                        Follow-up message scheduled for {formatCadenceDate(alert.sendAt.toISOString())}.
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <button
                        className="px-3 py-2 border rounded text-sm bg-white"
                        onClick={() => openCadenceResolve(alert.convId, "alert")}
                      >
                        Resolve
                      </button>
                      <button
                        className="px-3 py-2 border rounded text-sm"
                        onClick={() => {
                          openConversation(alert.convId);
                        }}
                      >
                        Open conversation
                      </button>
                    </div>
                  </div>
                ))}
              </>
            ) : null}
            {questions.map(q => (
              <div key={q.id} className="p-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">{q.leadKey}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {new Date(q.createdAt).toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-700 mt-2 line-clamp-3">{q.text}</div>
                  {q.type === "attendance" || q.type === "cadence_checkin" ? (
                    <div className="mt-3 grid grid-cols-1 gap-2">
                      <label className="text-xs text-gray-600">
                        Outcome
                        <select
                          className="mt-1 w-full border rounded px-2 py-1 text-sm"
                          value={questionOutcomeById[q.id] ?? q.outcome ?? ""}
                          onChange={e =>
                            setQuestionOutcomeById(prev => ({ ...prev, [q.id]: e.target.value }))
                          }
                        >
                          <option value="">Select outcome…</option>
                          <option value="sold">Sold</option>
                          <option value="hold">On hold</option>
                          <option value="undecided">Undecided</option>
                          <option value="no_show">No show</option>
                        </select>
                      </label>
                      <label className="text-xs text-gray-600">
                        Follow-up Action
                        <select
                          className="mt-1 w-full border rounded px-2 py-1 text-sm"
                          value={questionFollowUpById[q.id] ?? q.followUpAction ?? ""}
                          onChange={e =>
                            setQuestionFollowUpById(prev => ({ ...prev, [q.id]: e.target.value }))
                          }
                        >
                          <option value="">Auto (based on outcome)</option>
                          <option value="resume">Resume cadence</option>
                          <option value="pause_24h">Pause 24h</option>
                          <option value="pause_72h">Pause 72h</option>
                          <option value="pause_indef">Pause indefinitely</option>
                          <option value="archive">Archive</option>
                          <option value="none">No change</option>
                        </select>
                      </label>
                    </div>
                  ) : null}
                  <button
                    className="text-xs text-blue-600 mt-2 inline-block"
                    onClick={() => {
                      openConversation(q.convId);
                    }}
                  >
                    Open conversation
                  </button>
                </div>
                {(() => {
                  const isCrmFailure = /tlp log failed/i.test(q.text ?? "");
                  if (isCrmFailure) {
                    return (
                      <div className="flex flex-col gap-2">
                        <button
                          className="px-3 py-2 border rounded text-sm"
                          onClick={() => retryCrmLog(q)}
                        >
                          Try again
                        </button>
                        <button
                          className="px-3 py-2 border rounded text-sm"
                          onClick={() => markQuestionDone(q)}
                        >
                          Update manually
                        </button>
                      </div>
                    );
                  }
                  return (
                    <button className="px-3 py-2 border rounded text-sm" onClick={() => markQuestionDone(q)}>
                      Done
                    </button>
                  );
                })()}
              </div>
            ))}
            {!loading && questions.length === 0 && cadenceAlerts.length === 0 ? (
              <div className="p-4 text-sm text-gray-600">No open questions.</div>
            ) : null}
          </div>
        ) : null}

        {section === "contacts" ? (
          <div className="mt-4 border rounded-lg overflow-hidden bg-white grid grid-cols-[230px_minmax(0,1fr)] min-h-[620px]">
            <div className="border-r p-3 flex flex-col">
              <div className="text-sm font-semibold text-gray-700">Groups</div>
              <div className="mt-2 space-y-1 flex-1 overflow-y-auto pr-1">
                <button
                  className={`w-full text-left px-3 py-2 rounded text-sm border ${
                    selectedContactListId === "all"
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white hover:bg-gray-50 border-gray-200"
                  }`}
                  onClick={() => setSelectedContactListId("all")}
                >
                  All Contacts
                </button>
                {contactLists.map(list => (
                  <button
                    key={list.id}
                    className={`w-full text-left px-3 py-2 rounded text-sm border ${
                      selectedContactListId === list.id
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white hover:bg-gray-50 border-gray-200"
                    }`}
                    onClick={() => setSelectedContactListId(list.id)}
                  >
                    <div className="truncate">{list.name}</div>
                  </button>
                ))}
              </div>
              <div className="border-t pt-3 mt-3 space-y-2">
                <input
                  className="w-full border rounded px-2 py-1.5 text-sm"
                  placeholder="New group name"
                  value={newContactListName}
                  onChange={e => setNewContactListName(e.target.value)}
                />
                <button className="w-full border rounded px-2 py-1.5 text-sm" onClick={createContactGroup}>
                  + New Group
                </button>
              </div>
            </div>

            <div className="flex flex-col">
              <div className="p-3 border-b bg-gray-50">
                <input
                  className="w-full border rounded px-3 py-2 text-sm"
                  placeholder="Search all contacts"
                  value={contactQuery}
                  onChange={e => setContactQuery(e.target.value)}
                />
              </div>
              <div className="flex-1 overflow-y-auto divide-y">
                {filteredContacts.map(c => (
                  <button
                    key={c.id}
                    className={`w-full text-left px-4 py-3 hover:bg-blue-50 ${
                      selectedContact?.id === c.id ? "bg-blue-100" : ""
                    }`}
                    onClick={() => setSelectedContact(c)}
                  >
                    <div className="text-sm font-medium">
                      {c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || c.email || "Unknown"}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {c.phone || c.email || "No phone/email"}
                    </div>
                    <div className="text-xs text-gray-500 mt-1 truncate">
                      {[c.year, c.make, c.model ?? c.vehicle, c.trim].filter(Boolean).join(" ")}
                    </div>
                  </button>
                ))}
                {!loading && filteredContacts.length === 0 ? (
                  <div className="p-4 text-sm text-gray-600">No contacts in this group.</div>
                ) : null}
              </div>
              <div className="p-3 border-t bg-gray-50">
                {!newContactOpen ? (
                  <button
                    className="w-full border rounded px-3 py-2 text-sm"
                    onClick={() => setNewContactOpen(true)}
                  >
                    + New Contact
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        className="border rounded px-2 py-1.5 text-xs"
                        placeholder="First name"
                        value={newContactForm.firstName}
                        onChange={e => setNewContactForm(prev => ({ ...prev, firstName: e.target.value }))}
                      />
                      <input
                        className="border rounded px-2 py-1.5 text-xs"
                        placeholder="Last name"
                        value={newContactForm.lastName}
                        onChange={e => setNewContactForm(prev => ({ ...prev, lastName: e.target.value }))}
                      />
                      <input
                        className="border rounded px-2 py-1.5 text-xs"
                        placeholder="Phone"
                        value={newContactForm.phone}
                        onChange={e => setNewContactForm(prev => ({ ...prev, phone: e.target.value }))}
                      />
                      <input
                        className="border rounded px-2 py-1.5 text-xs"
                        placeholder="Email"
                        value={newContactForm.email}
                        onChange={e => setNewContactForm(prev => ({ ...prev, email: e.target.value }))}
                      />
                    </div>
                    <div className="flex gap-2">
                      <button className="flex-1 border rounded px-2 py-1.5 text-xs" onClick={createNewContact}>
                        Save Contact
                      </button>
                      <button
                        className="flex-1 border rounded px-2 py-1.5 text-xs"
                        onClick={() => setNewContactOpen(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {appointmentCloseOpen && appointmentCloseTarget ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-4">
              <div className="text-sm font-medium">Close Appointment Task</div>
              <div className="text-xs text-gray-500 mt-1">
                No appointment outcome is saved yet. Add the outcome now before closing.
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2">
                <label className="text-xs text-gray-600">
                  Attendance
                  <select
                    className="mt-1 w-full border rounded px-3 py-2 text-sm"
                    value={appointmentClosePrimaryOutcome}
                    onChange={e => {
                      const nextPrimary = (e.target.value as "showed" | "did_not_show" | "cancelled") || "showed";
                      setAppointmentClosePrimaryOutcome(nextPrimary);
                      const options = APPOINTMENT_SECONDARY_OPTIONS_BY_PRIMARY[nextPrimary] ?? [];
                      const hasCurrent = options.some(opt => opt.value === appointmentCloseSecondaryOutcome);
                      if (!hasCurrent) setAppointmentCloseSecondaryOutcome(options[0]?.value ?? "needs_follow_up");
                    }}
                  >
                    <option value="showed">Showed</option>
                    <option value="did_not_show">Did not show</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
                <label className="text-xs text-gray-600">
                  Disposition
                  <select
                    className="mt-1 w-full border rounded px-3 py-2 text-sm"
                    value={appointmentCloseSecondaryOutcome}
                    onChange={e => setAppointmentCloseSecondaryOutcome(e.target.value)}
                  >
                    {(APPOINTMENT_SECONDARY_OPTIONS_BY_PRIMARY[appointmentClosePrimaryOutcome] ?? []).map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-gray-600">
                  Note (optional)
                  <textarea
                    className="mt-1 w-full border rounded px-3 py-2 text-sm min-h-[72px]"
                    value={appointmentCloseNote}
                    onChange={e => setAppointmentCloseNote(e.target.value)}
                    placeholder="Add any context from the visit."
                  />
                </label>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  className="px-3 py-2 border rounded text-sm"
                  disabled={appointmentCloseSaving}
                  onClick={() => {
                    setAppointmentCloseOpen(false);
                    setAppointmentCloseTarget(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm bg-gray-900 text-white"
                  disabled={appointmentCloseSaving}
                  onClick={async () => {
                    if (!appointmentCloseTarget) return;
                    setAppointmentCloseSaving(true);
                    try {
                      await markTodoDone(
                        appointmentCloseTarget,
                        "dismiss",
                        undefined,
                        appointmentCloseNote,
                        appointmentClosePrimaryOutcome,
                        appointmentCloseSecondaryOutcome
                      );
                      setAppointmentCloseOpen(false);
                      setAppointmentCloseTarget(null);
                    } finally {
                      setAppointmentCloseSaving(false);
                    }
                  }}
                >
                  {appointmentCloseSaving ? "Saving..." : "Save & Close"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {todoResolveOpen && todoResolveTarget ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-4">
              <div className="text-sm font-medium">Resolve To Do</div>
              <div className="text-xs text-gray-500 mt-1">
                Choose what should happen to follow-ups for this conversation.
              </div>
              <div className="mt-3">
                <select
                  className="w-full border rounded px-3 py-2 text-sm"
                  value={todoResolution}
                  onChange={e => setTodoResolution(e.target.value)}
                >
                  <option value="resume">Resume follow-ups now</option>
                  <option value="pause_7">Pause for 7 days</option>
                  <option value="pause_30">Pause for 30 days</option>
                  <option value="pause_indef">Pause indefinitely</option>
                  <option value="appointment_set">Appointment set manually</option>
                  <option value="archive">Archive conversation</option>
                </select>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  className="px-3 py-2 border rounded text-sm"
                  onClick={() => {
                    setTodoResolveOpen(false);
                    setTodoResolveTarget(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm"
                  onClick={async () => {
                    if (!todoResolveTarget) return;
                    await markTodoDone(todoResolveTarget, todoResolution);
                    setTodoResolveOpen(false);
                    setTodoResolveTarget(null);
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {section === "settings" && authUser?.role === "manager" ? (
          <div className="mt-3 border rounded-lg divide-y">
            <div className="px-4 py-3 flex items-center justify-between bg-gray-50">
              <div className="text-sm font-semibold text-gray-700">Settings</div>
              <button
                className="px-2 py-1 border rounded text-xs text-gray-700 hover:bg-white"
                onClick={() => goToSection("inbox")}
                aria-label="Close settings"
              >
                X
              </button>
            </div>
            <button
              className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${
                settingsTab === "dealer" ? "bg-gray-50 font-medium" : ""
              }`}
              onClick={() => setSettingsTab("dealer")}
            >
              Dealer Profile
            </button>
            <button
              className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${
                settingsTab === "users" ? "bg-gray-50 font-medium" : ""
              }`}
              onClick={() => setSettingsTab("users")}
            >
              Users
            </button>
            <button
              className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${
                settingsTab === "scheduler" ? "bg-gray-50 font-medium" : ""
              }`}
              onClick={() => setSettingsTab("scheduler")}
            >
              Scheduling
            </button>
            <button
              className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${
                settingsTab === "notifications" ? "bg-gray-50 font-medium" : ""
              }`}
              onClick={() => setSettingsTab("notifications")}
            >
              Notifications
            </button>
          </div>
        ) : null}

        {section === "calendar" ? (
          <div className="mt-3 border rounded-lg p-4 text-sm text-gray-600">
            View and filter schedules in the main panel.
          </div>
        ) : null}

        {section === "suppressions" && (authUser?.role === "manager" || authUser?.permissions?.canAccessSuppressions) ? (
          <>
            <div className="mt-3 flex gap-2">
              <input
                className="flex-1 border rounded px-3 py-2 text-sm"
                placeholder="Add phone (+15551234567)"
                value={newSuppression}
                onChange={e => setNewSuppression(e.target.value)}
              />
              <button className="px-3 py-2 border rounded text-sm" onClick={addSuppression}>
                Add
              </button>
            </div>
            <div className="mt-3 border rounded-lg divide-y">
              {suppressions.map(s => (
                <div key={s.phone} className="p-4 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">{s.phone}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {new Date(s.addedAt).toLocaleString()}
                      {s.reason ? ` • ${s.reason}` : ""}
                    </div>
                  </div>
                  <button className="px-3 py-2 border rounded text-sm" onClick={() => removeSuppression(s.phone)}>
                    Remove
                  </button>
                </div>
              ))}
              {!loading && suppressions.length === 0 && (
                <div className="p-4 text-sm text-gray-600">No suppressed numbers.</div>
              )}
            </div>
          </>
        ) : null}
      </section>

      <section
        className={`flex-1 ${
          isCampaignSection
            ? "bg-[#090d14] shadow-none lr-campaign-main"
            : "bg-[var(--surface)] shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] lr-app-main-panel"
        } ${
          section === "calendar" ? "p-2 overflow-hidden" : "p-6 overflow-y-auto"
        } ${isConversationSection && mobilePanel === "list" ? "hidden md:block" : ""}`}
        data-campaign-main={isCampaignSection ? "true" : "false"}
      >
        {isCampaignSection ? (
          <div className="max-w-4xl mx-auto space-y-4 lr-campaign-content">
            <div>
              <h2 className="text-2xl md:text-[2rem] font-semibold tracking-tight">Campaign Studio</h2>
              <p className="text-sm text-gray-500 mt-1">
                1) Set up campaign, 2) generate assets, 3) review drafts, 4) optionally publish to Meta.
              </p>
            </div>

            {campaignError ? (
              <div className="border border-red-200 rounded px-3 py-2 text-sm text-red-700 bg-red-50 lr-campaign-alert">
                {campaignError}
              </div>
            ) : null}
            {metaError ? (
              <div className="border border-red-200 rounded px-3 py-2 text-sm text-red-700 bg-red-50 lr-campaign-alert">
                {metaError}
              </div>
            ) : null}
            <div className="border rounded-xl bg-white p-4 md:p-5 space-y-4 lr-campaign-panel">
              <div className="text-xs font-semibold text-gray-700">1) Campaign setup</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="text-xs text-gray-600">
                  Campaign name
                  <input
                    className="mt-1 w-full border rounded px-3 py-2 text-sm"
                    placeholder="Weekend spring sales event"
                    value={campaignForm.name}
                    onChange={e => setCampaignForm(prev => ({ ...prev, name: e.target.value }))}
                  />
                </label>
                <label className="text-xs text-gray-600">
                  Build mode
                  <select
                    className="mt-1 w-full border rounded px-3 py-2 text-sm bg-white"
                    value={campaignForm.buildMode}
                    onChange={e =>
                      setCampaignForm(prev => ({
                        ...prev,
                        buildMode: e.target.value === "web_search_design" ? "web_search_design" : "design_from_scratch"
                      }))
                    }
                  >
                    <option value="design_from_scratch">Start from scratch</option>
                    <option value="web_search_design">Web search design</option>
                  </select>
                </label>
              </div>

              <label className="block text-xs text-gray-600">
                Prompt
                <textarea
                  className="mt-1 w-full border rounded-xl px-3 py-3 text-sm min-h-[120px]"
                  placeholder="Describe the promotion/event and what creative to generate."
                  value={campaignForm.prompt}
                  onChange={e => setCampaignForm(prev => ({ ...prev, prompt: e.target.value }))}
                />
              </label>

              <div className="border rounded-lg p-3 bg-gray-50 space-y-2 lr-campaign-subpanel">
                <div className="text-xs font-semibold text-gray-700">2) Output format (one at a time)</div>
                <div className="flex flex-wrap gap-2">
                  {CAMPAIGN_ASSET_TARGET_OPTIONS.map(opt => {
                    const isChecked = (campaignForm.assetTargets ?? []).includes(opt.value);
                    return (
                      <label
                        key={`campaign-asset-target-${opt.value}`}
                        className={`inline-flex items-center gap-2 border rounded px-3 py-2 text-sm transition-colors lr-campaign-target-pill ${
                          isChecked
                            ? "bg-[var(--lr-accent)] text-[#101522] border-[var(--lr-accent)] font-semibold"
                            : "bg-transparent text-gray-100 border-[rgba(255,255,255,0.32)]"
                        } cursor-pointer`}
                      >
                        <input
                          type="radio"
                          name="campaign-output-target"
                          className="h-4 w-4 accent-[var(--lr-accent)] lr-campaign-target-input"
                          checked={isChecked}
                          onChange={() =>
                            setCampaignForm(prev => {
                              return {
                                ...prev,
                                assetTargets: [opt.value]
                              };
                            })
                          }
                        />
                        <span className="lr-campaign-target-pill-label">{opt.label}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="text-[11px] text-gray-500">
                  Select one output format, generate it, then switch formats if you want more versions.
                </div>
                <div className="text-[11px] text-gray-500">
                  Web banner uses Dealer Profile size (
                  {(() => {
                    const widthFromForm = Number(dealerProfileForm.campaignWebBannerWidth);
                    const widthFromProfile = Number(
                      (dealerProfile as any)?.campaign?.webBannerWidth ?? (dealerProfile as any)?.webBannerWidth
                    );
                    if (Number.isFinite(widthFromForm) && widthFromForm > 0) return Math.round(widthFromForm);
                    if (Number.isFinite(widthFromProfile) && widthFromProfile > 0) return Math.round(widthFromProfile);
                    return 1920;
                  })()}
                  x
                  {(() => {
                    const heightFromForm = Number(dealerProfileForm.campaignWebBannerHeight);
                    const heightFromProfile = Number(
                      (dealerProfile as any)?.campaign?.webBannerHeight ?? (dealerProfile as any)?.webBannerHeight
                    );
                    if (Number.isFinite(heightFromForm) && heightFromForm > 0) return Math.round(heightFromForm);
                    if (Number.isFinite(heightFromProfile) && heightFromProfile > 0) {
                      return Math.round(heightFromProfile);
                    }
                    return 600;
                  })()}
                  ), fit mode:{" "}
                  <span className="font-semibold">{dealerProfileForm.campaignWebBannerFit}</span>. Select{" "}
                  <span className="font-semibold">Web banner</span> as the selected output format to generate that exact frame.
                  {" "}Zoom-out inset:{" "}
                  <span className="font-semibold">
                    {(() => {
                      const insetFromForm = Number(dealerProfileForm.campaignWebBannerInsetPercent);
                      const insetFromProfile = Number(
                        (dealerProfile as any)?.campaign?.webBannerInsetPercent ??
                          (dealerProfile as any)?.webBannerInsetPercent
                      );
                      if (Number.isFinite(insetFromForm) && insetFromForm >= 0) {
                        return `${Math.max(0, Math.min(25, insetFromForm))}%`;
                      }
                      if (Number.isFinite(insetFromProfile) && insetFromProfile >= 0) {
                        return `${Math.max(0, Math.min(25, insetFromProfile))}%`;
                      }
                      return "0%";
                    })()}
                  </span>
                  .
                </div>
                {!campaignHasAnyTarget ? (
                  <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    Select at least one output file before generating.
                  </div>
                ) : null}
              </div>

              <div className="border rounded-lg p-3 bg-gray-50 space-y-3 lr-campaign-subpanel">
                <div className="text-xs font-semibold text-gray-700">Optional reference material</div>
                <div
                  className={`grid grid-cols-1 gap-3 ${
                    campaignForm.buildMode === "design_from_scratch" ? "md:grid-cols-3" : "md:grid-cols-1"
                  }`}
                >
                  <div className="border rounded-lg p-3 bg-white/90 lr-campaign-upload-card">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-gray-700">Brief files</div>
                      <div className="text-[11px] text-gray-500">{campaignBriefPreviewUrls.length}</div>
                    </div>
                    <div
                      className={`mt-2 lr-campaign-dropzone ${campaignActiveDropZone === "briefs" ? "is-dragging" : ""}`}
                      onDragEnter={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCampaignActiveDropZone("briefs");
                      }}
                      onDragOver={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (campaignActiveDropZone !== "briefs") setCampaignActiveDropZone("briefs");
                      }}
                      onDragLeave={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        const nextTarget = e.relatedTarget as Node | null;
                        if (nextTarget && e.currentTarget.contains(nextTarget)) return;
                        if (campaignActiveDropZone === "briefs") setCampaignActiveDropZone("");
                      }}
                      onDrop={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCampaignActiveDropZone("");
                        void handleCampaignDropZoneFiles("briefs", e.dataTransfer?.files ?? null);
                      }}
                    >
                      <div className="text-xs font-semibold text-gray-700">
                        Drag &amp; drop file(s)
                      </div>
                      <div className="text-[11px] text-gray-500 mt-0.5">
                        PDF, DOC, TXT, CSV, JSON, HTML
                      </div>
                      <button
                        type="button"
                        className="lr-campaign-upload-btn mt-2"
                        disabled={campaignBriefUploadBusy}
                        onClick={() => campaignBriefUploadInputRef.current?.click()}
                      >
                        {campaignBriefUploadBusy ? "Uploading..." : "Choose files"}
                      </button>
                      <input
                        ref={campaignBriefUploadInputRef}
                        className="hidden"
                        type="file"
                        accept=".pdf,.txt,.md,.csv,.json,.html,.doc,.docx,application/pdf,text/plain,text/markdown,text/csv,application/json,text/html,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        multiple
                        disabled={campaignBriefUploadBusy}
                        onChange={async e => {
                          const inputEl = e.currentTarget;
                          await handleCampaignBriefUploads(inputEl.files);
                          inputEl.value = "";
                        }}
                      />
                    </div>
                    {campaignBriefPreviewUrls.length ? (
                      <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto pr-1">
                        {campaignBriefPreviewUrls.map((url, idx) => (
                          <div key={`campaign-brief-${idx}`} className="lr-campaign-upload-row">
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="min-w-0 truncate text-[11px] font-medium text-blue-700 hover:underline"
                              title={url}
                            >
                              {campaignFileLabelFromUrl(url, `brief-${idx + 1}`)}
                            </a>
                            <button
                              type="button"
                              className="lr-campaign-upload-remove"
                              onClick={() => removeCampaignUrlFromField("briefDocumentUrlsText", url)}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 text-[11px] text-gray-500">No brief files yet.</div>
                    )}
                  </div>

                  {campaignForm.buildMode === "design_from_scratch" ? (
                    <>
                      <div className="border rounded-lg p-3 bg-white/90 lr-campaign-upload-card">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-gray-700">Reference images</div>
                          <div className="text-[11px] text-gray-500">{campaignInspirationPreviewUrls.length}</div>
                        </div>
                        <div
                          className={`mt-2 lr-campaign-dropzone ${campaignActiveDropZone === "refs" ? "is-dragging" : ""}`}
                          onDragEnter={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCampaignActiveDropZone("refs");
                          }}
                          onDragOver={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (campaignActiveDropZone !== "refs") setCampaignActiveDropZone("refs");
                          }}
                          onDragLeave={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            const nextTarget = e.relatedTarget as Node | null;
                            if (nextTarget && e.currentTarget.contains(nextTarget)) return;
                            if (campaignActiveDropZone === "refs") setCampaignActiveDropZone("");
                          }}
                          onDrop={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCampaignActiveDropZone("");
                            void handleCampaignDropZoneFiles("refs", e.dataTransfer?.files ?? null);
                          }}
                        >
                          <div className="text-xs font-semibold text-gray-700">Drag &amp; drop image(s)</div>
                          <div className="text-[11px] text-gray-500 mt-0.5">PNG, JPG, WEBP, GIF</div>
                          <button
                            type="button"
                            className="lr-campaign-upload-btn mt-2"
                            disabled={campaignInspirationUploadBusy}
                            onClick={() => campaignInspirationUploadInputRef.current?.click()}
                          >
                            {campaignInspirationUploadBusy ? "Uploading..." : "Choose images"}
                          </button>
                          <input
                            ref={campaignInspirationUploadInputRef}
                            className="hidden"
                            type="file"
                            accept="image/*"
                            multiple
                            disabled={campaignInspirationUploadBusy}
                            onChange={async e => {
                              const inputEl = e.currentTarget;
                              await handleCampaignInspirationUploads(inputEl.files);
                              inputEl.value = "";
                            }}
                          />
                        </div>
                        {campaignInspirationPreviewUrls.length ? (
                          <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto pr-1">
                            {campaignInspirationPreviewUrls.map((url, idx) => (
                              <div key={`campaign-ref-${idx}`} className="lr-campaign-upload-row">
                                <img
                                  src={url}
                                  alt={`Reference ${idx + 1}`}
                                  className="h-9 w-14 object-cover rounded border shrink-0"
                                  loading="lazy"
                                />
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="min-w-0 truncate text-[11px] font-medium text-blue-700 hover:underline"
                                  title={url}
                                >
                                  {campaignFileLabelFromUrl(url, `reference-${idx + 1}`)}
                                </a>
                                <button
                                  type="button"
                                  className="lr-campaign-upload-remove"
                                  onClick={() => removeCampaignUrlFromField("inspirationImageUrlsText", url)}
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-2 text-[11px] text-gray-500">No reference images yet.</div>
                        )}
                      </div>

                      <div className="border rounded-lg p-3 bg-white/90 lr-campaign-upload-card">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-gray-700">Design images</div>
                          <div className="text-[11px] text-gray-500">{campaignAssetPreviewUrls.length}</div>
                        </div>
                        <div
                          className={`mt-2 lr-campaign-dropzone ${campaignActiveDropZone === "design" ? "is-dragging" : ""}`}
                          onDragEnter={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCampaignActiveDropZone("design");
                          }}
                          onDragOver={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (campaignActiveDropZone !== "design") setCampaignActiveDropZone("design");
                          }}
                          onDragLeave={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            const nextTarget = e.relatedTarget as Node | null;
                            if (nextTarget && e.currentTarget.contains(nextTarget)) return;
                            if (campaignActiveDropZone === "design") setCampaignActiveDropZone("");
                          }}
                          onDrop={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCampaignActiveDropZone("");
                            void handleCampaignDropZoneFiles("design", e.dataTransfer?.files ?? null);
                          }}
                        >
                          <div className="text-xs font-semibold text-gray-700">Drag &amp; drop image(s)</div>
                          <div className="text-[11px] text-gray-500 mt-0.5">
                            Use logos, badges, overlays (treated as required by generator)
                          </div>
                          <button
                            type="button"
                            className="lr-campaign-upload-btn mt-2"
                            disabled={campaignAssetUploadBusy}
                            onClick={() => campaignAssetUploadInputRef.current?.click()}
                          >
                            {campaignAssetUploadBusy ? "Uploading..." : "Choose images"}
                          </button>
                          <input
                            ref={campaignAssetUploadInputRef}
                            className="hidden"
                            type="file"
                            accept="image/*"
                            multiple
                            disabled={campaignAssetUploadBusy}
                            onChange={async e => {
                              const inputEl = e.currentTarget;
                              await handleCampaignAssetUploads(inputEl.files);
                              inputEl.value = "";
                            }}
                          />
                        </div>
                        {campaignAssetPreviewUrls.length ? (
                          <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto pr-1">
                            {campaignAssetPreviewUrls.map((url, idx) => (
                              <div key={`campaign-design-${idx}`} className="lr-campaign-upload-row">
                                <img
                                  src={url}
                                  alt={`Design image ${idx + 1}`}
                                  className="h-9 w-14 object-cover rounded border shrink-0"
                                  loading="lazy"
                                />
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="min-w-0 truncate text-[11px] font-medium text-blue-700 hover:underline"
                                  title={url}
                                >
                                  {campaignFileLabelFromUrl(url, `design-${idx + 1}`)}
                                </a>
                                <button
                                  type="button"
                                  className="lr-campaign-upload-remove"
                                  onClick={() => removeCampaignUrlFromField("assetImageUrlsText", url)}
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-2 text-[11px] text-gray-500">No design images yet.</div>
                        )}
                      </div>
                    </>
                  ) : null}
                </div>
                <div className="text-[11px] text-gray-500">
                  Drag files into the boxes or click Choose. Remove anything you do not want included.
                </div>
              </div>

              <div className="border rounded-lg p-3 bg-gray-50 space-y-3 lr-campaign-subpanel">
                <div className="text-xs font-semibold text-gray-700">3) Generate assets</div>
                {(() => {
                  const label = campaignActiveTarget
                    ? CAMPAIGN_ASSET_TARGET_OPTIONS.find(opt => opt.value === campaignActiveTarget)?.label ?? campaignActiveTarget
                    : "No output selected";
                  const statusRow = campaignActiveTarget ? campaignAssetGenerationStatus[campaignActiveTarget] : null;
                  const statusRaw = String(statusRow?.status ?? "").trim().toLowerCase();
                  const hasAsset = campaignActiveTarget ? campaignGeneratedAssetTargetSet.has(campaignActiveTarget) : false;
                  const status: "ready" | "pending" | "failed" =
                    statusRaw === "failed" ? "failed" : hasAsset ? "ready" : "pending";
                  const badgeClass =
                    status === "ready"
                      ? "border-green-300 bg-green-50 text-green-700"
                      : status === "failed"
                        ? "border-red-300 bg-red-50 text-red-700"
                        : "border-amber-300 bg-amber-50 text-amber-700";
                  return (
                    <div className="border rounded px-3 py-2 bg-white">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-gray-600">Output</div>
                        <span className={`text-[10px] px-2 py-0.5 rounded border ${badgeClass}`}>
                          {status === "ready" ? "Ready" : status === "failed" ? "Failed" : "Pending"}
                        </span>
                      </div>
                      <div className="text-sm font-semibold mt-1">{label}</div>
                      <div className="text-[11px] text-gray-500 mt-1">Change output format in Step 2.</div>
                      {statusRow?.error && status === "failed" ? (
                        <div className="text-[11px] text-red-600 mt-1 line-clamp-2">{statusRow.error}</div>
                      ) : null}
                    </div>
                  );
                })()}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="px-3 py-2 border rounded text-sm bg-gray-900 text-white hover:bg-black disabled:opacity-60 lr-campaign-btn-primary"
                    onClick={() => {
                      void generateCampaign({
                        target: campaignActiveTarget,
                        replaceTarget: true,
                        editFromCurrent: campaignEditFromCurrentImage
                      });
                    }}
                    disabled={campaignGenerating || campaignSaving || !campaignHasAnyTarget}
                  >
                    {campaignGenerating ? "Generating..." : "Generate"}
                  </button>
                  <button
                    className="px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)] disabled:opacity-60 lr-campaign-btn"
                    onClick={() => {
                      void generateCampaign({
                        target: campaignActiveTarget,
                        replaceTarget: true,
                        editFromCurrent: campaignEditFromCurrentImage
                      });
                    }}
                    disabled={campaignGenerating || campaignSaving || !campaignForm.name.trim() || !campaignHasAnyTarget}
                  >
                    {campaignGenerating ? "Redoing..." : "Redo"}
                  </button>
                  <button
                    className="px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)] disabled:opacity-60 lr-campaign-btn"
                    onClick={() => {
                      void saveCampaignDraft();
                    }}
                    disabled={campaignSaving || campaignGenerating}
                  >
                    {campaignSaving ? "Saving..." : "Save Draft"}
                  </button>
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-gray-700">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={campaignEditFromCurrentImage}
                    onChange={e => setCampaignEditFromCurrentImage(e.target.checked)}
                    disabled={campaignGenerating || !campaignHasAnyTarget || !campaignHasCurrentBaseImage}
                  />
                  <span>
                    Keep current image as base (edit mode)
                  </span>
                </label>
                {campaignEditFromCurrentImage ? (
                  <div className="text-[11px] text-gray-600">
                    Edits the current {CAMPAIGN_ASSET_TARGET_OPTIONS.find(opt => opt.value === campaignActiveTarget)?.label ?? "output"} using your prompt (for example date/text tweaks).
                  </div>
                ) : null}
                {!campaignHasCurrentBaseImage ? (
                  <div className="text-[11px] text-gray-500">
                    Generate this output once first to enable edit mode.
                  </div>
                ) : null}
                <div className="text-[11px] text-gray-500">
                  Generate creates/updates the selected output. Redo retries the same output.
                </div>
                <div className="pt-1 border-t border-gray-200 text-[11px] text-gray-600">
                  Use the per-file actions directly inside each preview frame.
                </div>
              </div>
            </div>

            <div className="border rounded-xl bg-white p-4 md:p-5 space-y-4 lr-campaign-panel">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold">Generated Output</div>
                <div className="text-[11px] text-gray-500 text-right">
                  {campaignGeneratedBy ? `Source: ${campaignGeneratedBy}` : "Source: N/A"}
                  {campaignGeneratedAt ? ` • ${new Date(campaignGeneratedAt).toLocaleString()}` : ""}
                </div>
              </div>

              <div className="border rounded-lg p-3 bg-gray-50 space-y-3 lr-campaign-subpanel">
                {campaignGeneratedAssets.length ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {campaignGeneratedAssets.map((asset, idx) => {
                      const label = campaignAssetDisplayLabel(asset);
                      const meta = [asset.mimeType].filter(Boolean).join(" • ");
                      const socialCaptionPreview =
                        asset.target === "facebook_post" || asset.target === "instagram_post"
                          ? campaignComposePublishCaption(
                              campaignAutoCaptionPreview,
                              campaignSocialOptionsByTarget[asset.target]
                            )
                          : "";
                      const isFlyerOutput = asset.target === "flyer_8_5x11";
                      const smsDraftPreview =
                        asset.target === "sms"
                          ? String(campaignForm.smsBody ?? "").trim() ||
                            String(campaignPreviewEntry?.smsBody ?? "").trim()
                          : "";
                      const queueKind = campaignQueueKindForAssetTarget(asset.target);
                      const queueable = Boolean(queueKind);
                      const actionGridClass = queueable
                        ? "grid grid-cols-4 gap-2 p-2 border-t bg-gray-50 mt-auto"
                        : "grid grid-cols-3 gap-2 p-2 border-t bg-gray-50 mt-auto";
                      const queueBusy = campaignAssetQueueBusyTarget === asset.target;
                      const campaignId = String(campaignSelectedId ?? "").trim();
                      const sendBusyKey = `send:${campaignId}:${asset.target}`;
                      const postBusyPrefix = `post:${campaignId}:${asset.target}:`;
                      const removeBusyKey = `remove:${campaignId}:${asset.target}:${asset.url}`;
                      const removeBusy = campaignRemovingAssetKey === removeBusyKey;
                      const actionBusy = queueKind
                        ? queueKind === "send"
                          ? campaignQueueActionBusyKey === sendBusyKey
                          : campaignQueueActionBusyKey.startsWith(postBusyPrefix)
                        : false;
                      const actionLabel = queueKind === "send" ? "Send" : queueKind === "post" ? "Post" : "";
                      const actionBusyLabel =
                        queueKind === "send" ? "Opening Send..." : queueKind === "post" ? "Opening Post..." : "";
                      return (
                        <div
                          key={`campaign-preview-image-${asset.target}-${idx}`}
                          className="border rounded overflow-hidden bg-white flex flex-col"
                          title={asset.url}
                        >
                          <div className="px-3 py-2 border-b text-xs bg-gray-50">
                            <div className="font-semibold">{label}</div>
                            {meta ? <div className="text-[11px] text-gray-500 mt-0.5">{meta}</div> : null}
                          </div>
                          <a href={asset.url} target="_blank" rel="noreferrer" className="block bg-white">
                            <img
                              src={asset.url}
                              alt={`Campaign preview ${label}`}
                              className="w-full max-h-[440px] object-contain bg-white"
                              loading="lazy"
                            />
                          </a>
                          {socialCaptionPreview ? (
                            <div className="lr-campaign-copy-block">
                              <div className="lr-campaign-copy-label">Auto caption</div>
                              <div className="lr-campaign-copy-text">
                                {socialCaptionPreview}
                              </div>
                            </div>
                          ) : null}
                          {smsDraftPreview ? (
                            <div className="lr-campaign-copy-block">
                              <div className="lr-campaign-copy-label">SMS draft</div>
                              <div className="lr-campaign-copy-text">
                                {smsDraftPreview}
                              </div>
                            </div>
                          ) : null}
                          <div className={actionGridClass}>
                            {isFlyerOutput ? (
                              <button
                                className="lr-campaign-asset-btn"
                                type="button"
                                onClick={() => {
                                  void printCampaignAsset(asset.url, campaignAssetDisplayLabel(asset));
                                }}
                              >
                                Print
                              </button>
                            ) : (
                              <a
                                className="lr-campaign-asset-btn"
                                href={asset.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open
                              </a>
                            )}
                            <button
                              className="lr-campaign-asset-btn"
                              type="button"
                              onClick={() => {
                                void downloadCampaignAsset(asset.url, campaignAssetDisplayLabel(asset));
                              }}
                            >
                              Download
                            </button>
                            {queueable ? (
                              <button
                                className="lr-campaign-asset-btn lr-campaign-asset-btn-primary"
                                disabled={
                                  !campaignId ||
                                  queueBusy ||
                                  Boolean(campaignQueueActionBusyKey) ||
                                  campaignGenerating ||
                                  campaignSaving
                                }
                                onClick={() => {
                                  void openCampaignAssetPrimaryAction(asset);
                                }}
                            >
                              {queueBusy || actionBusy ? actionBusyLabel : actionLabel}
                            </button>
                          ) : null}
                          <button
                            className="lr-campaign-asset-btn text-red-700 border-red-300 hover:bg-red-50"
                            type="button"
                            disabled={
                              !campaignId ||
                              removeBusy ||
                              queueBusy ||
                              Boolean(campaignQueueActionBusyKey) ||
                              campaignGenerating ||
                              campaignSaving
                            }
                            onClick={() => {
                              void removeCampaignGeneratedAsset(asset);
                            }}
                          >
                            {removeBusy ? "Removing..." : isFlyerOutput ? "Delete" : "Remove"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                ) : campaignFinalImageUrl ? (
                  <div className="border rounded overflow-hidden bg-white flex flex-col" title={campaignFinalImageUrl}>
                    <a href={campaignFinalImageUrl} target="_blank" rel="noreferrer" className="block bg-white">
                      <img
                        src={campaignFinalImageUrl}
                        alt="Final generated campaign creative"
                        className="w-full max-h-[440px] object-contain bg-white"
                        loading="lazy"
                      />
                    </a>
                    <div className="grid grid-cols-3 gap-2 p-2 border-t bg-gray-50">
                      <a
                        className="lr-campaign-asset-btn"
                        href={campaignFinalImageUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                      </a>
                      <button
                        className="lr-campaign-asset-btn"
                        type="button"
                        onClick={() => {
                          void downloadCampaignAsset(campaignFinalImageUrl, "campaign_output");
                        }}
                      >
                        Download
                      </button>
                      <button
                        className="lr-campaign-asset-btn text-red-700 border-red-300 hover:bg-red-50"
                        type="button"
                        disabled={
                          !campaignSelectedId ||
                          campaignRemovingAssetKey ===
                            `remove:${String(campaignSelectedId ?? "").trim()}:final:${campaignFinalImageUrl}` ||
                          campaignGenerating ||
                          campaignSaving
                        }
                        onClick={() => {
                          void removeCampaignFinalImagePreview();
                        }}
                      >
                        {campaignRemovingAssetKey ===
                        `remove:${String(campaignSelectedId ?? "").trim()}:final:${campaignFinalImageUrl}`
                          ? "Removing..."
                          : "Remove"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-gray-500 py-10 text-center">
                    Generate to preview your final image here.
                  </div>
                )}
                <div className="text-[11px] text-gray-500">
                  Preview is scaled to fit this panel. Buttons in each frame use native file output.
                </div>
              </div>

              {campaignWantsSms ? (
                <label className="block text-xs text-gray-600">
                  SMS draft
                  <textarea
                    className="mt-1 w-full border rounded px-3 py-2 text-sm min-h-[90px]"
                    value={campaignForm.smsBody}
                    onChange={e => setCampaignForm(prev => ({ ...prev, smsBody: e.target.value }))}
                  />
                </label>
              ) : null}

              {campaignWantsEmail ? (
                <>
                  <label className="block text-xs text-gray-600">
                    Email subject
                    <input
                      className="mt-1 w-full border rounded px-3 py-2 text-sm"
                      value={campaignForm.emailSubject}
                      onChange={e => setCampaignForm(prev => ({ ...prev, emailSubject: e.target.value }))}
                    />
                  </label>

                  <label className="block text-xs text-gray-600">
                    Email draft
                    <textarea
                      className="mt-1 w-full border rounded px-3 py-2 text-sm min-h-[160px]"
                      value={campaignForm.emailBodyText}
                      onChange={e => setCampaignForm(prev => ({ ...prev, emailBodyText: e.target.value }))}
                    />
                  </label>

                  <details className="border rounded p-3 bg-gray-50">
                    <summary className="text-xs font-semibold text-gray-700 cursor-pointer">
                      Advanced HTML + References
                    </summary>
                    <label className="block text-xs text-gray-600 mt-3">
                      Email body (HTML)
                      <textarea
                        className="mt-1 w-full border rounded px-3 py-2 text-xs min-h-[160px] font-mono"
                        value={campaignForm.emailBodyHtml}
                        onChange={e => setCampaignForm(prev => ({ ...prev, emailBodyHtml: e.target.value }))}
                      />
                    </label>
                    <div className="mt-3">
                      <div className="text-xs font-semibold text-gray-700 mb-2">Reference hits</div>
                      {campaignSourceHits.length ? (
                        <div className="space-y-2 max-h-[220px] overflow-y-auto">
                          {campaignSourceHits.map((hit, idx) => (
                            <div key={`campaign-hit-${idx}`} className="text-xs">
                              <a
                                href={hit.url || "#"}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-700 hover:underline font-medium"
                              >
                                {hit.title || hit.domain || hit.url || `Reference ${idx + 1}`}
                              </a>
                              {hit.snippet ? <div className="text-gray-600 mt-0.5">{hit.snippet}</div> : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-500">No references yet.</div>
                      )}
                    </div>
                  </details>
                </>
              ) : null}
            </div>
          </div>
        ) : section === "kpi" ? (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">Manager KPI Overview</h2>
                <p className="text-xs text-gray-500 mt-1">
                  Tracks response, call speed, appointments, close outcomes, and source performance.
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Scope:{" "}
                  {kpiLeadScopeFilter === "walkin_only"
                    ? "Walk-ins only"
                    : kpiLeadScopeFilter === "include_walkins"
                      ? "Online + walk-ins"
                      : "Online leads only"}
                </p>
              </div>
              <button
                className="px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)]"
                onClick={() => void loadKpiOverview()}
              >
                Refresh
              </button>
            </div>

            {kpiLoading ? (
              <div className="text-sm text-gray-500">Loading KPI overview...</div>
            ) : !kpiOverview ? (
              <div className="text-sm text-gray-500">No KPI data available for the selected filters.</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">Lead Volume</div>
                    <div className="text-2xl font-semibold mt-1">{kpiOverview.totals.leadVolume}</div>
                  </div>
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">% Responded</div>
                    <div className="text-2xl font-semibold mt-1">{kpiOverview.totals.responseRatePct.toFixed(2)}%</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {kpiOverview.totals.respondedCount} responded
                    </div>
                  </div>
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">Avg First Response</div>
                    <div className="text-2xl font-semibold mt-1">
                      {kpiOverview.totals.avgFirstResponseMinutes != null
                        ? `${kpiOverview.totals.avgFirstResponseMinutes}m`
                        : "N/A"}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Median:{" "}
                      {kpiOverview.totals.medianFirstResponseMinutes != null
                        ? `${kpiOverview.totals.medianFirstResponseMinutes}m`
                        : "N/A"}
                    </div>
                  </div>
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">Appointment Rate</div>
                    <div className="text-2xl font-semibold mt-1">
                      {kpiOverview.totals.appointmentRatePct.toFixed(2)}%
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {kpiOverview.totals.appointmentCount} appointments
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">Call Rate</div>
                    <div className="text-2xl font-semibold mt-1">{kpiOverview.totals.callRatePct.toFixed(2)}%</div>
                    <div className="text-xs text-gray-500 mt-1">{kpiOverview.totals.callCount} called</div>
                  </div>
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">Time To Call</div>
                    <div className="text-2xl font-semibold mt-1">
                      {kpiOverview.totals.avgTimeToCallMinutes != null
                        ? `${kpiOverview.totals.avgTimeToCallMinutes}m`
                        : "N/A"}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Median:{" "}
                      {kpiOverview.totals.medianTimeToCallMinutes != null
                        ? `${kpiOverview.totals.medianTimeToCallMinutes}m`
                        : "N/A"}
                    </div>
                  </div>
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">Appointment Show Rate</div>
                    <div className="text-2xl font-semibold mt-1">
                      {kpiOverview.totals.appointmentShowRatePct.toFixed(2)}%
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {kpiOverview.totals.appointmentShowedCount} showed up
                    </div>
                  </div>
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">Sold Close Rate</div>
                    <div className="text-2xl font-semibold mt-1">
                      {kpiOverview.totals.soldCloseRatePct.toFixed(2)}%
                    </div>
                    <div className="text-xs text-gray-500 mt-1">{kpiOverview.totals.soldCount} sold</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">30d Close</div>
                    <div className="text-lg font-semibold mt-1">{kpiOverview.totals.closeRate30dPct.toFixed(2)}%</div>
                  </div>
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">60d Close</div>
                    <div className="text-lg font-semibold mt-1">{kpiOverview.totals.closeRate60dPct.toFixed(2)}%</div>
                  </div>
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">90d Close</div>
                    <div className="text-lg font-semibold mt-1">{kpiOverview.totals.closeRate90dPct.toFixed(2)}%</div>
                  </div>
                  <div className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500">120d Close</div>
                    <div className="text-lg font-semibold mt-1">
                      {kpiOverview.totals.closeRate120dPct.toFixed(2)}%
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                  <div className="border rounded-lg bg-white overflow-hidden">
                    <div className="px-4 py-3 border-b text-sm font-semibold">Lead Performance By Source</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="text-left px-3 py-2">Source</th>
                            <th className="text-right px-3 py-2">Leads</th>
                            <th className="text-right px-3 py-2">Response %</th>
                            <th className="text-right px-3 py-2">Call %</th>
                            <th className="text-right px-3 py-2">Appt %</th>
                            <th className="text-right px-3 py-2">Show %</th>
                            <th className="text-right px-3 py-2">Sold %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {kpiOverview.bySource.map(row => (
                            <tr key={`kpi-source-row-${row.source}`} className="border-t">
                              <td className="px-3 py-2">{row.source}</td>
                              <td className="px-3 py-2 text-right">{row.leadCount}</td>
                              <td className="px-3 py-2 text-right">{row.responseRatePct.toFixed(2)}%</td>
                              <td className="px-3 py-2 text-right">{row.callRatePct.toFixed(2)}%</td>
                              <td className="px-3 py-2 text-right">{row.appointmentRatePct.toFixed(2)}%</td>
                              <td className="px-3 py-2 text-right">{row.appointmentShowRatePct.toFixed(2)}%</td>
                              <td className="px-3 py-2 text-right">{row.soldCloseRatePct.toFixed(2)}%</td>
                            </tr>
                          ))}
                          {kpiOverview.bySource.length === 0 ? (
                            <tr>
                              <td className="px-3 py-3 text-gray-500" colSpan={6}>
                                No source rows for selected filters.
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="border rounded-lg bg-white overflow-hidden">
                    <div className="px-4 py-3 border-b text-sm font-semibold">Top Incoming Motorcycles</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="text-left px-3 py-2">Motorcycle</th>
                            <th className="text-right px-3 py-2">Count</th>
                            <th className="text-right px-3 py-2">New</th>
                            <th className="text-right px-3 py-2">Used</th>
                          </tr>
                        </thead>
                        <tbody>
                          {kpiOverview.topMotorcycles.map(row => (
                            <tr key={`kpi-bike-${row.motorcycle}`} className="border-t">
                              <td className="px-3 py-2">{row.motorcycle}</td>
                              <td className="px-3 py-2 text-right">{row.count}</td>
                              <td className="px-3 py-2 text-right">{row.newCount}</td>
                              <td className="px-3 py-2 text-right">{row.usedCount}</td>
                            </tr>
                          ))}
                          {kpiOverview.topMotorcycles.length === 0 ? (
                            <tr>
                              <td className="px-3 py-3 text-gray-500" colSpan={4}>
                                No motorcycle volume for selected filters.
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <div className="border rounded-lg bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b text-sm font-semibold">Daily Trend</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2">Day</th>
                          <th className="text-right px-3 py-2">Leads</th>
                          <th className="text-right px-3 py-2">% Responded</th>
                          <th className="text-right px-3 py-2">Calls</th>
                          <th className="text-right px-3 py-2">Appointments</th>
                          <th className="text-right px-3 py-2">Sold</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kpiOverview.trend.map(row => (
                          <tr key={`kpi-trend-${row.day}`} className="border-t">
                            <td className="px-3 py-2">{row.day}</td>
                            <td className="px-3 py-2 text-right">{row.leadCount}</td>
                            <td className="px-3 py-2 text-right">{row.responseRatePct.toFixed(2)}%</td>
                            <td className="px-3 py-2 text-right">{row.callCount}</td>
                            <td className="px-3 py-2 text-right">{row.appointmentCount}</td>
                            <td className="px-3 py-2 text-right">{row.soldCount}</td>
                          </tr>
                        ))}
                        {kpiOverview.trend.length === 0 ? (
                          <tr>
                            <td className="px-3 py-3 text-gray-500" colSpan={6}>
                              No trend points for selected filters.
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="border rounded-lg bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b text-sm font-semibold">
                    Call Details (filterable by salesperson)
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2">Lead</th>
                          <th className="text-left px-3 py-2">Source</th>
                          <th className="text-left px-3 py-2">Salesperson</th>
                          <th className="text-left px-3 py-2">First Inbound</th>
                          <th className="text-left px-3 py-2">First Call</th>
                          <th className="text-right px-3 py-2">Time To Call</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kpiVisibleCallDetails.map(row => (
                          <tr key={`kpi-call-detail-${row.convId}-${row.firstCallAt ?? "none"}`} className="border-t">
                            <td className="px-3 py-2">
                              <div className="font-medium">{row.leadName || row.leadKey}</div>
                              <div className="text-xs text-gray-500">{row.leadPhone || row.leadKey}</div>
                            </td>
                            <td className="px-3 py-2">{row.source}</td>
                            <td className="px-3 py-2">{row.ownerName || "Unassigned"}</td>
                            <td className="px-3 py-2">
                              {row.firstInboundAt ? new Date(row.firstInboundAt).toLocaleString() : "N/A"}
                            </td>
                            <td className="px-3 py-2">
                              {row.firstCallAt ? new Date(row.firstCallAt).toLocaleString() : "N/A"}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {row.timeToCallMinutes != null ? `${row.timeToCallMinutes}m` : "N/A"}
                            </td>
                          </tr>
                        ))}
                        {kpiVisibleCallDetails.length === 0 ? (
                          <tr>
                            <td className="px-3 py-3 text-gray-500" colSpan={6}>
                              No call detail rows for the selected filters.
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : section === "calendar" ? (
          <div className="flex flex-col h-full">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-4">
              <div className="flex items-center gap-2">
                <button
                  className={`px-3 py-2 border rounded text-sm ${calendarView === "day" ? "font-semibold bg-gray-100" : ""}`}
                  onClick={() => setCalendarView("day")}
                >
                  Day
                </button>
                <button
                  className={`px-3 py-2 border rounded text-sm ${calendarView === "week" ? "font-semibold bg-gray-100" : ""}`}
                  onClick={() => setCalendarView("week")}
                >
                  Week
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm text-gray-600 w-full md:w-auto">
                  {calendarDate.toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric"
                  })}
                </div>
                <button
                  className="px-2 py-1 border rounded text-sm"
                  onClick={() => {
                    const d = new Date(calendarDate);
                    d.setDate(d.getDate() + (calendarView === "week" ? -7 : -1));
                    setCalendarDate(d);
                  }}
                >
                  ◀
                </button>
                <button
                  className="px-3 py-1 border rounded text-sm"
                  onClick={() => setCalendarDate(new Date())}
                >
                  Today
                </button>
                <button
                  className="px-2 py-1 border rounded text-sm"
                  onClick={() => {
                    const d = new Date(calendarDate);
                    d.setDate(d.getDate() + (calendarView === "week" ? 7 : 1));
                    setCalendarDate(d);
                  }}
                >
                  ▶
                </button>
                <input
                  type="date"
                  className="border rounded px-2 py-1 text-sm w-full md:w-auto"
                  value={calendarDate.toISOString().slice(0, 10)}
                  onChange={e => {
                    const next = new Date(calendarDate);
                    const [y, m, d] = e.target.value.split("-").map(Number);
                    if (y && m && d) {
                      next.setFullYear(y, m - 1, d);
                      setCalendarDate(next);
                    }
                  }}
                />
              </div>
              <div className="relative self-start md:self-auto">
                <button
                  className="px-3 py-2 border rounded text-sm"
                  onClick={() => setCalendarFilterOpen(v => !v)}
                >
                  Filter calendars
                </button>
                {calendarFilterOpen ? (
                  <div className="absolute right-0 mt-2 w-[min(20rem,calc(100vw-2rem))] md:w-64 bg-white border rounded-lg shadow-lg p-3 z-50">
                    <div className="text-xs font-semibold text-gray-600 mb-2">Show calendars</div>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {calendarUsers.map((u: any) => (
                        <label key={u.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={calendarSalespeople.includes(u.id)}
                            onChange={e => {
                              if (e.target.checked) {
                                setCalendarSalespeople(prev => [...prev, u.id]);
                              } else {
                                setCalendarSalespeople(prev => prev.filter(id => id !== u.id));
                              }
                            }}
                          />
                          <span>{u.name || u.email || u.id} {u.role ? `(${u.role})` : ""}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {googleStatus && !googleStatus.connected ? (
              <div className="mt-3 mb-2 rounded border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-sm">
                Google Calendar is not connected
                {googleStatus.reason ? ` (${googleStatus.reason})` : ""}.{" "}
                <a className="underline" href="/integrations/google/start">
                  Reconnect
                </a>
              </div>
            ) : null}

            <div className="flex-1 min-h-0 overflow-auto" ref={calendarGridRef}>
              {calendarLoading ? (
                <div className="text-sm text-gray-500">Loading calendar…</div>
              ) : (
                (() => {
                  const tz = schedulerConfig?.timezone ?? "America/New_York";
                const salespeople = calendarUsers.filter((u: any) =>
                  calendarSalespeople.length ? calendarSalespeople.includes(u.id) : true
                );
                const dayName = calendarDate
                  .toLocaleDateString("en-US", { weekday: "long", timeZone: tz })
                  .toLowerCase();
                const hours = schedulerConfig?.businessHours?.[dayName];
                const parseTime = (t?: string | null) => {
                  if (!t) return null;
                  const [h, m] = t.split(":").map(Number);
                  return h * 60 + (m || 0);
                };
                const openMin = parseTime(hours?.open) ?? null;
                const closeMin = parseTime(hours?.close) ?? null;
                const booking = dayName === "saturday"
                  ? schedulerConfig?.bookingWindows?.saturday
                  : schedulerConfig?.bookingWindows?.weekday;
                const bookingOpen = parseTime(booking?.earliestStart ?? null);
                const bookingLatest = parseTime(booking?.latestStart ?? null);

                if (calendarView === "day") {
                  let openWindow: number | null = openMin ?? null;
                  let closeWindow: number | null = closeMin ?? null;
                  if (openWindow == null || closeWindow == null || closeWindow <= openWindow) {
                    if (bookingOpen != null && bookingLatest != null && bookingLatest >= bookingOpen) {
                      openWindow = bookingOpen;
                      closeWindow = bookingLatest + 60;
                    }
                  }
                  const eventsBySp = salespeople.map((sp: any) =>
                    calendarEvents.filter(e => e.salespersonId === sp.id)
                  );
                  const getTzMinutes = (date: Date) => {
                    const parts = new Intl.DateTimeFormat("en-US", {
                      timeZone: tz,
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false
                    }).formatToParts(date);
                    const hour = Number(parts.find(p => p.type === "hour")?.value ?? "0");
                    const minute = Number(parts.find(p => p.type === "minute")?.value ?? "0");
                    return hour * 60 + minute;
                  };
                  if (openWindow == null || closeWindow == null || closeWindow <= openWindow) {
                    let minEvent = Infinity;
                    let maxEvent = -Infinity;
                    eventsBySp.flat().forEach((ev: any) => {
                      const start = ev.start ? new Date(ev.start) : null;
                      const end = ev.end ? new Date(ev.end) : null;
                      if (!start || !end) return;
                      const s = getTzMinutes(start);
                      const e = getTzMinutes(end);
                      minEvent = Math.min(minEvent, s);
                      maxEvent = Math.max(maxEvent, e);
                    });
                    if (Number.isFinite(minEvent) && Number.isFinite(maxEvent)) {
                      openWindow = Math.max(0, minEvent);
                      closeWindow = Math.min(24 * 60, maxEvent);
                    }
                  }
                  const isClosed = openWindow == null || closeWindow == null || closeWindow <= openWindow;
                  if (isClosed) {
                    openWindow = 9 * 60;
                    closeWindow = 18 * 60;
                  }
                  if (openWindow == null || closeWindow == null || closeWindow <= openWindow) {
                    return <div className="text-sm text-gray-600">Closed today.</div>;
                  }
                  openWindow = Math.max(0, Math.floor(openWindow / 60) * 60);
                  closeWindow = Math.min(24 * 60, Math.ceil(closeWindow / 60) * 60);
                  if (closeWindow <= openWindow) {
                    closeWindow = Math.min(24 * 60, openWindow + 60);
                  }
                  const totalMinutes = closeWindow - openWindow;
                  const rowHeight = calendarRowHeight;
                  const slots = [];
                  for (let m = openWindow; m < closeWindow; m += 60) {
                    const h = Math.floor(m / 60);
                    const raw = `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
                    slots.push(formatTimeLabel(raw, tz));
                  }
                  const dayStart = new Date(calendarDate);
                  dayStart.setHours(0, 0, 0, 0);
                  const selectedDayKey = calendarDate.toLocaleDateString("en-CA", { timeZone: tz });
                  const nowDate = new Date(calendarNowMs);
                  const nowDayKey = nowDate.toLocaleDateString("en-CA", { timeZone: tz });
                  const nowMin = getTzMinutes(nowDate);
                  const showNowLine = selectedDayKey === nowDayKey && nowMin >= openWindow && nowMin <= closeWindow;
                  const nowLineTopPercent =
                    showNowLine && totalMinutes > 0
                      ? ((nowMin - openWindow) / totalMinutes) * 100
                      : null;
                  const nowHour = Math.floor(nowMin / 60);
                  const nowMinute = nowMin % 60;
                  const nowLabel = formatTimeLabel(
                    `${String(nowHour).padStart(2, "0")}:${String(nowMinute).padStart(2, "0")}`,
                    tz
                  );

                  return (
                    <div className="space-y-3">
                      <div className="md:hidden space-y-3">
                        {salespeople.length === 0 ? (
                          <div className="border rounded-lg p-3 text-sm text-gray-500">No calendars selected.</div>
                        ) : null}
                        {salespeople.map((sp: any, idx: number) => {
                          const events = (eventsBySp[idx] ?? calendarEvents.filter(e => e.salespersonId === sp.id))
                            .slice()
                            .sort((a: any, b: any) => {
                              const aAt = a?.start ? new Date(a.start).getTime() : 0;
                              const bAt = b?.start ? new Date(b.start).getTime() : 0;
                              return aAt - bAt;
                            });
                          return (
                            <div key={`mobile-${sp.id}`} className="border rounded-lg p-3 space-y-2">
                              <div className="text-sm font-semibold">{sp.name}</div>
                              {events.length === 0 ? (
                                <div className="text-xs text-gray-400">No events</div>
                              ) : (
                                events.map((ev: any) => {
                                  const detail = getEventDetails(ev);
                                  const eventStyle = getEventStyle(ev);
                                  const timeLabel = getEventTimeRangeLabel(ev, tz);
                                  return (
                                    <button
                                      key={ev.id}
                                      className={`w-full text-left text-xs border rounded px-2.5 py-2 ${
                                        ev.readOnly ? "bg-gray-100 text-gray-700 border-gray-200" : ""
                                      }`}
                                      style={eventStyle}
                                      onClick={() => {
                                        if (ev.readOnly) return;
                                        setCalendarEdit({ ...ev, calendarId: ev.calendarId });
                                      }}
                                    >
                                      <div className="font-medium">{getEventTitle(ev)}</div>
                                      {timeLabel ? <div className="mt-1 opacity-80">{timeLabel}</div> : null}
                                      {detail ? <div className="mt-1 opacity-70 line-clamp-2">{detail}</div> : null}
                                    </button>
                                  );
                                })
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="hidden md:block border rounded-lg overflow-hidden">
                        <div className="grid" style={{ gridTemplateColumns: `80px repeat(${salespeople.length || 1}, minmax(180px, 1fr))` }}>
                          <div className="bg-gray-50 border-r p-2 text-xs text-gray-500">Time</div>
                          {salespeople.map((sp: any) => (
                            <div key={sp.id} className="bg-gray-50 border-r p-2 text-sm font-medium">
                              {sp.name}
                            </div>
                          ))}
                        </div>
                        <div className="grid" style={{ gridTemplateColumns: `80px repeat(${salespeople.length || 1}, minmax(180px, 1fr))` }}>
                          <div className="border-r">
                            {slots.map(label => (
                              <div key={label} className="border-b px-2 text-xs text-gray-500 flex items-start" style={{ height: rowHeight }}>
                                {label}
                              </div>
                            ))}
                          </div>
                          {salespeople.map((sp: any, idx: number) => {
                            const events = eventsBySp[idx] ?? calendarEvents.filter(e => e.salespersonId === sp.id);
                            const columnHeight = (totalMinutes / 60) * rowHeight;
                            return (
                              <div
                                key={sp.id}
                                className="relative border-r"
                                style={{
                                  height: columnHeight,
                                  backgroundImage: "linear-gradient(to bottom, rgba(148,163,184,0.58) 1px, transparent 1px)",
                                  backgroundSize: `100% ${rowHeight}px`
                                }}
                                ref={el => {
                                  calendarColumnRefs.current[sp.id] = el;
                                }}
                                onClick={e => {
                                  if (Date.now() < dragGuardRef.current.blockUntil) return;
                                  if (dragStateRef.current.mode) return;
                                  if (e.target instanceof HTMLElement && e.target.closest("[data-cal-event]")) return;
                                  const rect = calendarColumnRefs.current[sp.id]?.getBoundingClientRect();
                                  if (!rect) return;
                                  const y = e.clientY - rect.top;
                                  const minutesFromTop = Math.max(0, Math.min(totalMinutes, (y / rect.height) * totalMinutes));
                                  const snap = 30;
                                  const startMin = Math.round((openWindow + minutesFromTop) / snap) * snap;
                                  const duration = 60;
                                  let endMin = startMin + duration;
                                  if (endMin > closeWindow) {
                                    endMin = closeWindow;
                                  }
                                  setCalendarEdit({
                                    calendarId: sp.calendarId,
                                    salespersonId: sp.id,
                                    _dragStart: startMin,
                                    _dragEnd: endMin
                                  });
                                }}
                                onMouseMove={e => {
                                  const state = dragStateRef.current;
                                  if (!state.mode || !state.event || state.event.salespersonId !== sp.id) return;
                                  applyDragAt(e.clientY);
                                }}
                              >
                                {showNowLine && nowLineTopPercent != null ? (
                                  <div
                                    className="absolute left-0 right-0 z-20 pointer-events-none"
                                    style={{ top: `${nowLineTopPercent}%` }}
                                  >
                                    <div className="relative border-t-2 border-rose-500/90">
                                      {idx === 0 ? (
                                        <span className="absolute -top-3 -left-1 bg-white/95 border border-rose-200 rounded px-1 text-[10px] font-semibold text-rose-700">
                                          Now {nowLabel}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                ) : null}
                                {events.map((ev: any) => {
                                  const start = ev.start ? new Date(ev.start) : null;
                                  const end = ev.end ? new Date(ev.end) : null;
                                  if (!start || !end) return null;
                                  const startMin = getTzMinutes(start);
                                  const endMin = getTzMinutes(end);
                                  const draggedStart = typeof ev._dragStart === "number" ? ev._dragStart : startMin;
                                  const draggedEnd = typeof ev._dragEnd === "number" ? ev._dragEnd : endMin;
                                  const renderStart = Math.max(draggedStart, openWindow);
                                  const renderEnd = Math.min(draggedEnd, closeWindow);
                                  if (renderEnd <= renderStart) return null;
                                  const top = ((renderStart - openWindow) / totalMinutes) * 100;
                                  const height = Math.max(((renderEnd - renderStart) / totalMinutes) * 100, 5);
                                  const minToLabel = (m: number) => {
                                    const h = Math.floor(m / 60);
                                    const mm = m % 60;
                                    return formatTimeLabel(`${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, tz);
                                  };
                                  const timeLabel = `${minToLabel(renderStart)}–${minToLabel(renderEnd)}`;
                                  const detail = getEventDetails(ev);
                                  const eventStyle = getEventStyle(ev);
                                  return (
                                    <div
                                      key={ev.id}
                                      data-cal-event
                                      className={`absolute left-2 right-2 border rounded px-2 py-1 text-xs overflow-hidden cursor-pointer ${
                                        ev.readOnly ? "bg-gray-100 text-gray-700 border-gray-200" : ""
                                      }`}
                                      style={{ top: `${top}%`, height: `${height}%`, ...(eventStyle ?? {}) }}
                                      title={detail || ev.summary}
                                      onMouseDown={e => {
                                        e.stopPropagation();
                                        if (ev.readOnly) return;
                                        if (e.button !== 0) return;
                                        dragStateRef.current = {
                                          mode: "move",
                                          event: ev,
                                          startY: e.clientY,
                                          origStartMin: startMin,
                                          origEndMin: endMin,
                                          openWindow,
                                          closeWindow
                                        };
                                      }}
                                    >
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                          <div className="font-medium truncate">{getEventTitle(ev)}</div>
                                          <div className="text-[10px] opacity-80 mt-1">{timeLabel}</div>
                                          {detail ? (
                                            <div className="text-[10px] opacity-70 mt-1 truncate">
                                              {detail}
                                            </div>
                                          ) : null}
                                        </div>
                                        {ev.readOnly ? null : (
                                          <button
                                            className="text-[10px] px-1.5 py-0.5 rounded border border-blue-300 bg-white/70 hover:bg-white"
                                            onMouseDown={e => {
                                              e.stopPropagation();
                                              e.preventDefault();
                                            }}
                                            onClick={e => {
                                              e.stopPropagation();
                                              if (Date.now() < dragGuardRef.current.blockUntil) return;
                                              setCalendarEdit({ ...ev, calendarId: ev.calendarId });
                                            }}
                                          >
                                            Edit
                                          </button>
                                        )}
                                      </div>
                                      {ev.readOnly ? null : (
                                        <div
                                          className="absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize bg-blue-200/60"
                                          onMouseDown={e => {
                                            e.stopPropagation();
                                            if (e.button !== 0) return;
                                            dragStateRef.current = {
                                              mode: "resize",
                                              event: ev,
                                              startY: e.clientY,
                                              origStartMin: startMin,
                                              origEndMin: endMin,
                                              openWindow,
                                              closeWindow
                                            };
                                          }}
                                        />
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                }

                // week view
                const daysToShow = Array.from({ length: 7 }).map((_, i) => {
                  const d = new Date(calendarDate);
                  d.setDate(d.getDate() + i);
                  return d;
                });
                return (
                  <div className="space-y-3">
                    {daysToShow.map(d => {
                      const dName = d.toLocaleDateString("en-US", { weekday: "long", timeZone: tz }).toLowerCase();
                      const dHours = schedulerConfig?.businessHours?.[dName];
                      const closed = !dHours?.open || !dHours?.close;
                      return (
                        <div key={d.toISOString()} className="border rounded-lg p-3">
                          <div className="text-sm font-semibold">
                            {d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                            {closed ? " • Closed" : ""}
                          </div>
                          {!closed ? (
                            <>
                              <div className="md:hidden mt-2 space-y-2">
                                {salespeople.map((sp: any) => {
                                  const events = calendarEvents
                                    .filter((e: any) => {
                                      if (e.salespersonId !== sp.id) return false;
                                      if (!e.start) return false;
                                      const ed = new Date(e.start);
                                      return (
                                        ed.getFullYear() === d.getFullYear() &&
                                        ed.getMonth() === d.getMonth() &&
                                        ed.getDate() === d.getDate()
                                      );
                                    })
                                    .sort((a: any, b: any) => {
                                      const aAt = a?.start ? new Date(a.start).getTime() : 0;
                                      const bAt = b?.start ? new Date(b.start).getTime() : 0;
                                      return aAt - bAt;
                                    });
                                  return (
                                    <div key={`mobile-week-${sp.id}-${d.toISOString()}`} className="border rounded p-2">
                                      <div className="text-xs text-gray-500 mb-1">{sp.name}</div>
                                      <div className="space-y-1">
                                        {events.length === 0 ? (
                                          <div className="text-xs text-gray-400">No events</div>
                                        ) : (
                                          events.map((ev: any) => (
                                            <div
                                              key={ev.id}
                                              className={`text-xs border rounded px-2 py-1.5 ${
                                                ev.readOnly ? "bg-gray-100 text-gray-700 border-gray-200" : ""
                                              }`}
                                              style={getEventStyle(ev)}
                                              title={getEventDetails(ev) || ev.summary}
                                              onClick={() => {
                                                if (ev.readOnly) return;
                                                setCalendarEdit({ ...ev, calendarId: ev.calendarId });
                                              }}
                                            >
                                              <div className="font-medium">{getEventTitle(ev)}</div>
                                              <div className="opacity-80 mt-0.5">{getEventTimeRangeLabel(ev, tz)}</div>
                                            </div>
                                          ))
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              <div
                                className="hidden md:grid mt-2"
                                style={{ gridTemplateColumns: `repeat(${salespeople.length || 1}, minmax(180px, 1fr))` }}
                              >
                                {salespeople.map((sp: any) => {
                                  const events = calendarEvents.filter((e: any) => {
                                    if (e.salespersonId !== sp.id) return false;
                                    if (!e.start) return false;
                                    const ed = new Date(e.start);
                                    return (
                                      ed.getFullYear() === d.getFullYear() &&
                                      ed.getMonth() === d.getMonth() &&
                                      ed.getDate() === d.getDate()
                                    );
                                  });
                                  return (
                                    <div key={`${sp.id}-${d.toISOString()}`} className="px-2">
                                      <div className="text-xs text-gray-500 mb-1">{sp.name}</div>
                                      <div className="space-y-1">
                                        {events.length === 0 ? (
                                          <div className="text-xs text-gray-400">No events</div>
                                        ) : (
                                          events.map((ev: any) => (
                                            <div
                                              key={ev.id}
                                              className={`text-xs border rounded px-2 py-1 cursor-pointer ${
                                                ev.readOnly ? "bg-gray-100 text-gray-700 border-gray-200" : ""
                                              }`}
                                              style={getEventStyle(ev)}
                                              title={getEventDetails(ev) || ev.summary}
                                              onClick={() => {
                                                if (ev.readOnly) return;
                                                setCalendarEdit({ ...ev, calendarId: ev.calendarId });
                                              }}
                                            >
                                              {getEventTitle(ev)}
                                            </div>
                                          ))
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                );
                })()
              )}
            </div>
            {calendarEdit ? (
            <div className="fixed inset-0 z-50 flex items-start md:items-center justify-center bg-black/30 p-3 overflow-y-auto">
                <div className="bg-white lr-light-modal w-full max-w-xl rounded-lg shadow-lg p-4 space-y-4 max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
                  <div className="flex items-center justify-between">
                    <div className="text-lg font-semibold">Edit appointment</div>
                    <button className="px-2 py-1 border rounded text-sm" onClick={() => setCalendarEdit(null)}>
                      Close
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <div className="text-xs text-gray-500 mb-1">Calendar owner</div>
                      <select
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={calendarEditSalespersonId}
                        onChange={e => setCalendarEditSalespersonId(e.target.value)}
                      >
                        <option value="">(no change)</option>
                        {calendarUsers.map((u: any) => (
                          <option key={u.id} value={u.id}>
                            {u.name || u.email || u.id} {u.role ? `(${u.role})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      className="border rounded px-3 py-2 text-sm sm:col-span-2"
                      placeholder="Title"
                      value={calendarEditForm.summary}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, summary: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      type="date"
                      value={calendarEditForm.startDate}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, startDate: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      type="time"
                      value={calendarEditForm.startTime}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, startTime: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      type="date"
                      value={calendarEditForm.endDate}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, endDate: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      type="time"
                      value={calendarEditForm.endTime}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, endTime: e.target.value })}
                    />
                    <select
                      className="border rounded px-3 py-2 text-sm sm:col-span-2"
                      value={calendarEditForm.status}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, status: e.target.value })}
                    >
                      <option value="scheduled">Scheduled</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="no_show">No show</option>
                    </select>
                    <div className="sm:col-span-2">
                      <div className="text-xs text-gray-500 mb-1">Color</div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={`w-8 h-8 rounded border ${calendarEditForm.colorId ? "border-gray-300" : "ring-2 ring-blue-400"}`}
                          title="Default"
                          style={{ backgroundColor: "#f3f4f6" }}
                          onClick={() => setCalendarEditForm({ ...calendarEditForm, colorId: "" })}
                        />
                        {CALENDAR_COLORS.map(c => (
                          <button
                            key={c.id}
                            type="button"
                            className={`w-8 h-8 rounded border ${calendarEditForm.colorId === c.id ? "ring-2 ring-blue-400" : "border-transparent"}`}
                            title={c.label}
                            style={{ backgroundColor: c.bg, borderColor: c.border }}
                            onClick={() => setCalendarEditForm({ ...calendarEditForm, colorId: c.id })}
                          />
                        ))}
                      </div>
                    </div>
                    <textarea
                      className="border rounded px-3 py-2 text-sm sm:col-span-2"
                      placeholder="Reason (optional)"
                      rows={3}
                      value={calendarEditForm.reason}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, reason: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button className="px-3 py-2 border rounded text-sm" onClick={saveCalendarEdit}>
                      Save
                    </button>
                    <button className="px-3 py-2 border rounded text-sm" onClick={() => setCalendarEdit(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : section === "inventory" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">Inventory</div>
              <button
                className="px-3 py-2 border rounded text-sm"
                onClick={async () => {
                  setInventoryItems([]);
                  setInventoryNotes({});
                  setInventoryQuery("");
                  setInventoryLoading(true);
                  try {
                    const resp = await fetch("/api/inventory", { cache: "no-store" });
                    const json = await resp.json();
                    const items = Array.isArray(json?.items) ? json.items : [];
                    setInventoryItems(items);
                    const noteMap: Record<string, any[]> = {};
                    items.forEach((it: any) => {
                      const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
                      if (key) noteMap[key] = Array.isArray(it.notes) ? it.notes : [];
                    });
                    setInventoryNotes(noteMap);
                  } catch {
                    setInventoryItems([]);
                  } finally {
                    setInventoryLoading(false);
                  }
                }}
              >
                Refresh
              </button>
            </div>
            {inventoryLoading ? (
              <div className="text-sm text-gray-500">Loading inventory...</div>
            ) : (
              <>
                <datalist id="inventory-note-labels">
                  {inventoryNoteSuggestions.labels.map(label => (
                    <option key={label} value={label} />
                  ))}
                </datalist>
                <datalist id="inventory-note-texts">
                  {inventoryNoteSuggestions.notes.map(note => (
                    <option key={note} value={note} />
                  ))}
                </datalist>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {inventoryItems
                  .filter((it: any) => {
                    const q = inventoryQuery.trim().toLowerCase();
                    if (!q) return true;
                    const hay = [
                      it.stockId,
                      it.vin,
                      it.year,
                      it.make,
                      it.model,
                      it.color
                    ]
                      .filter(Boolean)
                      .join(" ")
                      .toLowerCase();
                    return hay.includes(q);
                  })
                  .map((it: any) => {
                    const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
                    return (
                      <div key={key || it.url || Math.random()} className="border rounded-lg p-3 space-y-2">
                        {it.images?.[0] ? (
                          <img
                            src={it.images[0]}
                            alt={it.model ?? it.stockId ?? "Bike"}
                            className="w-full h-40 object-contain bg-gray-50 rounded"
                          />
                        ) : (
                          <div className="w-full h-40 bg-gray-100 rounded flex items-center justify-center text-xs text-gray-400">
                            No image
                          </div>
                        )}
                        <div className="text-sm font-semibold">
                          {[it.year, it.make, it.model].filter(Boolean).join(" ")}
                        </div>
                        <div className="text-xs text-gray-500">
                          {it.stockId ? `Stock ${it.stockId}` : it.vin ? `VIN ${it.vin}` : "No stock/VIN"}
                        </div>
                        <div className="text-xs text-gray-500">
                          {it.color ? `Color: ${it.color}` : "Color: —"}{" "}
                          {it.price ? `• $${Number(it.price).toLocaleString()}` : ""}
                        </div>
                        {it.url ? (
                          <a className="text-xs text-blue-600 underline" href={it.url} target="_blank" rel="noreferrer">
                            View listing
                          </a>
                        ) : null}
                        <div className="space-y-2">
                          {(inventoryNotes[key] ?? []).map((n: any, idx: number) => {
                            const expired = n?.expiresAt && n.expiresAt < new Date().toISOString().slice(0, 10);
                            const noteId = String(n.id ?? `${key}-${idx}`);
                            const isOpen = inventoryExpandedNote === noteId;
                            const label = String(n.label ?? "").trim() || "Note";
                            const notePreview = String(n.note ?? "").trim();
                            const preview =
                              notePreview.length > 80 ? `${notePreview.slice(0, 80)}…` : notePreview;
                            return (
                              <div key={noteId} className={`border rounded ${expired ? "opacity-50" : ""}`}>
                                <button
                                  className="w-full text-left px-2 py-2 text-xs flex items-center justify-between gap-2"
                                  onClick={() => setInventoryExpandedNote(isOpen ? null : noteId)}
                                >
                                  <div className="min-w-0">
                                    <div className="font-semibold truncate">{label}</div>
                                    {preview ? (
                                      <div className="text-gray-500 truncate">{preview}</div>
                                    ) : (
                                      <div className="text-gray-400 truncate">No details</div>
                                    )}
                                  </div>
                                  <div className="text-gray-400 text-[10px]">
                                    {n.expiresAt ? `Exp ${n.expiresAt}` : "No expiry"}
                                  </div>
                                </button>
                                {isOpen ? (
                                  <div className="px-2 pb-2 space-y-2">
                                    <input
                                      className="w-full border rounded px-2 py-1 text-xs"
                                      placeholder="Label (e.g., Accessories, Finance Special)"
                                      list="inventory-note-labels"
                                      value={n.label ?? ""}
                                      onChange={e =>
                                        setInventoryNotes(prev => {
                                          const next = [...(prev[key] ?? [])];
                                          next[idx] = { ...next[idx], label: e.target.value };
                                          return { ...prev, [key]: next };
                                        })
                                      }
                                    />
                                    <input
                                      className="w-full border rounded px-2 py-2 text-xs"
                                      placeholder="Note details"
                                      list="inventory-note-texts"
                                      value={n.note ?? ""}
                                      onChange={e =>
                                        setInventoryNotes(prev => {
                                          const next = [...(prev[key] ?? [])];
                                          next[idx] = { ...next[idx], note: e.target.value };
                                          return { ...prev, [key]: next };
                                        })
                                      }
                                    />
                                    <div className="flex items-center gap-2">
                                      <input
                                        className="border rounded px-2 py-1 text-xs"
                                        type="date"
                                        value={n.expiresAt ?? ""}
                                        onChange={e =>
                                          setInventoryNotes(prev => {
                                            const next = [...(prev[key] ?? [])];
                                            next[idx] = { ...next[idx], expiresAt: e.target.value };
                                            return { ...prev, [key]: next };
                                          })
                                        }
                                      />
                                      <button
                                        className="px-2 py-1 border rounded text-xs"
                                        onClick={() =>
                                          setInventoryNotes(prev => {
                                            const next = [...(prev[key] ?? [])];
                                            next.splice(idx, 1);
                                            return { ...prev, [key]: next };
                                          })
                                        }
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                          <button
                            className="px-2 py-1 border rounded text-xs"
                            onClick={() =>
                              setInventoryNotes(prev => {
                                const next = [...(prev[key] ?? [])];
                                next.push({ id: `note_${Date.now()}_${Math.random()}`, label: "", note: "", expiresAt: "" });
                                return { ...prev, [key]: next };
                              })
                            }
                          >
                            Add note
                          </button>
                        </div>
                        <button
                          className="px-3 py-2 border rounded text-xs"
                          onClick={() => saveInventoryNote(it.stockId, it.vin)}
                          disabled={!key || inventorySaving === key}
                        >
                          {inventorySaving === key ? "Saving..." : "Save note"}
                        </button>
                      </div>
                    );
                  })}
              </div>
              </>
            )}
          </div>
        ) : section === "settings" ? (
          <div className="max-w-3xl space-y-6">
            {settingsError ? (
              <div className="text-sm text-red-600">{settingsError}</div>
            ) : null}
            {settingsTab === "dealer" ? (
              <div className="border rounded-lg p-4 space-y-6">
                <div className="text-lg font-semibold">Dealer Profile</div>
                <div
                  id="rider-to-rider-financing-toggle"
                  className="border border-slate-300 rounded-lg p-3 bg-white text-slate-900 space-y-2"
                >
                  <div className="text-sm font-semibold">Lead Source Policy</div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!dealerProfileForm.riderToRiderFinancingEnabled}
                      onChange={e =>
                        setDealerProfileForm({
                          ...dealerProfileForm,
                          riderToRiderFinancingEnabled: e.target.checked
                        })
                      }
                    />
                    Dealer offers Marketplace Rider-to-Rider financing
                  </label>
                  <div className="text-xs text-slate-600">
                    Controls replies for &quot;Marketplace - Rider to Rider Finance Inquiry&quot; and regenerate behavior.
                  </div>
                </div>
                <div className="border rounded-lg p-3 space-y-3">
                  <div className="text-sm font-semibold">Basic Information</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Dealer name</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.dealerName}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, dealerName: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Default agent name</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.agentName}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, agentName: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">CRM provider (optional)</div>
                      <select
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.crmProvider}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, crmProvider: e.target.value })}
                      >
                        <option value="">Select CRM provider</option>
                        <option value="tlp">TLP</option>
                        <option value="vin">VIN</option>
                        <option value="elead">eLead</option>
                        <option value="dealersocket">DealerSocket</option>
                        <option value="adf">Generic ADF</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Website provider (optional)</div>
                      <select
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.websiteProvider}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, websiteProvider: e.target.value })}
                      >
                        <option value="">Select website provider</option>
                        <option value="dx1">DX1</option>
                        <option value="foxdealer">Fox Dealer</option>
                        <option value="room58">Room 58</option>
                        <option value="dealerspike">Dealer Spike</option>
                        <option value="dealereprocess">Dealer eProcess</option>
                        <option value="motive">Motive</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Primary phone</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.phone}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, phone: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Website URL</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.website}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, website: e.target.value })}
                      />
                    </label>
                  </div>
                </div>

                <div className="border rounded-lg p-3 space-y-3">
                  <div className="text-sm font-semibold">Search & Links</div>
                  <div className="space-y-2">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="text-xs text-gray-600">Google place photos for campaigns</div>
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={dealerProfileForm.webSearchUseGooglePlacePhotos}
                            onChange={e =>
                              setDealerProfileForm({
                                ...dealerProfileForm,
                                webSearchUseGooglePlacePhotos: e.target.checked
                              })
                            }
                          />
                          <span>Use Google Business Profile photos as campaign inspiration</span>
                        </label>
                      </div>
                      <label className="space-y-1">
                        <div className="text-xs text-gray-600">Google place ID (optional)</div>
                        <input
                          className="border rounded px-3 py-2 text-sm w-full"
                          placeholder="ex: ChIJN1t_tDeuEmsRUsoyG83frY4"
                          value={dealerProfileForm.webSearchGooglePlaceId}
                          onChange={e =>
                            setDealerProfileForm({
                              ...dealerProfileForm,
                              webSearchGooglePlaceId: e.target.value
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="text-xs text-gray-600">
                      Web search reference pages/domains (manufacturer + help docs)
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className="border rounded px-3 py-2 text-sm flex-1 min-w-[220px]"
                        value={selectedReferenceSite}
                        onChange={e => setSelectedReferenceSite(e.target.value)}
                      >
                        <option value="">Choose a common manufacturer/reference site</option>
                        {COMMON_REFERENCE_SITES.map(site => (
                          <option key={site.value} value={site.value}>
                            {site.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="px-2 py-1 border rounded text-xs disabled:opacity-50"
                        disabled={!selectedReferenceSite}
                        onClick={() => {
                          const selected = String(selectedReferenceSite ?? "").trim();
                          if (!selected) return;
                          setDealerProfileForm(prev => {
                            const existing = (prev.webSearchReferenceUrls ?? []).map(v =>
                              String(v ?? "").trim().toLowerCase()
                            );
                            if (existing.includes(selected.toLowerCase())) return prev;
                            return {
                              ...prev,
                              webSearchReferenceUrls: [...(prev.webSearchReferenceUrls ?? []), selected]
                            };
                          });
                          setSelectedReferenceSite("");
                        }}
                      >
                        Add common site
                      </button>
                      <button
                        type="button"
                        className="px-2 py-1 border rounded text-xs"
                        onClick={() =>
                          setDealerProfileForm(prev => ({
                            ...prev,
                            webSearchReferenceUrls: [...(prev.webSearchReferenceUrls ?? []), ""]
                          }))
                        }
                      >
                        Add custom URL
                      </button>
                    </div>
                    {(dealerProfileForm.webSearchReferenceUrls ?? []).length === 0 ? (
                      <div className="text-xs text-gray-500">
                        Add one or more URLs/domains (example: `https://www.harley-davidson.com` or
                        `triumphmotorcycles.com`).
                      </div>
                    ) : null}
                    {(dealerProfileForm.webSearchReferenceUrls ?? []).map((url, idx) => (
                      <div key={`web-ref-${idx}`} className="flex items-center gap-2">
                        <input
                          className="border rounded px-3 py-2 text-sm flex-1"
                          value={url}
                          onChange={e =>
                            setDealerProfileForm(prev => {
                              const next = [...(prev.webSearchReferenceUrls ?? [])];
                              next[idx] = e.target.value;
                              return { ...prev, webSearchReferenceUrls: next };
                            })
                          }
                        />
                        <button
                          type="button"
                          className="px-2 py-1 border rounded text-xs"
                          onClick={() =>
                            setDealerProfileForm(prev => ({
                              ...prev,
                              webSearchReferenceUrls: (prev.webSearchReferenceUrls ?? []).filter(
                                (_v, i) => i !== idx
                              )
                            }))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Web banner width (px)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        type="number"
                        min={1}
                        placeholder="2400"
                        value={dealerProfileForm.campaignWebBannerWidth}
                        onChange={e =>
                          setDealerProfileForm({ ...dealerProfileForm, campaignWebBannerWidth: e.target.value })
                        }
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Web banner height (px)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        type="number"
                        min={1}
                        placeholder="1079"
                        value={dealerProfileForm.campaignWebBannerHeight}
                        onChange={e =>
                          setDealerProfileForm({ ...dealerProfileForm, campaignWebBannerHeight: e.target.value })
                        }
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Web banner zoom-out inset (%)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        type="number"
                        min={0}
                        max={25}
                        step={0.5}
                        placeholder="0"
                        value={dealerProfileForm.campaignWebBannerInsetPercent}
                        onChange={e =>
                          setDealerProfileForm({
                            ...dealerProfileForm,
                            campaignWebBannerInsetPercent: e.target.value
                          })
                        }
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Web banner fit</div>
                      <select
                        className="border rounded px-3 py-2 text-sm w-full bg-white"
                        value={dealerProfileForm.campaignWebBannerFit}
                        onChange={e =>
                          setDealerProfileForm({
                            ...dealerProfileForm,
                            campaignWebBannerFit:
                              e.target.value === "contain" || e.target.value === "cover"
                                ? e.target.value
                                : "auto"
                          })
                        }
                      >
                        <option value="auto">Auto (recommended)</option>
                        <option value="cover">Cover (full-bleed)</option>
                        <option value="contain">Contain (no crop)</option>
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Booking token (public)</div>
                      <div className="flex items-center gap-2">
                        <input
                          className="border rounded px-3 py-2 text-sm flex-1"
                          value={dealerProfileForm.bookingToken}
                          onChange={e => setDealerProfileForm({ ...dealerProfileForm, bookingToken: e.target.value })}
                        />
                        <button
                          className="px-3 py-2 border rounded text-sm"
                          type="button"
                          onClick={() => {
                            const token =
                              (typeof window !== "undefined" && window.crypto?.randomUUID?.()) ||
                              Math.random().toString(36).slice(2);
                            setDealerProfileForm(prev => ({ ...prev, bookingToken: token }));
                          }}
                        >
                          Generate
                        </button>
                      </div>
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Booking link (email follow-ups)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.bookingUrl}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, bookingUrl: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1 md:col-span-2">
                      <div className="text-xs text-gray-600">Credit app URL (financing)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.creditAppUrl}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, creditAppUrl: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1 md:col-span-2">
                      <div className="text-xs text-gray-600">
                        Lien holder / payoff response (used when customer asks for lien holder details)
                      </div>
                      <textarea
                        className="border rounded px-3 py-2 text-sm w-full min-h-[80px]"
                        value={dealerProfileForm.lienHolderResponse}
                        onChange={e =>
                          setDealerProfileForm({ ...dealerProfileForm, lienHolderResponse: e.target.value })
                        }
                      />
                    </label>
                  </div>
                </div>

                <div className="border rounded-lg p-3 space-y-3">
                  <div className="text-sm font-semibold">Email & Branding</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">From email (outbound)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.fromEmail}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, fromEmail: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Reply-to email (optional)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.replyToEmail}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, replyToEmail: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1 md:col-span-2">
                      <div className="text-xs text-gray-600">Email signature (optional)</div>
                      <textarea
                        className="border rounded px-3 py-2 text-sm w-full min-h-[90px]"
                        value={dealerProfileForm.emailSignature}
                        onChange={e =>
                          setDealerProfileForm({ ...dealerProfileForm, emailSignature: e.target.value })
                        }
                      />
                    </label>
                    <div className="md:col-span-2 border rounded p-3">
                      <div className="text-xs text-gray-600 mb-2">Logo (email signature)</div>
                      {dealerProfileForm.logoUrl ? (
                        <div className="flex items-center gap-3 mb-2">
                          <img
                            src={dealerProfileForm.logoUrl}
                            alt="Dealer logo"
                            className="h-12 object-contain border rounded bg-white"
                          />
                          <button
                            className="px-2 py-1 border rounded text-xs"
                            onClick={() => setDealerProfileForm({ ...dealerProfileForm, logoUrl: "" })}
                          >
                            Remove
                          </button>
                        </div>
                      ) : null}
                      <label className="inline-flex items-center gap-2 px-3 py-2 border rounded text-sm cursor-pointer hover:bg-gray-50">
                        <span>Upload logo</span>
                        <input
                          className="hidden"
                          type="file"
                          accept="image/*"
                          onChange={async e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const fd = new FormData();
                            fd.append("file", file);
                            const resp = await fetch("/api/dealer-profile/logo", {
                              method: "POST",
                              body: fd
                            });
                            const payload = await resp.json().catch(() => null);
                            if (resp.ok && payload?.profile) {
                              setDealerProfileForm(prev => ({
                                ...prev,
                                logoUrl: payload.profile.logoUrl ?? payload.url ?? ""
                              }));
                            }
                          }}
                        />
                      </label>
                    </div>
                  </div>
                </div>

                <div className="border rounded-lg p-3 space-y-3">
                  <div className="text-sm font-semibold">Address</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="space-y-1 md:col-span-2">
                      <div className="text-xs text-gray-600">Address line 1</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.addressLine1}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, addressLine1: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">City</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.city}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, city: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">State</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.state}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, state: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Zip</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={dealerProfileForm.zip}
                        onChange={e => setDealerProfileForm({ ...dealerProfileForm, zip: e.target.value })}
                      />
                    </label>
                  </div>
                </div>

                <div className="border rounded-lg p-3 space-y-4">
                  <div className="text-sm font-semibold">Operations</div>
                  <div>
                    <div className="text-sm font-medium mb-2">Business hours</div>
                    <div className="grid grid-cols-3 gap-2 text-xs font-medium text-gray-600 px-1 mb-1">
                      <div>Day</div>
                      <div>Open</div>
                      <div>Close</div>
                    </div>
                    <div className="space-y-2">
                      {days.map(day => {
                        const current = dealerHours?.[day] ?? { open: null, close: null };
                        return (
                          <div key={day} className="grid grid-cols-3 gap-2 items-center text-sm">
                            <div className="capitalize">{day}</div>
                            <select
                              className="border rounded px-2 py-1 text-sm"
                              value={current.open ?? ""}
                              onChange={e => updateHours(setDealerHours, day, "open", e.target.value)}
                            >
                              <option value="">Closed</option>
                              {timeOptions.map(t => (
                                <option key={`open-${day}-${t}`} value={t}>
                                  {formatTimeLabel(t, schedulerForm.timezone)}
                                </option>
                              ))}
                            </select>
                            <select
                              className="border rounded px-2 py-1 text-sm"
                              value={current.close ?? ""}
                              onChange={e => updateHours(setDealerHours, day, "close", e.target.value)}
                            >
                              <option value="">Closed</option>
                              {timeOptions.map(t => (
                                <option key={`close-${day}-${t}`} value={t}>
                                  {formatTimeLabel(t, schedulerForm.timezone)}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-medium mb-2">Follow-up: Test Ride</div>
                    <label className="flex items-center gap-2 text-sm mb-3">
                      <input
                        type="checkbox"
                        checked={!!dealerProfileForm.testRideEnabled}
                        onChange={e =>
                          setDealerProfileForm({ ...dealerProfileForm, testRideEnabled: e.target.checked })
                        }
                      />
                      Enable test ride follow-ups
                    </label>
                    <div className="text-xs text-gray-500 mb-2">Months to offer test rides</div>
                    <div className="grid grid-cols-4 md:grid-cols-6 gap-2 text-sm">
                      {followUpMonths.map(m => {
                        const checked = (dealerProfileForm.testRideMonths ?? []).includes(m.value);
                        return (
                          <label key={`month-${m.value}`} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!dealerProfileForm.testRideEnabled}
                              onChange={e => {
                                const next = new Set(dealerProfileForm.testRideMonths ?? []);
                                if (e.target.checked) next.add(m.value);
                                else next.delete(m.value);
                                setDealerProfileForm({
                                  ...dealerProfileForm,
                                  testRideMonths: Array.from(next).sort((a, b) => a - b)
                                });
                              }}
                            />
                            {m.label}
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-medium mb-2">Weather & Pickup</div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                      <label className="space-y-1">
                        <div className="text-xs text-gray-600">Pickup radius (miles)</div>
                        <input
                          className="border rounded px-3 py-2 text-sm w-full"
                          value={dealerProfileForm.weatherPickupRadiusMiles}
                          onChange={e =>
                            setDealerProfileForm({ ...dealerProfileForm, weatherPickupRadiusMiles: e.target.value })
                          }
                        />
                      </label>
                      <label className="space-y-1">
                        <div className="text-xs text-gray-600">Cold threshold (°F)</div>
                        <input
                          className="border rounded px-3 py-2 text-sm w-full"
                          value={dealerProfileForm.weatherColdThresholdF}
                          onChange={e =>
                            setDealerProfileForm({ ...dealerProfileForm, weatherColdThresholdF: e.target.value })
                          }
                        />
                      </label>
                      <label className="space-y-1">
                        <div className="text-xs text-gray-600">Forecast window (hours)</div>
                        <input
                          className="border rounded px-3 py-2 text-sm w-full"
                          value={dealerProfileForm.weatherForecastHours}
                          onChange={e =>
                            setDealerProfileForm({ ...dealerProfileForm, weatherForecastHours: e.target.value })
                          }
                        />
                      </label>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Used to decide when to offer pickup or delay test rides (snow or &lt; threshold).
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-medium mb-2">Pricing Defaults</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                      <label className="space-y-1">
                        <div className="text-xs text-gray-600">Default tax rate (%)</div>
                        <input
                          className="border rounded px-3 py-2 text-sm w-full"
                          value={dealerProfileForm.taxRate}
                          onChange={e =>
                            setDealerProfileForm({ ...dealerProfileForm, taxRate: e.target.value })
                          }
                        />
                      </label>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Used for ballpark payment estimates when county tax is unknown.
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-medium mb-2">Buying Used Bikes</div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!dealerProfileForm.buyingUsedBikesEnabled}
                        onChange={e =>
                          setDealerProfileForm({ ...dealerProfileForm, buyingUsedBikesEnabled: e.target.checked })
                        }
                      />
                      Currently buying used bikes (Sell Your Bike leads)
                    </label>
                  </div>
                </div>
                <div>
                  <button
                    className="px-3 py-2 border rounded text-sm"
                    onClick={saveDealerProfile}
                    disabled={settingsSaving}
                  >
                    {settingsSaving ? "Saving…" : "Save Dealer Profile"}
                  </button>
                </div>
              </div>
            ) : settingsTab === "users" ? (
              <div className="border rounded-lg p-4 space-y-6">
                <div className="text-lg font-semibold">Users</div>
                <div className="space-y-3">
                  {usersList.map(user => (
                    <div key={user.id} className="border rounded-lg p-3 flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">
                          {[user.firstName, user.lastName].filter(Boolean).join(" ") ||
                            user.name ||
                            user.email ||
                            "Unnamed"}
                        </div>
                                <div className="text-xs text-gray-600">
                                  {user.email || "No email"} • {user.role}
                                  {user.phone ? ` • ${user.phone}` : ""}
                                  {user.extension ? ` • ext ${user.extension}` : ""}
                                </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          className="px-2 py-1 border rounded text-xs"
                          onClick={() => setEditingUserId(user.id)}
                        >
                          Edit
                        </button>
                        <button
                          className="px-2 py-1 border rounded text-xs text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => deleteUserRow(user.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  className="px-3 py-2 border rounded text-sm"
                  onClick={() => {
                    setShowNewUserForm(true);
                    setEditingUserId(null);
                  }}
                >
                  Add user
                </button>

                {editingUserId || showNewUserForm ? (
                  <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/30 p-3 sm:p-4 overflow-y-auto">
                    <div className="bg-white lr-light-modal w-full max-w-2xl rounded-lg shadow-lg border p-4 space-y-4 max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
                      <div className="flex items-center justify-between">
                        <div className="text-lg font-semibold">
                          {editingUserId ? "Edit user" : "Add user"}
                        </div>
                        <button
                          className="text-sm px-2 py-1 border rounded"
                          onClick={() => {
                            setEditingUserId(null);
                            setShowNewUserForm(false);
                          }}
                        >
                          Close
                        </button>
                      </div>

                      {editingUserId
                        ? usersList
                            .filter(u => u.id === editingUserId)
                            .map(user => (
                              <div key={user.id} className="space-y-2">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div className="md:col-span-2 text-sm font-medium">Basic Info</div>
                                  <label className="space-y-1">
                                    <div className="text-xs text-gray-600">First name</div>
                                    <input
                                      className="border rounded px-2 py-1 text-sm w-full"
                                      value={user.firstName ?? ""}
                                      onChange={e =>
                                        setUsersList(prev =>
                                          prev.map(u =>
                                            u.id === user.id ? { ...u, firstName: e.target.value } : u
                                          )
                                        )
                                      }
                                    />
                                  </label>
                                  <label className="space-y-1">
                                    <div className="text-xs text-gray-600">Last name</div>
                                    <input
                                      className="border rounded px-2 py-1 text-sm w-full"
                                      value={user.lastName ?? ""}
                                      onChange={e =>
                                        setUsersList(prev =>
                                          prev.map(u =>
                                            u.id === user.id ? { ...u, lastName: e.target.value } : u
                                          )
                                        )
                                      }
                                    />
                                  </label>
                                  <label className="space-y-1">
                                    <div className="text-xs text-gray-600">Email</div>
                                    <input
                                      className="border rounded px-2 py-1 text-sm w-full"
                                      value={user.email ?? ""}
                                      onChange={e =>
                                        setUsersList(prev =>
                                          prev.map(u => (u.id === user.id ? { ...u, email: e.target.value } : u))
                                        )
                                      }
                                    />
                                  </label>
                                  <label className="space-y-1">
                                    <div className="text-xs text-gray-600">Role</div>
                                    <select
                                      className="border rounded px-2 py-1 text-sm w-full"
                                      value={user.role ?? "salesperson"}
                                      onChange={e =>
                                        setUsersList(prev =>
                                          prev.map(u => (u.id === user.id ? { ...u, role: e.target.value } : u))
                                        )
                                      }
                                    >
                                      <option value="salesperson">Salesperson</option>
                                      <option value="manager">Manager</option>
                                      <option value="service">Service</option>
                                      <option value="parts">Parts</option>
                                      <option value="apparel">Apparel</option>
                                    </select>
                                  </label>
                                  {user.role === "manager" ? (
                                    <label className="md:col-span-2 flex items-center gap-2 text-xs">
                                      <input
                                        type="checkbox"
                                        checked={!!user.includeInSchedule}
                                        onChange={e =>
                                          setUsersList(prev =>
                                            prev.map(u =>
                                              u.id === user.id ? { ...u, includeInSchedule: e.target.checked } : u
                                            )
                                          )
                                        }
                                      />
                                      Include on schedule (show in booking dropdowns)
                                    </label>
                                  ) : null}
                                  <div className="md:col-span-2 border-t pt-2 text-sm font-medium">
                                    Contact & Scheduling
                                  </div>
                                  <label className="space-y-1">
                                    <div className="text-xs text-gray-600">Calendar ID</div>
                                    <input
                                      className="border rounded px-2 py-1 text-sm w-full"
                                      value={user.calendarId ?? ""}
                                      onChange={e =>
                                        setUsersList(prev =>
                                          prev.map(u => (u.id === user.id ? { ...u, calendarId: e.target.value } : u))
                                        )
                                      }
                                    />
                                  </label>
                                  <div className="md:col-span-2 text-xs text-gray-500 -mt-1">
                                    Calendar ID is required to show on the schedule.
                                  </div>
                                  <div>
                                    <div className="text-xs text-gray-500 mb-1">Phone (for calls)</div>
                                    <input
                                      className="border rounded px-2 py-1 text-sm w-full"
                                      placeholder="Phone (for calls)"
                                      value={user.phone ?? ""}
                                      onChange={e =>
                                        setUsersList(prev =>
                                          prev.map(u => (u.id === user.id ? { ...u, phone: e.target.value } : u))
                                        )
                                      }
                                    />
                                  </div>
                                  <div className="md:col-span-2 border-t pt-2 text-sm font-medium">
                                    Email Signature
                                  </div>
                                  <label className="md:col-span-2 space-y-1">
                                    <div className="text-xs text-gray-600">
                                      Salesperson email signature (used for manual emails)
                                    </div>
                                    <textarea
                                      className="border rounded px-2 py-1 text-sm w-full h-24"
                                      value={String(user.emailSignature ?? "")}
                                      onChange={e =>
                                        setUsersList(prev =>
                                          prev.map(u =>
                                            u.id === user.id ? { ...u, emailSignature: e.target.value } : u
                                          )
                                        )
                                      }
                                    />
                                  </label>
                                  <div>
                                    <div className="text-xs text-gray-500 mb-1">Extension / dial digits</div>
                                    <input
                                      className="border rounded px-2 py-1 text-sm w-full"
                                      placeholder="Extension / dial digits"
                                      value={user.extension ?? ""}
                                      onChange={e =>
                                        setUsersList(prev =>
                                          prev.map(u => (u.id === user.id ? { ...u, extension: e.target.value } : u))
                                        )
                                      }
                                    />
                                  </div>
                                  <div className="md:col-span-2 border-t pt-2 text-sm font-medium">Security</div>
                                  <label className="md:col-span-2 space-y-1">
                                    <div className="text-xs text-gray-600">Set new password</div>
                                    <input
                                      className="border rounded px-2 py-1 text-sm w-full"
                                      type="password"
                                      value={userPasswords[user.id] ?? ""}
                                      onChange={e =>
                                        setUserPasswords(prev => ({
                                          ...prev,
                                          [user.id]: e.target.value
                                        }))
                                      }
                                    />
                                  </label>
                                  <div className="md:col-span-2 border-t pt-2 text-sm font-medium">Permissions</div>
                                  <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!!user.permissions?.canEditAppointments}
                                        onChange={e =>
                                          setUsersList(prev =>
                                            prev.map(u =>
                                              u.id === user.id
                                                ? {
                                                    ...u,
                                                    permissions: {
                                                      ...(u.permissions ?? {}),
                                                      canEditAppointments: e.target.checked
                                                    }
                                                  }
                                                : u
                                            )
                                          )
                                        }
                                      />
                                      Edit appointments
                                    </label>
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!!user.permissions?.canToggleHumanOverride}
                                        onChange={e =>
                                          setUsersList(prev =>
                                            prev.map(u =>
                                              u.id === user.id
                                                ? {
                                                    ...u,
                                                    permissions: {
                                                      ...(u.permissions ?? {}),
                                                      canToggleHumanOverride: e.target.checked
                                                    }
                                                  }
                                                : u
                                            )
                                          )
                                        }
                                      />
                                      Human override
                                    </label>
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!!user.permissions?.canAccessTodos}
                                        onChange={e =>
                                          setUsersList(prev =>
                                            prev.map(u =>
                                              u.id === user.id
                                                ? {
                                                    ...u,
                                                    permissions: {
                                                      ...(u.permissions ?? {}),
                                                      canAccessTodos: e.target.checked
                                                    }
                                                  }
                                                : u
                                            )
                                          )
                                        }
                                      />
                                      To‑Do inbox
                                    </label>
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!!user.permissions?.canAccessSuppressions}
                                        onChange={e =>
                                          setUsersList(prev =>
                                            prev.map(u =>
                                              u.id === user.id
                                                ? {
                                                    ...u,
                                                    permissions: {
                                                      ...(u.permissions ?? {}),
                                                      canAccessSuppressions: e.target.checked
                                                    }
                                                  }
                                                : u
                                            )
                                          )
                                        }
                                      />
                                      Suppression list
                                    </label>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    className="px-3 py-2 border rounded text-sm"
                                    onClick={() => {
                                      const password = userPasswords[user.id];
                                      const fullName = [user.firstName, user.lastName]
                                        .filter(Boolean)
                                        .join(" ")
                                        .trim();
                                      updateUserRow(user.id, {
                                        email: user.email,
                                        name: fullName || user.name,
                                        firstName: user.firstName,
                                        lastName: user.lastName,
                                        emailSignature: user.emailSignature,
                                        role: user.role,
                                        includeInSchedule: user.includeInSchedule,
                                        calendarId: user.calendarId,
                                        phone: user.phone,
                                        extension: user.extension,
                                        permissions: user.permissions,
                                        ...(password ? { password } : {})
                                      });
                                      if (password) {
                                        setUserPasswords(prev => ({ ...prev, [user.id]: "" }));
                                      }
                                    }}
                                  >
                                    Save
                                  </button>
                                  {(user.role === "salesperson" || user.role === "manager") ? (
                                    <button
                                      className="px-3 py-2 border rounded text-sm"
                                      disabled={
                                        creatingCalendar ||
                                        !(
                                          [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
                                          user.name ||
                                          user.email
                                        )
                                      }
                                      onClick={async () => {
                                        const name = String(
                                          [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
                                            user.name ||
                                            user.email ||
                                            ""
                                        ).trim();
                                        if (!name) return;
                                        setCreatingCalendar(true);
                                        try {
                                          const resp = await fetch("/api/calendar/create", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ name })
                                          });
                                          const json = await resp.json();
                                          if (!resp.ok) throw new Error(json?.error ?? "Failed to create calendar");
                                          const id = json?.calendar?.id ?? "";
                                          await updateUserRow(user.id, { calendarId: id });
                                        } catch (err: any) {
                                          setSettingsError(err?.message ?? "Failed to create calendar");
                                        } finally {
                                          setCreatingCalendar(false);
                                        }
                                      }}
                                    >
                                      {creatingCalendar ? "Creating…" : "Create calendar"}
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            ))
                        : (
                          <div className="space-y-3">
                            <div className="text-xs text-gray-500">
                              Save the user to set availability blocks.
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div className="md:col-span-2 text-sm font-medium">Basic Info</div>
                              <label className="space-y-1">
                                <div className="text-xs text-gray-600">First name</div>
                                <input
                                  className="border rounded px-3 py-2 text-sm w-full"
                                  value={userForm.firstName}
                                  onChange={e => setUserForm({ ...userForm, firstName: e.target.value })}
                                />
                              </label>
                              <label className="space-y-1">
                                <div className="text-xs text-gray-600">Last name</div>
                                <input
                                  className="border rounded px-3 py-2 text-sm w-full"
                                  value={userForm.lastName}
                                  onChange={e => setUserForm({ ...userForm, lastName: e.target.value })}
                                />
                              </label>
                              <label className="space-y-1">
                                <div className="text-xs text-gray-600">Email</div>
                                <input
                                  className="border rounded px-3 py-2 text-sm w-full"
                                  value={userForm.email}
                                  onChange={e => setUserForm({ ...userForm, email: e.target.value })}
                                />
                              </label>
                              <label className="space-y-1">
                                <div className="text-xs text-gray-600">Role</div>
                                <select
                                  className="border rounded px-3 py-2 text-sm w-full"
                                  value={userForm.role}
                                  onChange={e => setUserForm({ ...userForm, role: e.target.value })}
                                >
                                  <option value="salesperson">Salesperson</option>
                                  <option value="manager">Manager</option>
                                  <option value="service">Service</option>
                                  <option value="parts">Parts</option>
                                  <option value="apparel">Apparel</option>
                                </select>
                              </label>
                              {userForm.role === "manager" ? (
                                <label className="md:col-span-2 flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={!!userForm.includeInSchedule}
                                    onChange={e =>
                                      setUserForm({ ...userForm, includeInSchedule: e.target.checked })
                                    }
                                  />
                                  Include on schedule (show in booking dropdowns)
                                </label>
                              ) : null}

                              <div className="md:col-span-2 border-t pt-2 text-sm font-medium">
                                Contact & Scheduling
                              </div>
                              <label className="space-y-1">
                                <div className="text-xs text-gray-600">Phone (for calls)</div>
                                <input
                                  className="border rounded px-3 py-2 text-sm w-full"
                                  value={String((userForm as any).phone ?? "")}
                                  onChange={e => setUserForm({ ...userForm, phone: e.target.value })}
                                />
                              </label>
                              <label className="space-y-1">
                                <div className="text-xs text-gray-600">Extension / dial digits</div>
                                <input
                                  className="border rounded px-3 py-2 text-sm w-full"
                                  value={String((userForm as any).extension ?? "")}
                                  onChange={e => setUserForm({ ...userForm, extension: e.target.value })}
                                />
                              </label>
                              <div className="md:col-span-2 flex gap-2">
                                <div className="flex-1 space-y-1">
                                  <div className="text-xs text-gray-600">Calendar ID</div>
                                  <input
                                    className="border rounded px-3 py-2 text-sm w-full"
                                    value={userForm.calendarId}
                                    onChange={e => setUserForm({ ...userForm, calendarId: e.target.value })}
                                  />
                                </div>
                                <button
                                  className="px-3 py-2 border rounded text-sm self-end"
                                  disabled={
                                    creatingCalendar ||
                                    !(
                                      [userForm.firstName, userForm.lastName].filter(Boolean).join(" ").trim() ||
                                      userForm.name.trim() ||
                                      userForm.email.trim()
                                    )
                                  }
                                  onClick={async () => {
                                    const name = String(
                                      [userForm.firstName, userForm.lastName].filter(Boolean).join(" ").trim() ||
                                        userForm.name ||
                                        userForm.email ||
                                        ""
                                    ).trim();
                                    if (!name) return;
                                    setCreatingCalendar(true);
                                    try {
                                      const resp = await fetch("/api/calendar/create", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ name })
                                      });
                                      const json = await resp.json();
                                      if (!resp.ok) throw new Error(json?.error ?? "Failed to create calendar");
                                      const id = json?.calendar?.id ?? "";
                                      setUserForm(prev => ({ ...prev, calendarId: id }));
                                    } catch (err: any) {
                                      setSettingsError(err?.message ?? "Failed to create calendar");
                                    } finally {
                                      setCreatingCalendar(false);
                                    }
                                  }}
                                >
                                  {creatingCalendar ? "Creating…" : "Create calendar"}
                                </button>
                              </div>

                              <div className="md:col-span-2 border-t pt-2 text-sm font-medium">Email Signature</div>
                              <label className="md:col-span-2 space-y-1">
                                <div className="text-xs text-gray-600">
                                  Salesperson email signature (used for manual emails)
                                </div>
                                <textarea
                                  className="border rounded px-3 py-2 text-sm w-full h-24"
                                  value={userForm.emailSignature}
                                  onChange={e => setUserForm({ ...userForm, emailSignature: e.target.value })}
                                />
                              </label>

                              <div className="md:col-span-2 border-t pt-2 text-sm font-medium">Security</div>
                              <label className="md:col-span-2 space-y-1">
                                <div className="text-xs text-gray-600">Password</div>
                                <input
                                  className="border rounded px-3 py-2 text-sm w-full"
                                  type="password"
                                  value={userForm.password}
                                  onChange={e => setUserForm({ ...userForm, password: e.target.value })}
                                />
                              </label>

                              <div className="md:col-span-2 border-t pt-2 text-sm font-medium">Permissions</div>
                              <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                                <label className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={!!userForm.permissions?.canEditAppointments}
                                    onChange={e =>
                                      setUserForm({
                                        ...userForm,
                                        permissions: { ...userForm.permissions, canEditAppointments: e.target.checked }
                                      })
                                    }
                                  />
                                  Edit appointments
                                </label>
                                <label className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={!!userForm.permissions?.canToggleHumanOverride}
                                    onChange={e =>
                                      setUserForm({
                                        ...userForm,
                                        permissions: { ...userForm.permissions, canToggleHumanOverride: e.target.checked }
                                      })
                                    }
                                  />
                                  Human override
                                </label>
                                <label className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={!!userForm.permissions?.canAccessTodos}
                                    onChange={e =>
                                      setUserForm({
                                        ...userForm,
                                        permissions: { ...userForm.permissions, canAccessTodos: e.target.checked }
                                      })
                                    }
                                  />
                                  To‑Do inbox
                                </label>
                                <label className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={!!userForm.permissions?.canAccessSuppressions}
                                    onChange={e =>
                                      setUserForm({
                                        ...userForm,
                                        permissions: { ...userForm.permissions, canAccessSuppressions: e.target.checked }
                                      })
                                    }
                                  />
                                  Suppression list
                                </label>
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button className="px-3 py-2 border rounded text-sm" onClick={addUser}>
                                Save user
                              </button>
                              <button
                                className="px-3 py-2 border rounded text-sm"
                                onClick={() => setShowNewUserForm(false)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                      {editingUserId ? (
                        <div className="border-t pt-4">
                          <div className="text-sm font-medium mb-2">Availability blocks</div>
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                              <select
                                className="border rounded px-2 py-1 text-sm"
                                value={blockForm.salespersonId}
                                onChange={e => setBlockForm({ ...blockForm, salespersonId: e.target.value })}
                              >
                                <option value="">Select salesperson</option>
                                {usersList
                                  .filter(
                                    u => u.role === "salesperson" || (u.role === "manager" && u.includeInSchedule)
                                  )
                                  .map(sp => (
                                    <option key={sp.id} value={sp.id}>
                                      {sp.name || sp.email || sp.id}
                                    </option>
                                  ))}
                              </select>
                              <input
                                className="border rounded px-2 py-1 text-sm"
                                placeholder="Block title (e.g., Lunch)"
                                value={blockForm.title}
                                onChange={e => setBlockForm({ ...blockForm, title: e.target.value })}
                              />
                            </div>
                            <div className="flex flex-wrap gap-2 text-xs">
                              {days.map(day => {
                                const active = blockForm.days.includes(day);
                                return (
                                  <button
                                    key={day}
                                    className={`px-2 py-1 border rounded ${active ? "bg-gray-100" : ""}`}
                                    onClick={() => toggleBlockDay(day)}
                                  >
                                    {day.slice(0, 3).toUpperCase()}
                                  </button>
                                );
                              })}
                            </div>
                            <div className="flex items-center gap-2 text-sm">
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={blockForm.allDay}
                                  onChange={e => setBlockForm({ ...blockForm, allDay: e.target.checked })}
                                />
                                All day
                              </label>
                              <select
                                className="border rounded px-2 py-1 text-sm"
                                value={blockForm.start}
                                disabled={blockForm.allDay}
                                onChange={e => setBlockForm({ ...blockForm, start: e.target.value })}
                              >
                                {timeOptions.map(t => (
                                  <option key={`block-start-${t}`} value={t}>
                                    {formatTimeLabel(t, schedulerForm.timezone)}
                                  </option>
                                ))}
                              </select>
                              <span className="text-xs text-gray-500">to</span>
                              <select
                                className="border rounded px-2 py-1 text-sm"
                                value={blockForm.end}
                                disabled={blockForm.allDay}
                                onChange={e => setBlockForm({ ...blockForm, end: e.target.value })}
                              >
                                {timeOptions.map(t => (
                                  <option key={`block-end-${t}`} value={t}>
                                    {formatTimeLabel(t, schedulerForm.timezone)}
                                  </option>
                                ))}
                              </select>
                              <button className="px-3 py-2 border rounded text-sm" onClick={addAvailabilityBlock}>
                                Add block
                              </button>
                            </div>
                            {blockForm.salespersonId ? (
                              <div className="space-y-2">
                                {(availabilityBlocks[blockForm.salespersonId] ?? []).map(block => (
                                  <div
                                    key={block.id}
                                    className="flex items-center justify-between border rounded px-2 py-1 text-xs"
                                  >
                                    <div className="flex flex-col">
                                      <span className="font-medium">{block.title}</span>
                                      <span className="text-gray-500">
                                        {(block.days ?? [])
                                          .map((d: string) => d.slice(0, 3).toUpperCase())
                                          .join(", ")}
                                        {block.start && block.end ? ` • ${block.start}-${block.end}` : ""}
                                      </span>
                                    </div>
                                    <button
                                      className="px-2 py-1 border rounded text-xs text-red-600"
                                      onClick={() => deleteAvailabilityBlock(blockForm.salespersonId, block.id)}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : settingsTab === "notifications" ? (
              <div className="border rounded-lg p-4 space-y-4">
                <div className="text-lg font-semibold">Notifications</div>
                <div className="border rounded p-3 text-sm">
                  <div className="font-medium">Google Calendar</div>
                  <div className="text-xs text-gray-600 mt-1">
                    {googleStatus
                      ? googleStatus.connected
                        ? "Connected"
                        : `Disconnected${googleStatus.reason ? ` • ${googleStatus.reason}` : ""}${
                            googleStatus.error ? ` • ${googleStatus.error}` : ""
                          }`
                      : "Status unavailable"}
                  </div>
                </div>
                <div className="border rounded p-3 text-sm">
                  <div className="font-medium">CRM Updates</div>
                  {crmAlerts.length ? (
                    <div className="mt-2 space-y-2">
                      {crmAlerts.slice(0, 5).map(alert => (
                        <div key={alert.id} className="text-xs text-gray-600">
                          {alert.text} • {new Date(alert.createdAt).toLocaleString()}
                        </div>
                      ))}
                      {crmAlerts.length > 5 ? (
                        <div className="text-xs text-gray-500">
                          +{crmAlerts.length - 5} more in Follow-up Schedule
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-600 mt-1">No recent CRM errors.</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="border rounded-lg p-4 space-y-6">
                <div className="text-lg font-semibold">Scheduling</div>
                <div className="border rounded-lg p-3 space-y-3">
                  <div className="text-sm font-semibold">Core Settings</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Time zone</div>
                      <select
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={schedulerForm.timezone}
                        onChange={e => setSchedulerForm({ ...schedulerForm, timezone: e.target.value })}
                      >
                        {timeZones.map(tz => (
                          <option key={tz} value={tz}>
                            {tz}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Assignment mode</div>
                      <select
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={schedulerForm.assignmentMode}
                        onChange={e => setSchedulerForm({ ...schedulerForm, assignmentMode: e.target.value })}
                      >
                        <option value="preferred">Preferred order</option>
                        <option value="round_robin">Round robin</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Min lead time (hours)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={schedulerForm.minLeadTimeHours}
                        onChange={e => setSchedulerForm({ ...schedulerForm, minLeadTimeHours: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Min gap (minutes)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={schedulerForm.minGapBetweenAppointmentsMinutes}
                        onChange={e =>
                          setSchedulerForm({ ...schedulerForm, minGapBetweenAppointmentsMinutes: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Weekday earliest</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={schedulerForm.weekdayEarliest}
                        onChange={e => setSchedulerForm({ ...schedulerForm, weekdayEarliest: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Weekday latest</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={schedulerForm.weekdayLatest}
                        onChange={e => setSchedulerForm({ ...schedulerForm, weekdayLatest: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Saturday earliest</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={schedulerForm.saturdayEarliest}
                        onChange={e => setSchedulerForm({ ...schedulerForm, saturdayEarliest: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-gray-600">Saturday latest</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={schedulerForm.saturdayLatest}
                        onChange={e => setSchedulerForm({ ...schedulerForm, saturdayLatest: e.target.value })}
                      />
                    </label>
                  </div>
                </div>

                {schedulerForm.assignmentMode === "preferred" ? (
                  <div className="border rounded-lg p-3 space-y-3">
                    <div className="text-sm font-semibold">Preferred Salesperson Order</div>
                    <div className="space-y-2">
                      {preferredOrder
                        .map(id => salespeopleList.find(sp => sp.id === id))
                        .filter(Boolean)
                        .map((sp: any, idx: number) => (
                          <div key={sp.id} className="flex items-center gap-2">
                            <div className="flex-1 border rounded px-3 py-2 text-sm bg-white">
                              {sp.name} <span className="text-xs text-gray-500">({sp.id.slice(0, 6)})</span>
                            </div>
                            <div className="flex flex-col">
                              {idx > 0 ? (
                                <button
                                  className="px-2 py-1 border rounded text-xs"
                                  type="button"
                                  onClick={() => {
                                    const ids = [...preferredOrder];
                                    const i = ids.indexOf(sp.id);
                                    if (i <= 0) return;
                                    [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                                    setPreferredOrderIds(ids);
                                  }}
                                >
                                  ↑
                                </button>
                              ) : null}
                              {idx < preferredOrder.length - 1 ? (
                                <button
                                  className={`${idx > 0 ? "mt-1 " : ""}px-2 py-1 border rounded text-xs`}
                                  type="button"
                                  onClick={() => {
                                    const ids = [...preferredOrder];
                                    const i = ids.indexOf(sp.id);
                                    if (i === -1 || i >= ids.length - 1) return;
                                    [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
                                    setPreferredOrderIds(ids);
                                  }}
                                >
                                  ↓
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                ) : null}

                <div className="border rounded-lg p-3 space-y-3">
                  <div className="text-sm font-semibold">Appointment Types</div>
                  <div className="space-y-2">
                    {appointmentTypesList.map((row, idx) => (
                      <div key={`${row.key}-${idx}`} className="grid grid-cols-1 md:grid-cols-[2fr_140px_180px_auto] gap-2 items-center">
                        <label className="space-y-1">
                          <div className="text-xs text-gray-600">Type key</div>
                          <input
                            className="border rounded px-2 py-1 text-sm w-full"
                            placeholder="inventory_visit"
                            value={row.key}
                            onChange={e => {
                              const next = [...appointmentTypesList];
                              next[idx] = { ...row, key: e.target.value };
                              setAppointmentTypesList(next);
                            }}
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="text-xs text-gray-600">Duration (minutes)</div>
                          <input
                            className="border rounded px-2 py-1 text-sm w-full"
                            value={row.durationMinutes}
                            onChange={e => {
                              const next = [...appointmentTypesList];
                              next[idx] = { ...row, durationMinutes: e.target.value };
                              setAppointmentTypesList(next);
                            }}
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="text-xs text-gray-600">Calendar color</div>
                          <div className="flex items-center gap-2 relative">
                            {(() => {
                              const color = getCalendarColor(row.colorId);
                              return (
                                <div
                                  className="w-4 h-4 rounded border"
                                  style={{
                                    backgroundColor: color?.bg ?? "#FFFFFF",
                                    borderColor: color?.border ?? "#D1D5DB"
                                  }}
                                />
                              );
                            })()}
                            <details className="relative">
                              <summary className="list-none border rounded px-2 py-1 text-sm cursor-pointer bg-white flex items-center gap-2">
                                {(() => {
                                  const color = getCalendarColor(row.colorId);
                                  return (
                                    <>
                                      <span
                                        className="inline-block w-3 h-3 rounded border"
                                        style={{
                                          backgroundColor: color?.bg ?? "#FFFFFF",
                                          borderColor: color?.border ?? "#D1D5DB"
                                        }}
                                      />
                                      <span>{color?.label ?? "No color"}</span>
                                    </>
                                  );
                                })()}
                              </summary>
                              <div className="absolute z-10 mt-1 w-44 rounded border bg-white shadow">
                                <button
                                  className="w-full px-2 py-1 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
                                  onClick={e => {
                                    const next = [...appointmentTypesList];
                                    next[idx] = { ...row, colorId: "" };
                                    setAppointmentTypesList(next);
                                    (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute(
                                      "open"
                                    );
                                  }}
                                >
                                  <span className="inline-block w-3 h-3 rounded border bg-white border-gray-300" />
                                  No color
                                </button>
                                {CALENDAR_COLORS.map(c => (
                                  <button
                                    key={c.id}
                                    className="w-full px-2 py-1 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
                                    onClick={e => {
                                      const next = [...appointmentTypesList];
                                      next[idx] = { ...row, colorId: c.id };
                                      setAppointmentTypesList(next);
                                      (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute(
                                        "open"
                                      );
                                    }}
                                  >
                                    <span
                                      className="inline-block w-3 h-3 rounded border"
                                      style={{ backgroundColor: c.bg, borderColor: c.border }}
                                    />
                                    <span>{c.label}</span>
                                  </button>
                                ))}
                              </div>
                            </details>
                          </div>
                        </label>
                        <button
                          className="px-2 py-1 border rounded text-xs text-red-600 self-end md:self-auto"
                          onClick={() => setAppointmentTypesList(prev => prev.filter((_, i) => i !== idx))}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <div className="flex gap-2 items-center">
                      <select
                        className="border rounded px-2 py-1 text-sm"
                        value={appointmentTypeToAdd}
                        onChange={e => setAppointmentTypeToAdd(e.target.value)}
                      >
                        {availableAppointmentTypes.map(key => (
                          <option key={key} value={key}>
                            {key}
                          </option>
                        ))}
                        <option value="custom">Custom</option>
                      </select>
                      <button
                        className="px-3 py-2 border rounded text-sm"
                        onClick={() => {
                          if (appointmentTypeToAdd === "custom") {
                            setAppointmentTypesList(prev => [...prev, { key: "", durationMinutes: "60", colorId: "" }]);
                            return;
                          }
                          const key = availableAppointmentTypes.includes(appointmentTypeToAdd)
                            ? appointmentTypeToAdd
                            : availableAppointmentTypes[0];
                          if (!key) return;
                          setAppointmentTypesList(prev => [...prev, { key, durationMinutes: "60", colorId: "" }]);
                        }}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>

                <div className="border rounded-lg p-3 space-y-3">
                  <div className="text-sm font-semibold">Business Hours</div>
                  <div className="grid grid-cols-3 gap-2 text-xs font-medium text-gray-600 px-1 mb-1">
                    <div>Day</div>
                    <div>Open</div>
                    <div>Close</div>
                  </div>
                  <div className="space-y-2">
                    {days.map(day => {
                      const current = schedulerHours?.[day] ?? { open: null, close: null };
                      return (
                        <div key={day} className="grid grid-cols-3 gap-2 items-center text-sm">
                          <div className="capitalize">{day}</div>
                          <select
                            className="border rounded px-2 py-1 text-sm"
                            value={current.open ?? ""}
                            onChange={e => updateHours(setSchedulerHours, day, "open", e.target.value)}
                          >
                            <option value="">Closed</option>
                            {timeOptions.map(t => (
                              <option key={`sched-open-${day}-${t}`} value={t}>
                                {formatTimeLabel(t, schedulerForm.timezone)}
                              </option>
                            ))}
                          </select>
                          <select
                            className="border rounded px-2 py-1 text-sm"
                            value={current.close ?? ""}
                            onChange={e => updateHours(setSchedulerHours, day, "close", e.target.value)}
                          >
                            <option value="">Closed</option>
                            {timeOptions.map(t => (
                              <option key={`sched-close-${day}-${t}`} value={t}>
                                {formatTimeLabel(t, schedulerForm.timezone)}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <button
                    className="px-3 py-2 border rounded text-sm"
                    onClick={saveSchedulerConfig}
                    disabled={settingsSaving}
                  >
                    {settingsSaving ? "Saving…" : "Save Scheduling"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : section === "contacts" ? (
          selectedContact ? (
            <div className="max-w-5xl space-y-5">
              <div className="flex items-center justify-between border-b pb-3">
                <div className="text-4xl font-medium text-gray-900">
                  {selectedContact.name ||
                    [selectedContact.firstName, selectedContact.lastName].filter(Boolean).join(" ") ||
                    selectedContact.phone ||
                    selectedContact.email ||
                    "Unknown"}
                </div>
                <div className="flex items-center gap-2">
                  {selectedContact.conversationId || selectedContact.leadKey ? (
                    <button
                      className="px-2 py-1 border rounded text-xs"
                      title="Open chat"
                      onClick={() => {
                        goToSection("inbox");
                        const id = selectedContact.conversationId ?? selectedContact.leadKey ?? null;
                        if (id) openConversation(id);
                      }}
                    >
                      💬
                    </button>
                  ) : null}
                  <button
                    className="px-2 py-1 border rounded text-xs text-red-600 border-red-200 hover:bg-red-50"
                    onClick={deleteContact}
                    title="Delete contact"
                  >
                    🗑️
                  </button>
                </div>
              </div>

              <div className="border rounded-lg p-4">
                <div className="text-2xl font-semibold text-gray-800 mb-3">Contact Information</div>
                {contactEdit ? (
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      placeholder="First name"
                      value={contactForm.firstName}
                      onChange={e => setContactForm({ ...contactForm, firstName: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      placeholder="Last name"
                      value={contactForm.lastName}
                      onChange={e => setContactForm({ ...contactForm, lastName: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      placeholder="Display name"
                      value={contactForm.name}
                      onChange={e => setContactForm({ ...contactForm, name: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      placeholder="Phone"
                      value={contactForm.phone}
                      onChange={e => setContactForm({ ...contactForm, phone: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm col-span-2"
                      placeholder="Email"
                      value={contactForm.email}
                      onChange={e => setContactForm({ ...contactForm, email: e.target.value })}
                    />
                    <div className="col-span-2 flex gap-2">
                      <button className="px-3 py-2 border rounded text-sm" onClick={saveContact}>
                        Save
                      </button>
                      <button
                        className="px-3 py-2 border rounded text-sm"
                        onClick={() => setContactEdit(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="divide-y border rounded">
                      <div className="px-4 py-3 flex items-center justify-between">
                        <div className="text-gray-500">Mobile Phone</div>
                        <div className="font-medium">{selectedContact.phone ?? "—"}</div>
                      </div>
                      <div className="px-4 py-3 flex items-center justify-between gap-3">
                        <div className="text-gray-500">Motorcycle of Interest</div>
                        <div className="font-medium text-right">
                          {formatMotorcycleOfInterest(selectedContact)}
                          <span className="ml-2 text-xs font-normal text-gray-500">
                            {formatContactDate(
                              selectedContact.lastAdfAt ??
                                selectedContact.lastInboundAt ??
                                selectedContact.updatedAt
                            ) || "—"}
                          </span>
                        </div>
                      </div>
                      <div className="px-4 py-3 flex items-center justify-between gap-3">
                        <div className="text-gray-500">Text Marketing Opt-in</div>
                        <div className="flex items-center gap-3">
                          <span className="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700">
                            {selectedContact.status === "suppressed" ? "Not Opted In" : "Unknown"}
                          </span>
                          <button className="px-3 py-1 border rounded text-sm">Request</button>
                        </div>
                      </div>
                      <div className="px-4 py-3 flex items-center justify-between gap-3">
                        <div className="text-gray-500">Outbound Messages</div>
                        <div className="flex items-center gap-2 text-xs">
                          <span
                            className={`px-2 py-0.5 rounded-full ${
                              selectedContact.status === "suppressed"
                                ? "bg-gray-200 text-gray-700"
                                : "bg-green-100 text-green-700"
                            }`}
                          >
                            {selectedContact.status === "suppressed" ? "Text Blocked" : "Text Allowed"}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full ${
                              selectedContact.email
                                ? "bg-green-100 text-green-700"
                                : "bg-gray-200 text-gray-700"
                            }`}
                          >
                            {selectedContact.email ? "Email Allowed" : "Email Missing"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 text-right">
                      <button className="text-sm text-blue-600 hover:underline" onClick={() => setContactEdit(true)}>
                        Edit
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="border rounded-lg p-4">
                <div className="text-2xl font-semibold text-gray-800 mb-3">Notes</div>
                <button className="w-full border rounded px-3 py-2 text-left text-blue-600">+ Add Notes</button>
              </div>

              <div className="border rounded-lg p-4">
                <div className="text-2xl font-semibold text-gray-800 mb-3">Scheduled Messages</div>
                <button className="w-full border rounded px-3 py-2 text-left text-blue-600">
                  + Schedule a Message
                </button>
              </div>

              <div className="border rounded-lg p-4">
                <div className="text-2xl font-semibold text-gray-800 mb-3">Files</div>
                <button className="w-full border rounded px-3 py-2 text-left text-blue-600">+ Add a File</button>
              </div>
            </div>
          ) : (
            selectedContactListId !== "all" ? (
              <div className="border rounded-lg p-6 max-w-4xl">
                <div className="text-5xl leading-none text-gray-300 mb-4">+</div>
                <div className="text-4xl font-semibold text-gray-800">Groups are much better with contacts.</div>
                <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-8 text-sm">
                  <div>
                    <button
                      className="text-blue-600 font-semibold hover:underline"
                      onClick={() => groupCsvInputRef.current?.click()}
                    >
                      Upload a CSV file
                    </button>
                    <div className="text-gray-500 mt-1">containing the contacts you’d like to add</div>
                  </div>
                  <div>
                    <div className="font-semibold text-gray-800">Drag and Drop</div>
                    <div className="text-gray-500 mt-1">from All Contacts or any other group</div>
                  </div>
                  <div>
                    <div className="font-semibold text-gray-800">Sync with Integration</div>
                    <div className="text-gray-500 mt-1">
                      multiply the power of your existing dynamic lists
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold text-gray-800">Multi-Select</div>
                    <ul className="mt-1 text-gray-500 list-disc pl-5 space-y-1">
                      <li>Open the menu next to the search field</li>
                      <li>Select the contacts you’d like to add</li>
                      <li>Choose Add to Another Group</li>
                    </ul>
                  </div>
                </div>
                <div className="mt-10 pt-6 border-t text-sm text-gray-500">
                  Have you changed your mind?{" "}
                  <button className="text-blue-600 hover:underline" onClick={deleteGroup}>
                    delete this group
                  </button>
                </div>
                <input
                  ref={groupCsvInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={async e => {
                    const inputEl = e.currentTarget;
                    const file = e.target.files?.[0];
                    if (!file) return;
                    await importContactsCsv(file);
                    inputEl.value = "";
                  }}
                />
              </div>
            ) : (
              <div className="text-gray-500">Select a contact to view details.</div>
            )
          )
        ) : !canViewConversation ? (
          <div className="text-gray-500">Select “Inbox” to view a conversation.</div>
        ) : !selectedId ? (
          <div className="text-gray-500">Select a conversation to view details.</div>
        ) : detailLoading ? (
          <div className="text-gray-500">Loading…</div>
        ) : selectedConv ? (
          <div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-2xl font-semibold flex items-center gap-2">
                  <span>
                    {selectedConv.lead?.name ||
                      [selectedConv.lead?.firstName, selectedConv.lead?.lastName].filter(Boolean).join(" ") ||
                      selectedConv.leadKey}
                  </span>
                  {renderDealTemperatureIcon(
                    getDealTemperature(
                      (selectedListItem ??
                        (selectedConv as unknown as ConversationListItem)) as ConversationListItem
                    ),
                    "text-xl"
                  )}
                  {(() => {
                    const isHold =
                      selectedConv.followUpCadence?.pauseReason === "manual_hold" ||
                      selectedConv.followUpCadence?.pauseReason === "unit_hold" ||
                      selectedConv.followUpCadence?.pauseReason === "order_hold" ||
                      selectedConv.followUpCadence?.stopReason === "unit_hold" ||
                      selectedConv.followUpCadence?.stopReason === "order_hold" ||
                      selectedConv.followUp?.reason === "manual_hold" ||
                      selectedConv.followUp?.reason === "unit_hold" ||
                      selectedConv.followUp?.reason === "order_hold" ||
                      !!selectedConv.hold;
                    const isSold = isSoldDealConversation(
                      (selectedListItem ??
                        (selectedConv as unknown as ConversationListItem)) as ConversationListItem
                    );
                    const holdUntil =
                      selectedConv.hold?.until ??
                      (isHold ? selectedConv.followUpCadence?.pausedUntil : null);
                    const statusLabel = isSold
                      ? "Sold"
                      : selectedConv.status === "closed"
                        ? "Closed"
                        : isHold
                          ? "Hold"
                          : "Open";
                    const badgeClass =
                      statusLabel === "Closed"
                        ? "bg-gray-100 text-gray-700 border-gray-200"
                        : statusLabel === "Sold"
                          ? "bg-blue-100 text-blue-900 border-blue-300"
                          : statusLabel === "Hold"
                            ? "bg-red-100 text-red-900 border-red-300"
                            : "bg-emerald-100 text-emerald-800 border-emerald-200";
                    if (statusLabel === "Sold") {
                      return (
                        <button
                          type="button"
                          className={`text-xs px-2 py-0.5 rounded-full border cursor-pointer transition-colors hover:bg-blue-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 ${badgeClass}`}
                          onClick={() => setSoldDetailsOpen(true)}
                          title="View purchased motorcycle"
                        >
                          Sold
                        </button>
                      );
                    }
                    if (statusLabel === "Hold") {
                      return (
                        <button
                          type="button"
                          className={`text-xs px-2 py-0.5 rounded-full border cursor-pointer transition-colors hover:bg-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 ${badgeClass}`}
                          onClick={() => setHoldDetailsOpen(true)}
                          title="View bike on hold"
                        >
                          Hold
                        </button>
                      );
                    }
                    return (
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${badgeClass}`}>
                        {statusLabel}
                      </span>
                    );
                  })()}
                  {selectedConv.contactPreference === "call_only" ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                      Prefers Call
                    </span>
                  ) : null}
                  {selectedConv.leadOwner?.name || selectedConv.leadOwner?.id ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[color:rgba(251,127,4,0.14)] text-[var(--accent)] border border-[color:rgba(251,127,4,0.42)]">
                      Owner: {selectedConv.leadOwner?.name || selectedConv.leadOwner?.id}
                    </span>
                  ) : null}
                </div>
                {(selectedConv.lead?.name ||
                  [selectedConv.lead?.firstName, selectedConv.lead?.lastName].filter(Boolean).join(" ")) ? (
                  <div className="text-lg text-gray-700 mt-1">{selectedConv.leadKey}</div>
                ) : null}
                {selectedConv.lead?.leadRef ? (
                  <div className="text-xs text-gray-500 mt-1">Lead Ref: {selectedConv.lead.leadRef}</div>
                ) : null}
                {headerAppointment ? (
                  <div className="text-xs text-gray-600 mt-1">
                    Appointment: {headerAppointment.whenText}
                    {appointmentSalespersonName ? ` • ${appointmentSalespersonName}` : ""}
                    {headerAppointment.bookedEventLink ? (
                      <>
                        {" "}
                        •{" "}
                        <a
                          className="underline"
                          href={headerAppointment.bookedEventLink}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Calendar
                        </a>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {(() => {
                  const outcome = selectedConv.appointment?.staffNotify?.outcome;
                  const outcomeLabel = formatAppointmentOutcomeDisplay({
                    primary: outcome?.primaryStatus ?? null,
                    secondary: outcome?.secondaryStatus ?? null,
                    legacy: outcome?.status ?? null
                  });
                  if (!outcomeLabel) return null;
                  return <div className="text-xs text-gray-600 mt-1">Outcome: {outcomeLabel}</div>;
                })()}
                {(() => {
                  const outcome = selectedConv.appointment?.staffNotify?.outcome;
                  if (!outcome?.note) return null;
                  if (!authUser?.role) return null;
                  return (
                    <div className="mt-2 text-xs text-slate-700">
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        onClick={() => setOutcomeNoteOpen(v => !v)}
                      >
                        Outcome note
                        <span className="text-[10px] text-slate-500">{outcomeNoteOpen ? "Hide" : "View"}</span>
                      </button>
                      {outcomeNoteOpen ? (
                        <div className="mt-2 rounded border bg-slate-50 px-3 py-2 text-xs text-slate-700">
                          <div className="mt-1 whitespace-pre-wrap">{outcome.note}</div>
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
                {(() => {
                  const watches =
                    selectedConv.inventoryWatches?.length
                      ? selectedConv.inventoryWatches
                      : selectedConv.inventoryWatch
                        ? [selectedConv.inventoryWatch]
                        : [];
                  if (!watches.length) return null;
                  const labels = watches.map(w => {
                    const year = w.year ? String(w.year) : "";
                    const make = w.make ?? "";
                    const model = w.model ?? "";
                    const trim = w.trim ?? "";
                    const color = w.color ? ` (${w.color})` : "";
                    return [year, make, model, trim].filter(Boolean).join(" ").trim() + color;
                  });
                  return (
                    <div className="text-xs text-gray-600 mt-1">
                      Watch: {labels.join(" • ")}
                    </div>
                  );
                })()}
                <div className="text-xs text-gray-500 mt-1">
                  {(() => {
                    const isHold =
                      selectedConv.followUpCadence?.pauseReason === "manual_hold" ||
                      selectedConv.followUpCadence?.pauseReason === "unit_hold" ||
                      selectedConv.followUpCadence?.pauseReason === "order_hold" ||
                      selectedConv.followUpCadence?.stopReason === "unit_hold" ||
                      selectedConv.followUpCadence?.stopReason === "order_hold" ||
                      selectedConv.followUp?.reason === "manual_hold" ||
                      selectedConv.followUp?.reason === "unit_hold" ||
                      selectedConv.followUp?.reason === "order_hold" ||
                      !!selectedConv.hold;
                    const holdUntil =
                      selectedConv.hold?.until ??
                      (isHold ? selectedConv.followUpCadence?.pausedUntil : null);
                    if (selectedConv.status === "closed") {
                      const soldInDetail = isSoldDealConversation(
                        (selectedListItem ??
                          (selectedConv as unknown as ConversationListItem)) as ConversationListItem
                      );
                      if (soldInDetail) {
                        return (
                          <button
                            type="button"
                            className="text-blue-900 underline decoration-blue-300 underline-offset-2 hover:text-blue-700 cursor-pointer"
                            onClick={() => setSoldDetailsOpen(true)}
                            title="View purchased motorcycle"
                          >
                            Sold
                          </button>
                        );
                      }
                      if (selectedConv.closedAt) {
                        return `Closed: ${new Date(selectedConv.closedAt).toLocaleString()}`;
                      }
                    }
                    if (isHold && holdUntil) {
                      return (
                        <button
                          type="button"
                          className="text-red-900 underline decoration-red-300 underline-offset-2 hover:text-red-700 cursor-pointer"
                          onClick={() => setHoldDetailsOpen(true)}
                          title="View bike on hold"
                        >
                          {`Hold until ${formatCadenceDate(holdUntil)}`}
                        </button>
                      );
                    }
                    if (isHold) {
                      return (
                        <button
                          type="button"
                          className="text-red-900 underline decoration-red-300 underline-offset-2 hover:text-red-700 cursor-pointer"
                          onClick={() => setHoldDetailsOpen(true)}
                          title="View bike on hold"
                        >
                          Hold
                        </button>
                      );
                    }
                    return "Active";
                  })()}
                </div>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                {(authUser?.phone || authUser?.extension) ? (
                  <div className="flex items-center gap-2">
                    <button
                      className={`px-2 py-1 border rounded text-sm cursor-pointer shrink-0 ${callBusy ? "opacity-60" : "hover:bg-gray-50"}`}
                      onClick={() => {
                        if (authUser?.phone && authUser?.extension) {
                          setCallPickerOpen(true);
                          return;
                        }
                        if (authUser?.extension && !authUser?.phone) {
                          startCall("extension");
                          return;
                        }
                        startCall("cell");
                      }}
                      disabled={callBusy}
                      title="Call customer"
                    >
                      <span className="mr-1">📞</span>
                      Call
                    </button>
                  </div>
                ) : null}
                {(authUser?.role === "manager" || authUser?.permissions?.canEditAppointments) &&
                !(selectedConv.classification?.bucket === "service" || selectedConv.classification?.cta === "service_request") ? (
                  <button
                    className="px-2 py-1 border rounded text-sm shrink-0"
                    onClick={openManualAppointment}
                    title="Set appointment"
                  >
                    📅
                  </button>
                ) : null}
                {!(selectedConv.classification?.bucket === "service" || selectedConv.classification?.cta === "service_request") ? (
                  <button
                    className="px-2 py-1 border rounded text-sm shrink-0"
                    onClick={() => openCadenceResolve(selectedConv.id, "watch")}
                    title="Add vehicle watch"
                  >
                    👀
                  </button>
                ) : null}
                {(authUser?.role === "manager" || authUser?.permissions?.canToggleHumanOverride) ? (
                  <button
                    className={`px-2 py-1 border rounded text-sm cursor-pointer shrink-0 ${selectedConv.mode === "human" ? "font-semibold bg-black text-white" : "hover:bg-gray-50"}`}
                    onClick={() => setHumanMode(selectedConv.mode === "human" ? "suggest" : "human")}
                    title={selectedConv.mode === "human" ? "Disable human override" : "Human takeover"}
                  >
                    <span className="mr-1">👤</span>
                  </button>
                ) : null}
                {(authUser?.role === "manager" || authUser?.permissions?.canAccessTodos) ? (
                  <button
                    className={`px-2 py-1 border rounded text-sm shrink-0 ${agentContextOpen ? "bg-gray-100 font-medium" : "hover:bg-gray-50"}`}
                    onClick={() => setAgentContextOpen(prev => !prev)}
                    title="Open internal agent context"
                  >
                    Context
                  </button>
                ) : null}
                {modeSaving ? <span className="text-xs text-gray-500">Saving…</span> : null}
              </div>
            </div>
            {modeError ? <div className="text-xs text-red-600 mt-1">{modeError}</div> : null}
            {cadenceResolveNotice ? (
              <div className="mt-2 border rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                {cadenceResolveNotice}
              </div>
            ) : null}
            {cadenceAlert ? (
              <div className="mt-3 border rounded-lg bg-amber-50 px-3 py-2 text-sm flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-amber-900">
                    Next follow-up scheduled
                  </div>
                  <div className="text-xs text-amber-800">
                    Scheduled to send: {formatCadenceDate(cadenceAlert.sendAt.toISOString())}
                  </div>
                </div>
                <button
                  className="px-3 py-2 border rounded text-sm bg-white"
                  onClick={() => openCadenceResolve(selectedConv.id, "alert")}
                >
                  Review
                </button>
              </div>
            ) : null}
            {!cadenceAlert &&
            selectedCadence?.status === "active" &&
            selectedCadence?.nextDueAt ? (
              <div className="mt-3 border rounded-lg bg-amber-50 px-3 py-2 text-sm flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-amber-900">Follow-up cadence active</div>
                  <div className="text-xs text-amber-800">
                    Next due: {formatCadenceDate(selectedCadence.nextDueAt)}
                  </div>
                </div>
                <button
                  className="px-3 py-2 border rounded text-sm bg-white"
                  onClick={() => openCadenceResolve(selectedConv.id, "alert")}
                >
                  Review
                </button>
              </div>
            ) : null}
            {agentContextOpen ? (
            <div className="mt-3 border rounded-lg bg-slate-50 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-slate-800">Agent Context (Internal)</div>
                {(() => {
                  const ctx = selectedConv.agentContext;
                  if (!ctx?.text) return null;
                  const expiresAt = ctx.expiresAt ? new Date(ctx.expiresAt) : null;
                  const expired =
                    !!expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();
                  const modeLabel = ctx.mode === "next_reply" ? "Next reply only" : "Persistent";
                  return (
                    <div className="text-xs text-slate-600">
                      {expired ? (
                        <span className="px-2 py-0.5 rounded-full border border-amber-300 bg-amber-100 text-amber-800">
                          Expired
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full border border-slate-300 bg-white">
                          {modeLabel}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                <textarea
                  className="md:col-span-3 border rounded px-3 py-2 text-sm"
                  rows={3}
                  placeholder="Internal guidance note for agent (never sent verbatim)."
                  value={agentContextText}
                  onChange={e => setAgentContextText(e.target.value)}
                />
                <div className="md:col-span-3 flex items-center gap-2">
                  <button
                    type="button"
                    className={`px-3 py-2 border rounded text-sm disabled:opacity-60 ${
                      agentContextSpeechListening ? "bg-emerald-50 border-emerald-300 text-emerald-800" : "bg-white"
                    }`}
                    disabled={!agentContextSpeechSupported || agentContextSaving}
                    onClick={() => {
                      if (agentContextSpeechListening) {
                        stopAgentContextSpeech();
                        return;
                      }
                      void startAgentContextSpeech();
                    }}
                    title={
                      agentContextSpeechSupported
                        ? "Tap once to start voice input, then tap again to stop."
                        : "Voice input not supported on this browser."
                    }
                  >
                    {agentContextSpeechListening ? "🎙️ Listening... tap to stop" : "🎤 Tap to talk"}
                  </button>
                  {!agentContextSpeechSupported ? (
                    <span className="text-xs text-slate-500">Voice input not supported on this browser.</span>
                  ) : (
                    <span className="text-xs text-slate-500">Tap to start, then tap again to stop.</span>
                  )}
                </div>
                <label className="text-xs text-slate-600">
                  Scope
                  <select
                    className="mt-1 w-full border rounded px-2 py-2 text-sm bg-white"
                    value={agentContextMode}
                    onChange={e =>
                      setAgentContextMode(e.target.value === "next_reply" ? "next_reply" : "persistent")
                    }
                  >
                    <option value="persistent">Persistent</option>
                    <option value="next_reply">Next reply only</option>
                  </select>
                </label>
                <label className="text-xs text-slate-600 md:col-span-2">
                  Expires At (optional)
                  <input
                    type="datetime-local"
                    className="mt-1 w-full border rounded px-2 py-2 text-sm"
                    value={agentContextExpiresAt}
                    onChange={e => setAgentContextExpiresAt(e.target.value)}
                  />
                </label>
              </div>
              {selectedConv.agentContext?.updatedAt ? (
                <div className="mt-2 text-[11px] text-slate-500">
                  Updated {new Date(selectedConv.agentContext.updatedAt).toLocaleString()}
                  {selectedConv.agentContext.updatedByUserName
                    ? ` by ${selectedConv.agentContext.updatedByUserName}`
                    : ""}
                </div>
              ) : null}
              {(() => {
                const notes = (selectedConv.agentContext?.notes ?? [])
                  .filter(note => String(note?.text ?? "").trim().length > 0)
                  .slice()
                  .sort((a, b) => {
                    const aMs = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
                    const bMs = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
                    return bMs - aMs;
                  });
                if (!notes.length) return null;
                return (
                  <div className="mt-3 border rounded bg-white">
                    <div className="px-2 py-1 text-xs font-medium text-slate-700 border-b">
                      Context Notes
                    </div>
                    <div className="max-h-40 overflow-y-auto divide-y">
                      {notes.map(note => {
                        const modeLabel = note.mode === "next_reply" ? "Next reply" : "Persistent";
                        const expiresAt = note.expiresAt ? new Date(note.expiresAt) : null;
                        const expiresLabel =
                          expiresAt && !Number.isNaN(expiresAt.getTime())
                            ? expiresAt.toLocaleString()
                            : "";
                        const addressedAt = note.addressedAt ? new Date(note.addressedAt) : null;
                        const addressedLabel =
                          addressedAt && !Number.isNaN(addressedAt.getTime())
                            ? addressedAt.toLocaleString()
                            : "";
                        const addressedReason = String(note.addressedReason ?? "").trim();
                        const isAddressed = !!addressedLabel;
                        return (
                          <div
                            key={note.id ?? `${note.createdAt ?? "note"}-${note.text ?? ""}`}
                            className={`px-2 py-2 ${isAddressed ? "bg-slate-50" : ""}`}
                          >
                            <div className="text-[11px] text-slate-500">
                              {note.createdAt ? new Date(note.createdAt).toLocaleString() : "Unknown date"}
                              {note.createdByUserName ? ` • ${note.createdByUserName}` : ""}
                            </div>
                            <div className="mt-1 text-xs text-slate-700 whitespace-pre-wrap">
                              {note.text}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500">
                              {modeLabel}
                              {expiresLabel ? ` • Expires ${expiresLabel}` : ""}
                              {addressedLabel ? ` • Addressed ${addressedLabel}` : ""}
                              {addressedReason ? ` (${addressedReason.replace(/_/g, " ")})` : ""}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
              {agentContextError ? (
                <div className="mt-2 text-xs text-red-600">{agentContextError}</div>
              ) : null}
              {agentContextSpeechError ? (
                <div className="mt-2 text-xs text-red-600">{agentContextSpeechError}</div>
              ) : null}
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="px-3 py-2 border rounded text-sm bg-white disabled:opacity-60"
                  onClick={() => void saveAgentContext()}
                  disabled={agentContextSaving}
                >
                  {agentContextSaving ? "Saving..." : "Save context"}
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm bg-white disabled:opacity-60"
                  onClick={() => void saveAgentContext({ addNote: true })}
                  disabled={agentContextSaving}
                >
                  {agentContextSaving ? "Saving..." : "Add Context Note"}
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm bg-white disabled:opacity-60"
                  onClick={clearAgentContextNow}
                  disabled={agentContextSaving}
                >
                  Clear
                </button>
              </div>
            </div>
            ) : null}

            {callPickerOpen ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                <div className="w-80 rounded-lg bg-white shadow-lg border p-4">
                  <div className="text-sm font-semibold">Place call with</div>
                  <div className="mt-3 flex gap-2">
                    {authUser?.phone ? (
                      <button
                        className="flex-1 px-3 py-2 rounded border hover:bg-gray-50 text-sm"
                        disabled={callBusy}
                        onClick={() => {
                          setCallMethod("cell");
                          setCallPickerOpen(false);
                          startCall("cell");
                        }}
                      >
                        Cell
                      </button>
                    ) : null}
                    {authUser?.extension ? (
                      <button
                        className="flex-1 px-3 py-2 rounded border hover:bg-gray-50 text-sm"
                        disabled={callBusy}
                        onClick={() => {
                          setCallMethod("extension");
                          setCallPickerOpen(false);
                          startCall("extension");
                        }}
                      >
                        Extension
                      </button>
                    ) : null}
                  </div>
                  <div className="mt-3 text-right">
                    <button
                      className="text-xs text-gray-500 hover:text-gray-700"
                      onClick={() => setCallPickerOpen(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {manualApptOpen ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                <div className="w-full max-w-md rounded-lg bg-white shadow-lg border p-4">
                  <div className="text-sm font-semibold">Set appointment</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {schedulerConfig?.timezone ?? "America/New_York"} time
                  </div>
                  <div className="text-xs text-gray-600 mt-2">
                    {[selectedConv.lead?.firstName, selectedConv.lead?.lastName]
                      .filter(Boolean)
                      .join(" ") || selectedConv.lead?.name || selectedConv.leadKey}
                    {selectedConv.lead?.phone ? ` • ${selectedConv.lead.phone}` : ""}
                    {selectedConv.lead?.email ? ` • ${selectedConv.lead.email}` : ""}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Date</div>
                      <input
                        type="date"
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={manualApptForm.date}
                        onChange={e => setManualApptForm(prev => ({ ...prev, date: e.target.value }))}
                      />
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Time</div>
                      <input
                        type="time"
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={manualApptForm.time}
                        onChange={e => setManualApptForm(prev => ({ ...prev, time: e.target.value }))}
                      />
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Appointment type</div>
                      <select
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={manualApptForm.appointmentType}
                        onChange={e => setManualApptForm(prev => ({ ...prev, appointmentType: e.target.value }))}
                      >
                        {manualAppointmentTypes.map(row => (
                          <option key={row.key} value={row.key}>
                            {row.key}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Salesperson</div>
                      <select
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={manualApptForm.salespersonId}
                        onChange={e => setManualApptForm(prev => ({ ...prev, salespersonId: e.target.value }))}
                      >
                        <option value="">Select salesperson</option>
                        {salespeopleList.map(sp => (
                          <option key={sp.id} value={sp.id}>
                            {sp.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-3">
                    <div className="text-xs text-gray-500 mb-1">Notes (optional)</div>
                    <textarea
                      className="border rounded px-3 py-2 text-sm w-full"
                      rows={3}
                      value={manualApptForm.notes}
                      onChange={e => setManualApptForm(prev => ({ ...prev, notes: e.target.value }))}
                    />
                  </div>

                  {manualApptError ? (
                    <div className="text-xs text-red-600 mt-2">{manualApptError}</div>
                  ) : null}

                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      className="px-3 py-2 border rounded text-sm"
                      onClick={() => setManualApptOpen(false)}
                      disabled={manualApptSaving}
                    >
                      Cancel
                    </button>
                    <button
                      className="px-3 py-2 border rounded text-sm"
                      onClick={saveManualAppointment}
                      disabled={manualApptSaving}
                    >
                      {manualApptSaving ? "Saving…" : "Set appointment"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {cadenceResolveOpen ? (
              <div className="fixed inset-0 z-50 bg-black/40 overflow-y-auto">
                <div className="min-h-full flex items-start sm:items-center justify-center p-2 sm:p-4">
                <div className="w-full max-w-2xl max-h-[94dvh] overflow-y-auto rounded-lg bg-white shadow-lg border p-3 sm:p-4">
                  <div className="text-sm font-semibold">
                    {cadenceResolveMode === "watch" ? "Add vehicle watch" : "Follow-up cadence"}
                  </div>
                  {cadenceResolveConv ? (
                    <div className="text-xs text-gray-600 mt-1">
                      {cadenceResolveConv.lead?.name ||
                        [cadenceResolveConv.lead?.firstName, cadenceResolveConv.lead?.lastName]
                          .filter(Boolean)
                          .join(" ") ||
                        cadenceResolveConv.leadKey}
                      {cadenceResolveConv.lead?.phone ? ` • ${cadenceResolveConv.lead.phone}` : ""}
                    </div>
                  ) : null}

                  <div className="mt-3">
                    <div className="text-xs text-gray-500 mb-1">Follow-up action</div>
                    <select
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={cadenceResolution}
                      onChange={e => setCadenceResolution(e.target.value)}
                    >
                      <option value="resume">Resume follow-ups now</option>
                      <option value="resume_on">Resume on selected date</option>
                      <option value="pause_7">Pause for 7 days</option>
                      <option value="pause_30">Pause for 30 days</option>
                      <option value="pause_indef">Pause indefinitely</option>
                      <option value="appointment_set">Appointment set manually</option>
                      <option value="archive">Archive conversation</option>
                    </select>
                  </div>

                  {cadenceResolution === "resume_on" ? (
                    <div className="mt-3">
                      <div className="text-xs text-gray-500 mb-1">Resume date</div>
                      <input
                        type="date"
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={cadenceResumeDate}
                        onChange={e => setCadenceResumeDate(e.target.value)}
                      />
                    </div>
                  ) : null}

                  <div className="mt-4 border-t pt-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={cadenceWatchEnabled}
                        onChange={e => setCadenceWatchEnabled(e.target.checked)}
                      />
                      Add inventory watch (pauses cadence)
                    </label>
                    {cadenceWatchEnabled ? (
                      <div className="mt-3 space-y-3">
                        {cadenceWatchItems.map((item, idx) => {
                          const modelOptions = getWatchModelChoices(item);
                          const filteredModelOptions = filterWatchModelChoices(modelOptions, item.modelSearch);
                          const groupModels = getItemModels(item);

                          const makeOptionsLower = new Set(watchMakeOptions.map(o => o.toLowerCase()));
                          const makeInOptions = makeOptionsLower.has((item.make ?? "").toLowerCase());
                          const makeSelectValue = makeInOptions ? item.make : "__custom__";
                          const showCustomMakeInput = watchMakeOptions.length === 0 || !makeInOptions;
                          return (
                          <div key={`watch-${idx}`} className="border rounded p-3">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <div className="text-xs text-gray-500 mb-1">Condition</div>
                                <select
                                  className="border rounded px-2 py-2 text-sm w-full"
                                  value={item.condition}
                                  onChange={e => updateWatchItem(idx, { condition: e.target.value })}
                                >
                                  <option value="">Any</option>
                                  <option value="new">New</option>
                                  <option value="used">Pre-owned</option>
                                </select>
                              </div>
                              <div>
                                <div className="text-xs text-gray-500 mb-1">Year</div>
                                <input
                                  className="border rounded px-2 py-2 text-sm w-full"
                                  placeholder="2026 or 2018-2021"
                                  value={item.year}
                                  onChange={e =>
                                    updateWatchItem(idx, {
                                      year: e.target.value,
                                      model: "",
                                      models: [],
                                      customModel: "",
                                      modelSearch: ""
                                    })
                                  }
                                />
                              </div>
                              <div>
                                <div className="text-xs text-gray-500 mb-1">Make</div>
                                <select
                                  className="border rounded px-2 py-2 text-sm w-full"
                                  value={makeSelectValue}
                                  onChange={e => {
                                    const value = e.target.value;
                                    if (value === "__custom__") {
                                      updateWatchItem(idx, {
                                        make: makeInOptions ? "" : item.make,
                                        model: "",
                                        models: [],
                                        customModel: "",
                                        modelSearch: ""
                                      });
                                      return;
                                    }
                                    updateWatchItem(idx, {
                                      make: value,
                                      model: "",
                                      models: [],
                                      customModel: "",
                                      modelSearch: ""
                                    });
                                  }}
                                >
                                  <option value="">Select make</option>
                                  {watchMakeOptions.map(option => (
                                    <option key={option} value={option}>
                                      {option}
                                    </option>
                                  ))}
                                  <option value="__custom__">Other (type manually)</option>
                                </select>
                                {showCustomMakeInput ? (
                                  <input
                                    className="border rounded px-2 py-2 text-sm w-full mt-2"
                                    placeholder="Type make"
                                    value={item.make}
                                    onChange={e => updateWatchItem(idx, { make: e.target.value })}
                                  />
                                ) : null}
                              </div>
                              <div>
                                <div className="text-xs text-gray-500 mb-1">Model</div>
                                {modelOptions.length ? (
                                  <div className="border rounded p-2 max-h-48 overflow-auto">
                                    <input
                                      className="border rounded px-2 py-1 text-xs w-full mb-2"
                                      placeholder="Search models..."
                                      value={item.modelSearch ?? ""}
                                      onChange={e => updateWatchItem(idx, { modelSearch: e.target.value })}
                                    />
                                    {filteredModelOptions.length ? filteredModelOptions.map(option => {
                                      const checked = isWatchModelOptionChecked(groupModels, option);
                                      return (
                                        <label
                                          key={`${option}-multi`}
                                          className="flex items-center gap-2 text-xs py-1"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={e => {
                                              const next = new Set(groupModels);
                                              if (e.target.checked) next.add(option);
                                              else next.delete(option);
                                              const list = Array.from(next);
                                              updateWatchItem(idx, {
                                                model: list[0] ?? "",
                                                models: list
                                              });
                                            }}
                                          />
                                          <span>{option}</span>
                                        </label>
                                      );
                                    }) : (
                                      <div className="text-xs text-gray-500">No models match search.</div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="text-xs text-gray-500">No models for that year.</div>
                                )}
                                <div className="mt-2">
                                  <div className="text-xs text-gray-500 mb-1">Other model (optional)</div>
                                  <div className="flex gap-2">
                                    <input
                                      className="border rounded px-2 py-2 text-sm w-full"
                                      placeholder="Type model"
                                      value={item.customModel ?? ""}
                                      onChange={e => updateWatchItem(idx, { customModel: e.target.value })}
                                    />
                                    <button
                                      type="button"
                                      className="px-3 py-2 border rounded text-sm"
                                      onClick={() => {
                                        const value = (item.customModel ?? "").trim();
                                        if (!value) return;
                                        const next = new Set(groupModels);
                                        next.add(value);
                                        const list = Array.from(next);
                                        updateWatchItem(idx, {
                                          model: list[0] ?? "",
                                          models: list,
                                          customModel: ""
                                        });
                                      }}
                                    >
                                      Add
                                    </button>
                                  </div>
                                </div>
                              </div>
                              <div>
                                <div className="text-xs text-gray-500 mb-1">Trim/Finish</div>
                                <input
                                  className="border rounded px-2 py-2 text-sm w-full"
                                  placeholder="Special, ST, Chrome trim…"
                                  value={item.trim}
                                  onChange={e => updateWatchItem(idx, { trim: e.target.value })}
                                />
                              </div>
                              <div>
                                <div className="text-xs text-gray-500 mb-1">Color</div>
                                <input
                                  className="border rounded px-2 py-2 text-sm w-full"
                                  placeholder="Vivid Black"
                                  value={item.color}
                                  onChange={e => updateWatchItem(idx, { color: e.target.value })}
                                />
                              </div>
                              <div>
                                <div className="text-xs text-gray-500 mb-1">Min Price (optional)</div>
                                <input
                                  className="border rounded px-2 py-2 text-sm w-full"
                                  placeholder="$4,000"
                                  value={item.minPrice}
                                  onChange={e => updateWatchItem(idx, { minPrice: e.target.value })}
                                />
                              </div>
                              <div>
                                <div className="text-xs text-gray-500 mb-1">Max Price (optional)</div>
                                <input
                                  className="border rounded px-2 py-2 text-sm w-full"
                                  placeholder="$5,000"
                                  value={item.maxPrice}
                                  onChange={e => updateWatchItem(idx, { maxPrice: e.target.value })}
                                />
                              </div>
                            </div>
                            {cadenceWatchItems.length > 1 ? (
                              <div className="mt-2 text-right">
                                <button
                                  className="text-xs text-red-600"
                                  onClick={() => removeWatchItem(idx)}
                                >
                                  Remove
                                </button>
                              </div>
                            ) : null}
                          </div>
                          );
                        })}
                        <button
                          className="px-3 py-2 border rounded text-sm"
                          onClick={addWatchItem}
                        >
                          Add another model
                        </button>
                        <div>
                          <div className="text-xs text-gray-500 mb-1">Note (optional)</div>
                          <textarea
                            className="border rounded px-3 py-2 text-sm w-full"
                            rows={2}
                            value={cadenceWatchNote}
                            onChange={e => setCadenceWatchNote(e.target.value)}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {cadenceResolveError ? (
                    <div className="text-xs text-red-600 mt-2">{cadenceResolveError}</div>
                  ) : null}

                  <div className="mt-4 flex justify-end gap-2 sticky bottom-0 bg-white pt-3 border-t -mx-3 sm:-mx-4 px-3 sm:px-4">
                    <button
                      className="px-3 py-2 border rounded text-sm"
                      onClick={() => setCadenceResolveOpen(false)}
                      disabled={cadenceResolveSaving}
                    >
                      Cancel
                    </button>
                    <button
                      className="px-3 py-2 border rounded text-sm"
                      onClick={submitCadenceResolve}
                      disabled={cadenceResolveSaving}
                    >
                      {cadenceResolveSaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
                </div>
              </div>
            ) : null}

            {holdModalOpen ? (
              <div className="fixed inset-0 z-50 bg-black/40 overflow-y-auto">
                <div className="min-h-full flex items-start sm:items-center justify-center p-2 sm:p-4">
                <div className="w-full max-w-2xl max-h-[94vh] overflow-y-auto rounded-lg bg-white shadow-lg border p-3 sm:p-4">
                  <div className="text-sm font-semibold">Mark bike on hold</div>
                  <div className="text-xs text-gray-600 mt-1">
                    {holdModalConv?.lead?.name ||
                      [holdModalConv?.lead?.firstName, holdModalConv?.lead?.lastName]
                        .filter(Boolean)
                        .join(" ") ||
                      holdModalConv?.leadKey}
                    {holdModalConv?.lead?.phone ? ` • ${holdModalConv.lead.phone}` : ""}
                  </div>
                  {(holdModalConv?.hold ||
                    holdModalConv?.followUpCadence?.pauseReason === "unit_hold" ||
                    holdModalConv?.followUpCadence?.pauseReason === "order_hold" ||
                    holdModalConv?.followUpCadence?.stopReason === "unit_hold" ||
                    holdModalConv?.followUpCadence?.stopReason === "order_hold" ||
                    holdModalConv?.followUp?.reason === "order_hold" ||
                    holdModalConv?.followUp?.reason === "unit_hold") ? (
                    <div className="text-xs text-gray-500 mt-2">
                      Current hold:{" "}
                      {holdModalConv?.hold?.onOrder
                        ? `Bike on order${holdModalConv?.hold?.label ? ` • ${holdModalConv.hold.label}` : ""}`
                        : holdModalConv?.hold?.label ??
                          holdModalConv?.hold?.stockId ??
                          holdModalConv?.hold?.vin ??
                          "Unit hold active"}
                    </div>
                  ) : null}

                  <div className="mt-3">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={holdOnOrder}
                        onChange={e => {
                          const checked = e.target.checked;
                          setHoldOnOrder(checked);
                          if (checked) setHoldSelection(null);
                        }}
                      />
                      <span>Bike on order (not in stock yet)</span>
                    </label>
                  </div>

                  {holdOnOrder ? (
                    <div className="mt-3">
                      <div className="text-xs text-gray-500 mb-1">Bike label (optional)</div>
                      <input
                        className="border rounded px-3 py-2 text-sm w-full"
                        placeholder="2026 Harley-Davidson Street Glide"
                        value={holdOnOrderLabel}
                        onChange={e => setHoldOnOrderLabel(e.target.value)}
                      />
                    </div>
                  ) : null}

                  <div className="mt-3">
                    <div className="text-xs text-gray-500 mb-1">Search inventory</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      placeholder="Search by model, stock, VIN, color..."
                      value={holdSearch}
                      onChange={e => setHoldSearch(e.target.value)}
                      disabled={holdOnOrder}
                    />
                  </div>

                  <div className="mt-3 max-h-64 overflow-auto border rounded">
                    {holdOnOrder ? (
                      <div className="p-3 text-sm text-gray-500">
                        Inventory selection disabled while Bike on order is enabled.
                      </div>
                    ) : holdInventoryLoading ? (
                      <div className="p-3 text-sm text-gray-500">Loading inventory…</div>
                    ) : holdInventoryItems.length === 0 ? (
                      <div className="p-3 text-sm text-gray-500">No inventory items found.</div>
                    ) : (
                      holdInventoryItems
                        .filter((it: any) => {
                          if (!holdSearch.trim()) return true;
                          const q = holdSearch.trim().toLowerCase();
                          const hay = [
                            it.year,
                            it.make,
                            it.model,
                            it.trim,
                            it.color,
                            it.stockId,
                            it.vin
                          ]
                            .filter(Boolean)
                            .join(" ")
                            .toLowerCase();
                          return hay.includes(q);
                        })
                        .slice(0, 60)
                        .map((it: any) => {
                          const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
                          const selectedKey = String(holdSelection?.stockId ?? holdSelection?.vin ?? "")
                            .trim()
                            .toLowerCase();
                          const isSelected = key && key === selectedKey;
                          const label = [it.year, it.make, it.model, it.trim].filter(Boolean).join(" ");
                          const color = it.color ? ` • ${it.color}` : "";
                          const preview =
                            Array.isArray(it.images) && it.images.length ? it.images[0] : null;
                          return (
                            <button
                              key={key || label}
                              className={`w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-gray-50 ${
                                isSelected ? "bg-blue-50" : ""
                              }`}
                              onClick={() => setHoldSelection(it)}
                              type="button"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-3 min-w-0">
                                  {preview ? (
                                    <div className="shrink-0 w-16 h-12 sm:w-20 sm:h-14 rounded border border-gray-200 bg-gray-50 overflow-hidden">
                                      <img
                                        src={preview}
                                        alt={`${label || it.model || "Unit"} preview`}
                                        className="w-full h-full object-contain"
                                      />
                                    </div>
                                  ) : null}
                                  <div className="text-sm min-w-0">
                                  <div className="font-medium">
                                    {label || it.model || it.stockId || it.vin}
                                    {color}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    {it.stockId ? `Stock ${it.stockId}` : ""}
                                    {it.stockId && it.vin ? " • " : ""}
                                    {it.vin ? `VIN ${it.vin}` : ""}
                                  </div>
                                </div>
                                </div>
                                {it.hold ? (
                                  <span className="text-[11px] px-2 py-0.5 rounded-full border bg-red-100 text-red-700 border-red-200">
                                    Held
                                  </span>
                                ) : null}
                              </div>
                            </button>
                          );
                        })
                    )}
                  </div>

                  <div className="mt-3">
                    <div className="text-xs text-gray-500 mb-1">Note (optional)</div>
                    <textarea
                      className="border rounded px-3 py-2 text-sm w-full"
                      rows={2}
                      value={holdNote}
                      onChange={e => setHoldNote(e.target.value)}
                      placeholder="Deposit received, hold requested…"
                    />
                  </div>

                  {holdError ? <div className="text-xs text-red-600 mt-2">{holdError}</div> : null}

                  <div className="mt-4 flex items-center justify-between">
                    <div className="text-xs text-gray-500">
                      {holdOnOrder
                        ? `Bike on order${holdOnOrderLabel?.trim() ? `: ${holdOnOrderLabel.trim()}` : ""}`
                        : holdSelection
                        ? `Selected: ${[holdSelection.year, holdSelection.make, holdSelection.model, holdSelection.trim]
                            .filter(Boolean)
                            .join(" ") || holdSelection.stockId || holdSelection.vin}`
                        : "No unit selected"}
                    </div>
                    <div className="flex gap-2">
                      {holdModalConv?.hold ||
                      holdModalConv?.followUpCadence?.pauseReason === "unit_hold" ||
                      holdModalConv?.followUpCadence?.pauseReason === "order_hold" ||
                      holdModalConv?.followUpCadence?.stopReason === "unit_hold" ||
                      holdModalConv?.followUpCadence?.stopReason === "order_hold" ||
                      holdModalConv?.followUp?.reason === "order_hold" ||
                      holdModalConv?.followUp?.reason === "unit_hold" ? (
                        <button
                          className="px-3 py-2 border rounded text-sm text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => submitHold(null, "hold_clear")}
                          disabled={holdSaving}
                        >
                          Remove hold
                        </button>
                      ) : null}
                      <button
                        className="px-3 py-2 border rounded text-sm"
                        onClick={() => setHoldModalOpen(false)}
                        disabled={holdSaving}
                      >
                        Cancel
                      </button>
                      <button
                        className="px-3 py-2 border rounded text-sm"
                        onClick={() => submitHold(holdSelection, "hold")}
                        disabled={holdSaving}
                      >
                        {holdSaving ? "Saving…" : "Save hold"}
                      </button>
                    </div>
                  </div>
                </div>
                </div>
              </div>
            ) : null}

            {holdDetailsOpen && selectedConv ? (
              <div className="fixed inset-0 z-50 bg-black/40 overflow-y-auto">
                <div className="min-h-full flex items-start sm:items-center justify-center p-2 sm:p-4">
                  <div className="w-full max-w-xl rounded-lg bg-white shadow-lg border border-slate-200 p-3 sm:p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">Bike on hold</div>
                        <div className="mt-1 text-xs text-slate-700">
                          {selectedConv.lead?.name ||
                            [selectedConv.lead?.firstName, selectedConv.lead?.lastName]
                              .filter(Boolean)
                              .join(" ") ||
                            selectedConv.leadKey}
                          {selectedConv.lead?.phone ? ` • ${selectedConv.lead.phone}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="px-3 py-2 border rounded text-sm text-slate-800 border-slate-300 bg-white hover:bg-slate-50"
                        onClick={() => setHoldDetailsOpen(false)}
                      >
                        Close
                      </button>
                    </div>

                    {(() => {
                      const hold = selectedConv.hold ?? null;
                      const holdLabel = String(hold?.label ?? "").trim();
                      const holdParts = [hold?.year, hold?.make, hold?.model, hold?.trim]
                        .map(v => String(v ?? "").trim())
                        .filter(Boolean);
                      const holdColor = String(hold?.color ?? "").trim();
                      const holdStockId = String(hold?.stockId ?? "").trim();
                      const holdVin = String(hold?.vin ?? "").trim();
                      const holdNote = String(hold?.note ?? "").trim();
                      const holdUntil = String(
                        hold?.until ??
                          selectedConv.followUpCadence?.pausedUntil ??
                          ""
                      ).trim();
                      const holdUpdatedAt = String(hold?.updatedAt ?? hold?.createdAt ?? "").trim();
                      const holdReason = String(
                        hold?.reason ??
                          selectedConv.followUpCadence?.pauseReason ??
                          selectedConv.followUpCadence?.stopReason ??
                          selectedConv.followUp?.reason ??
                          ""
                      )
                        .trim()
                        .replace(/_/g, " ");
                      const combinedLabel = holdParts.length
                        ? holdColor
                          ? `${holdParts.join(" ")} (${holdColor})`
                          : holdParts.join(" ")
                        : "";
                      const primaryLabel = holdLabel || combinedLabel || holdStockId || holdVin;
                      const hasAnyHoldField =
                        !!primaryLabel ||
                        !!holdUntil ||
                        !!holdReason ||
                        !!holdUpdatedAt ||
                        !!holdNote ||
                        !!hold?.onOrder;
                      const detailRows = [
                        { key: "Year", value: String(hold?.year ?? "").trim() },
                        { key: "Make", value: String(hold?.make ?? "").trim() },
                        { key: "Model", value: String(hold?.model ?? "").trim() },
                        { key: "Trim", value: String(hold?.trim ?? "").trim() },
                        { key: "Color", value: holdColor },
                        { key: "Stock #", value: holdStockId },
                        { key: "VIN", value: holdVin },
                        { key: "Hold Until", value: holdUntil ? formatCadenceDate(holdUntil) : "" },
                        { key: "Type", value: hold?.onOrder ? "Bike on order" : "" },
                        { key: "Reason", value: holdReason },
                        {
                          key: "Updated",
                          value: holdUpdatedAt ? new Date(holdUpdatedAt).toLocaleString() : ""
                        }
                      ].filter(row => row.value);
                      if (!hasAnyHoldField) {
                        return (
                          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            No hold-unit details are saved yet for this conversation.
                          </div>
                        );
                      }
                      return (
                        <div className="mt-3">
                          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                              Hold Unit
                            </div>
                            <div className="mt-1 text-sm font-semibold text-slate-900 break-words">
                              {primaryLabel || (hold?.onOrder ? "Bike on order" : "Hold active")}
                            </div>
                          </div>
                          {detailRows.length ? (
                            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {detailRows.map(row => (
                                <div
                                  key={row.key}
                                  className="rounded border border-slate-200 bg-white px-3 py-2"
                                >
                                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                                    {row.key}
                                  </div>
                                  <div className="mt-1 text-sm font-medium text-slate-900 break-words">
                                    {row.value}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {holdNote ? (
                            <div className="mt-3 rounded border border-slate-200 bg-white px-3 py-2">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                                Notes
                              </div>
                              <div className="mt-1 text-sm text-slate-900 whitespace-pre-wrap">
                                {holdNote}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : null}

            {soldDetailsOpen && selectedConv ? (
              <div className="fixed inset-0 z-50 bg-black/40 overflow-y-auto">
                <div className="min-h-full flex items-start sm:items-center justify-center p-2 sm:p-4">
                  <div className="w-full max-w-xl rounded-lg bg-white shadow-lg border border-slate-200 p-3 sm:p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">Purchased motorcycle</div>
                        <div className="mt-1 text-xs text-slate-700">
                          {selectedConv.lead?.name ||
                            [selectedConv.lead?.firstName, selectedConv.lead?.lastName]
                              .filter(Boolean)
                              .join(" ") ||
                            selectedConv.leadKey}
                          {selectedConv.lead?.phone ? ` • ${selectedConv.lead.phone}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="px-3 py-2 border rounded text-sm text-slate-800 border-slate-300 bg-white hover:bg-slate-50"
                        onClick={() => setSoldDetailsOpen(false)}
                      >
                        Close
                      </button>
                    </div>

                    {(() => {
                      const sale = selectedConv.sale ?? null;
                      const saleLabel = String(sale?.label ?? "").trim();
                      const saleParts = [sale?.year, sale?.make, sale?.model, sale?.trim]
                        .map(v => String(v ?? "").trim())
                        .filter(Boolean);
                      const saleColor = String(sale?.color ?? "").trim();
                      const saleStockId = String(sale?.stockId ?? "").trim();
                      const saleVin = String(sale?.vin ?? "").trim();
                      const saleSoldAt = String(sale?.soldAt ?? "").trim();
                      const saleSoldBy = String(sale?.soldByName ?? sale?.soldById ?? "").trim();
                      const saleNote = String(sale?.note ?? "").trim();
                      const combinedLabel = saleParts.length
                        ? saleColor
                          ? `${saleParts.join(" ")} (${saleColor})`
                          : saleParts.join(" ")
                        : "";
                      const primaryLabel = saleLabel || combinedLabel || saleStockId || saleVin;
                      const hasAnySaleField =
                        !!primaryLabel || !!saleSoldAt || !!saleSoldBy || !!saleNote;
                      const detailRows = [
                        { key: "Year", value: String(sale?.year ?? "").trim() },
                        { key: "Make", value: String(sale?.make ?? "").trim() },
                        { key: "Model", value: String(sale?.model ?? "").trim() },
                        { key: "Trim", value: String(sale?.trim ?? "").trim() },
                        { key: "Color", value: saleColor },
                        { key: "Stock #", value: saleStockId },
                        { key: "VIN", value: saleVin },
                        {
                          key: "Sold At",
                          value: saleSoldAt ? new Date(saleSoldAt).toLocaleString() : ""
                        },
                        { key: "Sold By", value: saleSoldBy }
                      ].filter(row => row.value);
                      if (!hasAnySaleField) {
                        return (
                          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            No sold-unit details are saved yet for this conversation.
                          </div>
                        );
                      }
                      return (
                        <div className="mt-3">
                          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                              Motorcycle
                            </div>
                            <div className="mt-1 text-sm font-semibold text-slate-900 break-words">
                              {primaryLabel}
                            </div>
                          </div>
                          {detailRows.length ? (
                            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {detailRows.map(row => (
                                <div
                                  key={row.key}
                                  className="rounded border border-slate-200 bg-white px-3 py-2"
                                >
                                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                                    {row.key}
                                  </div>
                                  <div className="mt-1 text-sm font-medium text-slate-900 break-words">
                                    {row.value}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {saleNote ? (
                            <div className="mt-3 rounded border border-slate-200 bg-white px-3 py-2">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                                Notes
                              </div>
                              <div className="mt-1 text-sm text-slate-900 whitespace-pre-wrap">
                                {saleNote}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : null}

            {soldModalOpen ? (
              <div className="fixed inset-0 z-50 bg-black/40 overflow-y-auto">
                <div className="min-h-full flex items-start sm:items-center justify-center p-2 sm:p-4">
                <div className="w-full max-w-2xl max-h-[94vh] overflow-y-auto rounded-lg bg-white shadow-lg border p-3 sm:p-4">
                  <div className="text-sm font-semibold">Mark unit sold</div>
                  <div className="text-xs text-gray-600 mt-1">
                    {soldModalConv?.lead?.name ||
                      [soldModalConv?.lead?.firstName, soldModalConv?.lead?.lastName]
                        .filter(Boolean)
                        .join(" ") ||
                      soldModalConv?.leadKey}
                    {soldModalConv?.lead?.phone ? ` • ${soldModalConv.lead.phone}` : ""}
                  </div>
                  {soldModalConv?.sale?.label ||
                  soldModalConv?.sale?.stockId ||
                  soldModalConv?.sale?.vin ? (
                    <div className="text-xs text-gray-500 mt-2">
                      Current sold:{" "}
                      {soldModalConv?.sale?.label ??
                        soldModalConv?.sale?.stockId ??
                        soldModalConv?.sale?.vin}
                    </div>
                  ) : null}

                  <div className="mt-3">
                    <div className="text-xs text-gray-500 mb-1">Search inventory</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      placeholder="Search by model, stock, VIN, color..."
                      value={soldSearch}
                      onChange={e => setSoldSearch(e.target.value)}
                    />
                  </div>

                  <div className="mt-3 max-h-64 overflow-auto border rounded">
                    {soldInventoryLoading ? (
                      <div className="p-3 text-sm text-gray-500">Loading inventory…</div>
                    ) : soldInventoryItems.length === 0 ? (
                      <div className="p-3 text-sm text-gray-500">No inventory items found.</div>
                    ) : (
                      soldInventoryItems
                        .filter((it: any) => {
                          if (!soldSearch.trim()) return true;
                          const q = soldSearch.trim().toLowerCase();
                          const hay = [
                            it.year,
                            it.make,
                            it.model,
                            it.trim,
                            it.color,
                            it.stockId,
                            it.vin
                          ]
                            .filter(Boolean)
                            .join(" ")
                            .toLowerCase();
                          return hay.includes(q);
                        })
                        .slice(0, 60)
                        .map((it: any) => {
                          const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
                          const selectedKey = String(soldSelection?.stockId ?? soldSelection?.vin ?? "")
                            .trim()
                            .toLowerCase();
                          const isSelected = key && key === selectedKey;
                          const label = [it.year, it.make, it.model, it.trim].filter(Boolean).join(" ");
                          const color = it.color ? ` • ${it.color}` : "";
                          const preview =
                            Array.isArray(it.images) && it.images.length ? it.images[0] : null;
                          return (
                            <button
                              key={key || label}
                              className={`w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-gray-50 ${
                                isSelected ? "bg-blue-50" : ""
                              }`}
                              onClick={() => setSoldSelection(it)}
                              type="button"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-3 min-w-0">
                                  {preview ? (
                                    <div className="shrink-0 w-16 h-12 sm:w-20 sm:h-14 rounded border border-gray-200 bg-gray-50 overflow-hidden">
                                      <img
                                        src={preview}
                                        alt={`${label || it.model || "Unit"} preview`}
                                        className="w-full h-full object-contain"
                                      />
                                    </div>
                                  ) : null}
                                  <div className="text-sm min-w-0">
                                  <div className="font-medium">
                                    {label || it.model || it.stockId || it.vin}
                                    {color}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    {it.stockId ? `Stock ${it.stockId}` : ""}
                                    {it.stockId && it.vin ? " • " : ""}
                                    {it.vin ? `VIN ${it.vin}` : ""}
                                  </div>
                                </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  {it.hold ? (
                                    <span className="text-[11px] px-2 py-0.5 rounded-full border bg-red-100 text-red-700 border-red-200">
                                      Held
                                    </span>
                                  ) : null}
                                  {it.sold ? (
                                    <span className="text-[11px] px-2 py-0.5 rounded-full border bg-blue-100 text-blue-700 border-blue-200">
                                      Sold
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            </button>
                          );
                        })
                    )}
                  </div>

                  <div className="mt-3">
                    <button
                      type="button"
                      className="text-xs text-blue-700 underline"
                      onClick={() => setSoldManualOpen(v => !v)}
                    >
                      {soldManualOpen ? "Hide manual unit entry" : "Add unit manually"}
                    </button>
                  </div>
                  {soldManualOpen ? (
                    <div className="mt-2 grid gap-2 grid-cols-2 text-xs">
                      <input
                        className="border rounded px-2 py-1"
                        placeholder="Year"
                        value={soldManualUnit.year ?? ""}
                        onChange={e => setSoldManualUnit((prev: any) => ({ ...prev, year: e.target.value }))}
                      />
                      <input
                        className="border rounded px-2 py-1"
                        placeholder="Make"
                        value={soldManualUnit.make ?? ""}
                        onChange={e => setSoldManualUnit((prev: any) => ({ ...prev, make: e.target.value }))}
                      />
                      <input
                        className="border rounded px-2 py-1"
                        placeholder="Model"
                        value={soldManualUnit.model ?? ""}
                        onChange={e => setSoldManualUnit((prev: any) => ({ ...prev, model: e.target.value }))}
                      />
                      <input
                        className="border rounded px-2 py-1"
                        placeholder="Trim"
                        value={soldManualUnit.trim ?? ""}
                        onChange={e => setSoldManualUnit((prev: any) => ({ ...prev, trim: e.target.value }))}
                      />
                      <input
                        className="border rounded px-2 py-1"
                        placeholder="Color"
                        value={soldManualUnit.color ?? ""}
                        onChange={e => setSoldManualUnit((prev: any) => ({ ...prev, color: e.target.value }))}
                      />
                      <input
                        className="border rounded px-2 py-1"
                        placeholder="Stock #"
                        value={soldManualUnit.stockId ?? ""}
                        onChange={e => setSoldManualUnit((prev: any) => ({ ...prev, stockId: e.target.value }))}
                      />
                      <input
                        className="border rounded px-2 py-1 col-span-2"
                        placeholder="VIN"
                        value={soldManualUnit.vin ?? ""}
                        onChange={e => setSoldManualUnit((prev: any) => ({ ...prev, vin: e.target.value }))}
                      />
                      <div className="col-span-2 text-[11px] text-gray-500">
                        Stock # or VIN is required to save a sold unit.
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-3">
                    <div className="text-xs text-gray-500 mb-1">Note (optional)</div>
                    <textarea
                      className="border rounded px-3 py-2 text-sm w-full"
                      rows={2}
                      value={soldNote}
                      onChange={e => setSoldNote(e.target.value)}
                      placeholder="Sold details (optional)…"
                    />
                  </div>

                  {soldError ? <div className="text-xs text-red-600 mt-2">{soldError}</div> : null}

                  <div className="mt-4 flex items-center justify-between">
                    <div className="text-xs text-gray-500">
                      {soldSelection
                        ? `Selected: ${[soldSelection.year, soldSelection.make, soldSelection.model, soldSelection.trim]
                            .filter(Boolean)
                            .join(" ") || soldSelection.stockId || soldSelection.vin}`
                        : (() => {
                            const resolved = resolveSoldSelection();
                            return resolved
                              ? `Manual: ${[resolved.year, resolved.make, resolved.model, resolved.trim]
                                  .filter(Boolean)
                                  .join(" ") || resolved.stockId || resolved.vin}`
                              : "No unit selected";
                          })()}
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="px-3 py-2 border rounded text-sm"
                        onClick={() => setSoldModalOpen(false)}
                        disabled={soldSaving}
                      >
                        Cancel
                      </button>
                      <button
                        className="px-3 py-2 border rounded text-sm"
                        onClick={() => submitSold(soldSelection)}
                        disabled={soldSaving}
                      >
                        {soldSaving ? "Saving…" : "Save sold"}
                      </button>
                    </div>
                  </div>
                </div>
                </div>
              </div>
            ) : null}

            {pendingDraft ? (
              <div className="mt-4 border rounded-lg p-3 text-sm">
                <div className="font-medium">Draft ready to send</div>
                <div className="text-gray-600 mt-1">
                  The reply box below is prefilled. Edit if needed, then hit Send.
                </div>
              </div>
            ) : null}

            <div className="mt-6 border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <button
                    className={`px-2 py-1 border rounded text-xs ${messageFilter === "sms" ? "font-semibold bg-gray-100" : ""}`}
                    onClick={() => setMessageFilter("sms")}
                  >
                    SMS
                  </button>
                  <button
                    className={`px-2 py-1 border rounded text-xs ${messageFilter === "email" ? "font-semibold bg-gray-100" : ""}`}
                    onClick={() => setMessageFilter("email")}
                  >
                    Email
                  </button>
                  <button
                    className={`px-2 py-1 border rounded text-xs ${messageFilter === "calls" ? "font-semibold bg-gray-100" : ""}`}
                    onClick={() => setMessageFilter("calls")}
                  >
                    Calls
                  </button>
                </div>
                <button
                  className="px-2 py-1 border rounded text-xs hover:bg-gray-50"
                  onClick={printCurrentConversationWindow}
                  disabled={!filteredMessages.length}
                  title="Print"
                  aria-label={`Print ${messageFilter === "calls" ? "Call Script" : messageFilter === "email" ? "Email" : "SMS"} conversation`}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <path d="M6 9V2h12v7" />
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v5a2 2 0 0 1-2 2h-2" />
                    <rect x="6" y="14" width="12" height="8" />
                  </svg>
                </button>
              </div>
              {messageFilter === "sms" && selectedConv.contactPreference === "call_only" ? (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                  Call only — SMS disabled.
                  <button
                    className="ml-2 underline"
                    onClick={clearContactPreference}
                  >
                    Allow SMS
                  </button>
                </div>
              ) : null}
              {messageFilter === "email" &&
              !String(selectedConv?.lead?.email ?? "")
                .trim()
                .includes("@") ? (
                <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  No email address on this lead. Email send is disabled until an email is added.
                </div>
              ) : null}
              {filteredMessages.map(m => {
                  const isDraftMessage = m.direction === "out" && m.provider === "draft_ai";
                  const isPending = pendingDraft?.id === m.id;
                  const providerLabel =
                    m.provider === "voice_call"
                      ? "call"
                      : m.provider === "voice_transcript"
                        ? "call transcript"
                        : m.provider === "voice_summary"
                        ? "call summary"
                        : (m.provider ?? "?");
                  const isSummary = m.provider === "voice_summary";
                  if (isSummary) return null;
                  const summaryText = (() => {
                    if (m.provider !== "voice_transcript") return null;
                    const id = m.providerMessageId ?? "";
                    if (id && callSummaryLookup.byId.has(id)) {
                      return callSummaryLookup.byId.get(id) ?? null;
                    }
                    const idxFull = callSummaryLookup.indexById.get(m.id);
                    if (idxFull == null) return null;
                    const prev = callSummaryLookup.full[idxFull - 1];
                    const next = callSummaryLookup.full[idxFull + 1];
                    if (prev?.provider === "voice_summary") return prev.body ?? null;
                    if (next?.provider === "voice_summary") return next.body ?? null;
                    return null;
                  })();
                  const messageBody =
                    m.direction === "in" && m.provider === "sendgrid"
                      ? cleanInboundEmailForDisplay(m.body)
                      : m.direction === "in" && m.provider === "sendgrid_adf"
                        ? cleanAdfLeadForDisplay(m.body)
                        : m.body;
                  const canRateMessage =
                    m.direction === "out" &&
                    (m.provider === "draft_ai" ||
                      m.provider === "twilio" ||
                      m.provider === "sendgrid" ||
                      m.provider === "human");
                  const feedback = m.feedback;
                  const feedbackBusy = !!messageFeedbackBusy[m.id];
                  const ratedUp = feedback?.rating === "up";
                  const ratedDown = feedback?.rating === "down";
                  return (
                    <div key={m.id} className={`text-sm ${m.direction === "in" || isSummary ? "" : "text-right"}`}>
                      <div className="text-xs text-gray-500">
                        {m.direction.toUpperCase()} • {providerLabel} •{" "}
                        {new Date(m.at).toLocaleString()}
                        {isDraftMessage ? " • DRAFT (not sent)" : ""}
                        {!isDraftMessage && isPending ? " • DRAFT (not sent)" : ""}
                      </div>
                      <div
                        className={`inline-block mt-1 px-3 py-2 rounded-2xl border max-w-[85%] whitespace-pre-wrap break-words text-base font-medium ${
                          isSummary
                            ? "bg-gray-50 text-gray-800 border-gray-200"
                            : m.direction === "in"
                              ? "bg-gray-100 text-gray-900 border-gray-200"
                              : "bg-blue-600 text-white border-blue-600"
                        }`}
                      >
                        {renderMessageBody(messageBody)}
                      </div>
                      {m.provider === "voice_transcript" ? (
                        <div className="mt-2 text-xs text-gray-600">
                          {summaryText ? (
                            <>
                              <button
                                className="underline"
                                onClick={() =>
                                  setExpandedCallSummaries(prev => ({
                                    ...prev,
                                    [m.id]: !prev[m.id]
                                  }))
                                }
                              >
                                {expandedCallSummaries[m.id] ? "Hide call summary" : "Show call summary"}
                              </button>
                              {expandedCallSummaries[m.id] ? (
                                <div className="mt-2 px-3 py-2 rounded-xl border bg-gray-50 text-gray-800 border-gray-200">
                                  {summaryText}
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-gray-400">No summary yet.</span>
                          )}
                        </div>
                      ) : null}
                      {m.direction === "in" &&
                      (m.provider === "sendgrid_adf" || /web lead \\(adf\\)/i.test(m.body || "")) ? (
                        <div className="mt-1">
                          <a
                            className="text-xs text-blue-600 underline"
                            href={`/lead/${encodeURIComponent(selectedConv.id)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View lead
                          </a>
                        </div>
                      ) : null}
                      {m.mediaUrls && m.mediaUrls.length ? (
                        <div
                          className={`mt-2 flex flex-wrap gap-2 ${m.direction === "in" ? "" : "justify-end"}`}
                        >
                          {m.mediaUrls.map(url => {
                            const media = getMediaUrlInfo(url);
                            if (media.isImage) {
                              return (
                                <img
                                  key={url}
                                  src={url}
                                  alt="MMS image attachment"
                                  className="max-w-[240px] rounded border"
                                  loading="lazy"
                                />
                              );
                            }
                            return (
                              <a
                                key={url}
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs rounded border px-2 py-1 bg-white hover:bg-gray-50 text-blue-700 underline"
                                title={media.fileName}
                              >
                                {media.isPdf ? "Open PDF attachment" : "Open attachment"}
                              </a>
                            );
                          })}
                        </div>
                      ) : null}
                      {canRateMessage ? (
                        <div className={`mt-1 flex items-center gap-1 ${m.direction === "in" ? "" : "justify-end"}`}>
                          <button
                            type="button"
                            disabled={feedbackBusy}
                            onClick={() => void submitMessageFeedback(m.id, "up")}
                            className={`text-xs border rounded px-2 py-0.5 ${
                              ratedUp ? "bg-green-100 border-green-300" : "hover:bg-gray-50"
                            } ${feedbackBusy ? "opacity-50 cursor-not-allowed" : ""}`}
                            title={ratedUp ? "Remove helpful vote" : "Mark helpful"}
                          >
                            👍
                          </button>
                          <button
                            type="button"
                            disabled={feedbackBusy}
                            onClick={() => void submitMessageFeedback(m.id, "down")}
                            className={`text-xs border rounded px-2 py-0.5 ${
                              ratedDown ? "bg-red-100 border-red-300" : "hover:bg-gray-50"
                            } ${feedbackBusy ? "opacity-50 cursor-not-allowed" : ""}`}
                            title={ratedDown ? "Remove needs work vote" : "Mark needs work"}
                          >
                            👎
                          </button>
                          {feedback?.rating ? (
                            <span className="text-[11px] text-gray-500" title={feedback.note ?? feedback.reason ?? ""}>
                              {feedback.rating === "up" ? "Helpful" : "Needs work"}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              {detailLoading || regenBusy || composeSending || inboundProcessing || inboundProcessingFromList ? (
                <div className="text-sm">
                  <div className="text-xs text-gray-500">
                    {composeSending ? "OUT • sending" : "AI • thinking"}
                  </div>
                  <div className="inline-flex mt-1 items-center gap-2 px-3 py-2 rounded-2xl border bg-gray-100 text-gray-700 border-gray-200">
                    <span>{composeSending ? "Sending" : "Thinking"}</span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-gray-500 animate-pulse" />
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-gray-500 animate-pulse"
                        style={{ animationDelay: "150ms" }}
                      />
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-gray-500 animate-pulse"
                        style={{ animationDelay: "300ms" }}
                      />
                    </span>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex gap-2 items-start">
              <textarea
                ref={sendBoxRef}
                value={displaySendBody}
                onChange={e => {
                  if (messageFilter === "calls") return;
                  setSendBody(e.target.value);
                  setSendBodySource("user");
                }}
                onInput={e => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                rows={1}
                className={`flex-1 border rounded px-3 py-3.5 min-h-[60px] resize-none leading-7 overflow-hidden box-border ${
                  messageFilter === "calls" ? "bg-gray-50 text-gray-500" : ""
                }`}
                placeholder={
                  messageFilter === "calls"
                    ? "Calls view only."
                    : messageFilter === "email" && emailManualMode
                      ? "Write a new email…"
                    : pendingDraft
                      ? "Edit draft then Send…"
                      : "Type a message…"
                }
                disabled={messageFilter === "calls"}
              />
              <div className="flex flex-col gap-2">
                <button
                  className={`px-4 py-2 border rounded ${
                    messageFilter === "calls" ||
                    composeSending ||
                    (messageFilter === "sms" && selectedConv.contactPreference === "call_only") ||
                    (messageFilter === "sms" && smsAttachmentsBusy) ||
                    (messageFilter === "email" && emailAttachmentsBusy) ||
                    (messageFilter === "email" &&
                      !String(selectedConv?.lead?.email ?? "")
                        .trim()
                        .includes("@"))
                      ? "opacity-50 cursor-not-allowed"
                      : ""
                  }`}
                  onClick={send}
                  disabled={
                    messageFilter === "calls" ||
                    composeSending ||
                    (messageFilter === "sms" && selectedConv.contactPreference === "call_only") ||
                    (messageFilter === "sms" && smsAttachmentsBusy) ||
                    (messageFilter === "email" && emailAttachmentsBusy) ||
                    (messageFilter === "email" &&
                      !String(selectedConv?.lead?.email ?? "")
                        .trim()
                        .includes("@"))
                  }
                >
                  {composeSending ? "Sending..." : "Send"}
                </button>
                {messageFilter === "email" ? (
                  emailManualMode ? (
                    <button
                      className="px-4 py-2 border rounded text-xs"
                      onClick={() => {
                        setEmailManualMode(false);
                        if (emailDraft) {
                          setSendBody(emailDraft);
                          setSendBodySource("draft");
                        }
                      }}
                    >
                      Use AI Draft
                    </button>
                  ) : (
                    <button
                      className="px-4 py-2 border rounded text-xs"
                      onClick={() => {
                        setEmailManualMode(true);
                        setSendBody("");
                        setSendBodySource("user");
                      }}
                    >
                      Draft New Email
                    </button>
                  )
                ) : null}
                {mode === "suggest" && selectedConv.mode !== "human" && messageFilter !== "calls" ? (
                  <button
                    className={`px-4 py-2 border rounded text-xs ${regenBusy ? "opacity-50 cursor-not-allowed" : ""}`}
                    onClick={regenerateDraft}
                    disabled={regenBusy}
                  >
                    Regenerate
                  </button>
                ) : null}
                {hasClearableDraft ? (
                  <button
                    className={`px-4 py-2 border rounded text-xs ${clearDraftBusy ? "opacity-50 cursor-not-allowed" : ""}`}
                    onClick={clearDraft}
                    disabled={clearDraftBusy}
                  >
                    Clear Draft
                  </button>
                ) : null}
              </div>
            </div>

            {messageFilter === "sms" ? (
              <div className="mt-2 flex flex-col gap-2">
                {smsAttachments.length ? (
                  <div className="flex flex-wrap gap-2">
                    {smsAttachments.map((att, idx) => (
                      <div
                        key={`${att.url}-${idx}`}
                        className="flex items-center gap-2 border rounded px-2 py-1 text-xs"
                      >
                        <span className="truncate max-w-[220px]">
                          {att.name}
                          {att.mode === "link" ? " (link)" : ""}
                        </span>
                        <button
                          type="button"
                          className="text-gray-500 hover:text-gray-800"
                          onClick={() => removeSmsAttachment(idx)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {smsAttachmentsBusy ? (
                  <div className="text-xs text-gray-500">Uploading media…</div>
                ) : null}
                {smsAttachments.some(att => att.mode === "link") ? (
                  <div className="text-xs text-gray-500">
                    Large files will be sent as links automatically.
                  </div>
                ) : null}
                <div>
                  <label className="inline-flex items-center gap-2 text-xs border rounded px-3 py-2 cursor-pointer hover:bg-gray-50">
                    Attach media
                    <input
                      type="file"
                      multiple
                      accept="image/*,video/*"
                      className="hidden"
                      onChange={e => handleSmsAttachments(e.target.files)}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {messageFilter === "email" ? (
              <div className="mt-2 flex flex-col gap-2">
                {emailAttachments.length ? (
                  <div className="flex flex-wrap gap-2">
                    {emailAttachments.map((att, idx) => (
                      <div
                        key={`${att.name}-${idx}`}
                        className="flex items-center gap-2 border rounded px-2 py-1 text-xs"
                      >
                        <span className="truncate max-w-[220px]">{att.name}</span>
                        <button
                          type="button"
                          className="text-gray-500 hover:text-gray-800"
                          onClick={() => removeEmailAttachment(idx)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {emailAttachmentsBusy ? (
                  <div className="text-xs text-gray-500">Adding attachments…</div>
                ) : null}
                <div>
                  <label className="inline-flex items-center gap-2 text-xs border rounded px-3 py-2 cursor-pointer hover:bg-gray-50">
                    Attach file
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={e => handleEmailAttachments(e.target.files)}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {editPromptOpen && pendingSend ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
                <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-4">
                  <div className="text-sm font-medium">Quick note for tuning (optional)</div>
                  <div className="text-xs text-gray-500 mt-1">
                    What should the agent do differently next time?
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[
                      "Too long",
                      "Wrong tone",
                      "Missing info",
                      "Wrong facts",
                      "Too pushy",
                      "Other"
                    ].map(tag => (
                      <button
                        key={tag}
                        className="px-2 py-1 border rounded text-xs"
                        onClick={() =>
                          setEditNote(prev => (prev ? `${prev}; ${tag}` : tag))
                        }
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="mt-3 w-full border rounded px-3 py-2 text-sm"
                    rows={3}
                    placeholder="Optional note…"
                    value={editNote}
                    onChange={e => setEditNote(e.target.value)}
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      className="px-3 py-2 border rounded text-sm"
                      onClick={() => {
                        setEditPromptOpen(false);
                        setPendingSend(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="px-3 py-2 border rounded text-sm"
                      onClick={async () => {
                        const note = editNote.trim();
                        const payload = pendingSend.draftId
                          ? {
                              ...pendingSend,
                              editNote: note,
                              attachments: pendingSend.channel === "email" ? emailAttachments : undefined,
                              mediaUrls: pendingSend.channel === "sms" ? pendingSend.mediaUrls : undefined
                            }
                          : {
                              body: pendingSend.body,
                              channel: pendingSend.channel,
                              editNote: note,
                              attachments: pendingSend.channel === "email" ? emailAttachments : undefined,
                              mediaUrls: pendingSend.channel === "sms" ? pendingSend.mediaUrls : undefined
                            };
                        setEditPromptOpen(false);
                        setPendingSend(null);
                        await doSend(payload);
                      }}
                    >
                      Send
                    </button>
                    <button
                      className="px-3 py-2 border rounded text-sm text-gray-600"
                      onClick={async () => {
                        const payload = pendingSend.draftId
                          ? {
                              ...pendingSend,
                              attachments: pendingSend.channel === "email" ? emailAttachments : undefined,
                              mediaUrls: pendingSend.channel === "sms" ? pendingSend.mediaUrls : undefined
                            }
                          : {
                              body: pendingSend.body,
                              channel: pendingSend.channel,
                              attachments: pendingSend.channel === "email" ? emailAttachments : undefined,
                              mediaUrls: pendingSend.channel === "sms" ? pendingSend.mediaUrls : undefined
                            };
                        setEditPromptOpen(false);
                        setPendingSend(null);
                        await doSend(payload);
                      }}
                    >
                      Skip note
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {selectedConv.status !== "closed" ? (
              <div className="mt-4 flex items-center gap-2">
                <select
                  className="border rounded px-2 py-2 text-sm"
                  value={closeReason}
                  onChange={e => setCloseReason(e.target.value)}
                >
                  <option value="">Update Lead...</option>
                  <option value="sold">Sold</option>
                  <option value="hold">Hold - Unit</option>
                  <option value="not_interested">Close - Not Interested</option>
                  <option value="no_response">Close - No Response</option>
                  <option value="other">Close - Other</option>
                </select>
                {closeReason === "sold" ? (
                  <select
                    className="border rounded px-2 py-2 text-sm"
                    value={soldById}
                    onChange={e => setSoldById(e.target.value)}
                  >
                    <option value="">Sold by…</option>
                    {soldByOptions.map(sp => (
                      <option key={sp.id} value={sp.id}>
                        {sp.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button className="px-3 py-2 border rounded text-sm" onClick={closeConv}>
                  Update
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm text-red-600 border-red-200 hover:bg-red-50"
                  onClick={deleteConv}
                >
                  Delete
                </button>
              </div>
            ) : (
              <div className="mt-4 flex items-center gap-2">
                <button className="px-3 py-2 border rounded text-sm" onClick={reopenConv}>
                  Re-open
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm text-red-600 border-red-200 hover:bg-red-50"
                  onClick={deleteConv}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="text-gray-500">Conversation not found.</div>
        )}
      </section>

      {composeOpen ? (
        <div className="fixed inset-0 z-50 flex items-start md:items-center justify-center bg-black/40 p-3 overflow-y-auto">
          <div className="w-full max-w-xl max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-lg bg-white shadow-lg border p-4">
            <div className="text-sm font-semibold">Compose SMS</div>
            <div className="mt-3">
              <div className="text-xs text-gray-500 mb-1">Phone</div>
              <input
                className="border rounded px-3 py-2 text-sm w-full"
                placeholder="+15551234567"
                value={composePhone}
                onChange={e => setComposePhone(e.target.value)}
              />
            </div>
            <div className="mt-3">
              <div className="text-xs text-gray-500 mb-1">Message</div>
              <textarea
                className="border rounded px-3 py-2 text-sm w-full"
                rows={3}
                value={composeBody}
                onChange={e => setComposeBody(e.target.value)}
                placeholder="Type your message…"
              />
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {composeSmsAttachments.length ? (
                <div className="flex flex-wrap gap-2">
                  {composeSmsAttachments.map((att, idx) => (
                    <div
                      key={`${att.name}-${att.size}-${idx}`}
                      className="flex items-center gap-2 border rounded px-2 py-1 text-xs"
                    >
                      <span className="truncate max-w-[220px]">
                        {att.name}
                        {att.size > 5 * 1024 * 1024 ? " (link)" : ""}
                      </span>
                      <button
                        type="button"
                        className="text-gray-500 hover:text-gray-800"
                        onClick={() => removeComposeSmsAttachment(idx)}
                        disabled={composeSending}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {composeSmsAttachmentsBusy ? (
                <div className="text-xs text-gray-500">Processing media…</div>
              ) : null}
              {composeSmsAttachments.some(att => att.size > 5 * 1024 * 1024) ? (
                <div className="text-xs text-gray-500">
                  Large files will be sent as links automatically.
                </div>
              ) : null}
              <div>
                <label className="inline-flex items-center gap-2 text-xs border rounded px-3 py-2 cursor-pointer hover:bg-gray-50">
                  Attach media
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    className="hidden"
                    disabled={composeSending}
                    onChange={e => {
                      void handleComposeSmsAttachments(e.target.files);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="mt-3">
              <button
                className="text-xs px-2 py-1 border rounded"
                onClick={() => setComposeShowDetails(v => !v)}
              >
                {composeShowDetails ? "Hide details" : "+ Add details"}
              </button>
            </div>

            {composeShowDetails ? (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-gray-500 mb-1">First name</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={composeFirstName}
                      onChange={e => setComposeFirstName(e.target.value)}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Last name</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={composeLastName}
                      onChange={e => setComposeLastName(e.target.value)}
                    />
                  </div>
                  <div className="col-span-2">
                    <div className="text-xs text-gray-500 mb-1">Email</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={composeEmail}
                      onChange={e => setComposeEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div className="text-xs font-semibold text-gray-700">Bike of interest</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Year</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={composeVehicle.year ?? ""}
                      onChange={e =>
                        setComposeVehicle((v: any) => ({ ...v, year: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Make</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={composeVehicle.make ?? ""}
                      onChange={e =>
                        setComposeVehicle((v: any) => ({ ...v, make: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Model</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={composeVehicle.model ?? ""}
                      onChange={e =>
                        setComposeVehicle((v: any) => ({ ...v, model: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Trim/Finish</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={composeVehicle.trim ?? ""}
                      onChange={e =>
                        setComposeVehicle((v: any) => ({ ...v, trim: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Color</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={composeVehicle.color ?? ""}
                      onChange={e =>
                        setComposeVehicle((v: any) => ({ ...v, color: e.target.value }))
                      }
                    />
                  </div>
                </div>

                <div>
                  <button
                    className="text-xs px-2 py-1 border rounded"
                    onClick={toggleComposeInventory}
                  >
                    {composeInventoryOpen ? "Hide inventory" : "Select from inventory"}
                  </button>
                </div>

                {composeInventoryOpen ? (
                  <div className="mt-2">
                    <div className="text-xs text-gray-500 mb-1">Search inventory</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      placeholder="Search by model, stock, VIN, color..."
                      value={composeSearch}
                      onChange={e => setComposeSearch(e.target.value)}
                    />
                    <div className="mt-2 max-h-56 overflow-auto border rounded">
                      {composeInventoryLoading ? (
                        <div className="p-3 text-sm text-gray-500">Loading inventory…</div>
                      ) : composeInventoryItems.length === 0 ? (
                        <div className="p-3 text-sm text-gray-500">No inventory items found.</div>
                      ) : (
                        composeInventoryItems
                          .filter((it: any) => {
                            if (!composeSearch.trim()) return true;
                            const q = composeSearch.trim().toLowerCase();
                            const hay = [
                              it.year,
                              it.make,
                              it.model,
                              it.trim,
                              it.color,
                              it.stockId,
                              it.vin
                            ]
                              .filter(Boolean)
                              .join(" ")
                              .toLowerCase();
                            return hay.includes(q);
                          })
                          .slice(0, 60)
                          .map((it: any) => {
                            const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
                            const selectedKey = String(
                              composeSelection?.stockId ?? composeSelection?.vin ?? ""
                            )
                              .trim()
                              .toLowerCase();
                            const isSelected = key && key === selectedKey;
                            const label = [it.year, it.make, it.model, it.trim].filter(Boolean).join(" ");
                            const color = it.color ? ` • ${it.color}` : "";
                            return (
                              <button
                                key={key || label}
                                className={`w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-gray-50 ${
                                  isSelected ? "bg-blue-50" : ""
                                }`}
                                onClick={() => applyComposeSelection(it)}
                                type="button"
                              >
                                <div className="text-sm font-medium">
                                  {label || it.model || it.stockId || it.vin}
                                  {color}
                                </div>
                                <div className="text-xs text-gray-500">
                                  {it.stockId ? `Stock ${it.stockId}` : ""}
                                  {it.stockId && it.vin ? " • " : ""}
                                  {it.vin ? `VIN ${it.vin}` : ""}
                                </div>
                              </button>
                            );
                          })
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {composeError ? <div className="text-xs text-red-600 mt-2">{composeError}</div> : null}

            <div className="mt-4 flex items-center justify-between">
              <button
                className="px-3 py-2 border rounded text-sm"
                onClick={() => setComposeOpen(false)}
                disabled={composeSending}
              >
                Cancel
              </button>
              <button
                className="px-3 py-2 border rounded text-sm"
                onClick={sendCompose}
                disabled={composeSending || composeSmsAttachmentsBusy}
              >
                {composeSending ? "Sending…" : composeSmsAttachmentsBusy ? "Processing…" : "Send SMS"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {campaignQueueSendDialogCampaignId ? (
        <div className="fixed inset-0 z-[70] flex items-start sm:items-center justify-center bg-black/40 p-3 sm:p-4 overflow-y-auto">
          <div className="w-full max-w-5xl rounded-lg bg-white shadow-lg border p-4 max-h-[94dvh] overflow-y-auto lr-campaign-dialog">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">Send campaign assets</div>
                <div className="text-xs text-gray-500">
                  {campaignQueueSendDialogEntry?.name || "Selected campaign"}
                </div>
              </div>
              <button
                className="px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)]"
                onClick={closeSendQueueSendDialog}
              >
                Close
              </button>
            </div>

            <div className="mt-3 border rounded-lg p-3 bg-gray-50">
              <div className="text-xs text-gray-600 mb-2">Choose recipients for this send.</div>
              <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                <label className="text-xs text-gray-600 min-w-[90px]">Recipients</label>
                <select
                  className="border rounded px-3 py-2 text-sm flex-1 bg-white"
                  value={campaignQueueSendDialogListId}
                  onChange={e => setCampaignQueueSendDialogListId(e.target.value)}
                >
                  <option value="all">All contacts</option>
                  {contactLists.map(list => (
                    <option key={`queue-send-list-${list.id}`} value={list.id}>
                      {list.name}
                      {Number.isFinite(Number(list.contactCount)) ? ` (${Number(list.contactCount)})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {!campaignQueueSendDialogEntry ? (
              <div className="mt-3 text-sm text-gray-600 border rounded p-3 bg-[var(--surface-2)]">
                Campaign not found. Refresh and try again.
              </div>
            ) : campaignQueueSendDialogTargets.length === 0 ? (
              <div className="mt-3 text-sm text-gray-600 border rounded p-3 bg-[var(--surface-2)]">
                No send-ready assets found for this campaign.
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                {campaignQueueSendDialogTargets.map((target, idx) => {
                  const isSms = target === "sms";
                  const isEmail = target === "email";
                  const busyKey = `send:${campaignQueueSendDialogEntry.id}:${target}`;
                  const isBusy = campaignQueueActionBusyKey === busyKey;
                  const asset = campaignFindGeneratedAsset(campaignQueueSendDialogEntry, target);
                  const smsBody = String(campaignQueueSendDialogEntry.smsBody ?? "").trim();
                  const emailSubject = String(campaignQueueSendDialogEntry.emailSubject ?? "").trim();
                  const emailBody =
                    String(campaignQueueSendDialogEntry.emailBodyText ?? "").trim() ||
                    String(campaignQueueSendDialogEntry.emailBodyHtml ?? "").trim();
                  const draftPreview = isSms ? smsBody : isEmail ? emailBody : "";
                  return (
                    <div
                      key={`queue-send-asset-${target}-${idx}`}
                      className="border rounded-lg bg-white p-3 space-y-3 flex flex-col"
                    >
                      <div className="text-xs font-semibold text-gray-700">
                        {CAMPAIGN_ASSET_TARGET_OPTIONS.find(opt => opt.value === target)?.label ?? target}
                      </div>
                      {asset?.url ? (
                        <a
                          href={asset.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block border rounded overflow-hidden bg-gray-50"
                        >
                          <img
                            src={asset.url}
                            alt={campaignAssetDisplayLabel(asset)}
                            className="w-full max-h-[300px] object-contain bg-white"
                            loading="lazy"
                          />
                        </a>
                      ) : null}
                      {isEmail ? (
                        <div className="space-y-2">
                          <div className="text-xs text-gray-600">
                            Subject:{" "}
                            <span className="font-medium text-gray-800">{emailSubject || "(missing subject)"}</span>
                          </div>
                          <div className="text-xs text-gray-600 border rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap">
                            {draftPreview || "No email draft content."}
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-gray-600 border rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap">
                          {draftPreview || "No SMS draft content."}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 mt-auto">
                        <button
                          className="px-3 py-2 border rounded text-xs bg-[var(--accent)] text-white border-[var(--accent)] hover:brightness-95 disabled:opacity-60"
                          disabled={Boolean(campaignQueueActionBusyKey)}
                          onClick={() => {
                            void sendQueuedCampaignAssetNow(campaignQueueSendDialogEntry, target);
                          }}
                        >
                          {isBusy ? "Sending..." : isEmail ? "Send Email" : "Send SMS"}
                        </button>
                      </div>
                      {isBusy ? <div className="text-[11px] text-gray-500">Sending selected asset…</div> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {campaignQueuePublishDialogCampaignId ? (
        <div className="fixed inset-0 z-[70] flex items-start sm:items-center justify-center bg-black/40 p-3 sm:p-4 overflow-y-auto">
          <div className="w-full max-w-5xl rounded-lg bg-white shadow-lg border p-4 max-h-[94dvh] overflow-y-auto lr-campaign-dialog">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">Publish post assets</div>
                <div className="text-xs text-gray-500">
                  {campaignQueuePublishDialogEntry?.name || "Selected campaign"}
                </div>
              </div>
              <button
                className="px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)]"
                onClick={closePostQueuePublishDialog}
              >
                Close
              </button>
            </div>

            <div className="mt-3 border rounded-lg p-3 bg-gray-50">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-gray-600">
                  Connect once, then publish selected post assets.
                </div>
                <div className="text-xs">
                  {metaLoading ? (
                    <span className="px-2 py-1 rounded border bg-gray-50 text-gray-600">Checking...</span>
                  ) : metaStatus?.connected ? (
                    <span className="px-2 py-1 rounded border border-green-200 bg-green-50 text-green-700">
                      Connected
                    </span>
                  ) : (
                    <span className="px-2 py-1 rounded border border-gray-300 bg-gray-50 text-gray-600">
                      Not connected
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 mt-2">
                <button
                  className="px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)] disabled:opacity-60"
                  onClick={() => {
                    void startMetaConnect();
                  }}
                  disabled={metaActionBusy}
                >
                  {metaActionBusy ? "Opening..." : "Connect Meta"}
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm hover:bg-[var(--surface-2)] disabled:opacity-60"
                  onClick={() => {
                    void loadMetaStatus();
                  }}
                  disabled={metaLoading || metaActionBusy}
                >
                  Refresh Meta
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
                  onClick={() => {
                    void disconnectMeta();
                  }}
                  disabled={metaActionBusy || !metaStatus?.connected}
                >
                  Disconnect
                </button>
              </div>
              {metaError ? <div className="text-xs text-red-600 mt-2">{metaError}</div> : null}
            </div>

            {!campaignQueuePublishDialogEntry ? (
              <div className="mt-3 text-sm text-gray-600 border rounded p-3 bg-[var(--surface-2)]">
                Campaign not found. Refresh and try again.
              </div>
            ) : campaignQueuePublishDialogAssets.length === 0 ? (
              <div className="mt-3 text-sm text-gray-600 border rounded p-3 bg-[var(--surface-2)]">
                No post-ready assets found for this campaign.
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                {campaignQueuePublishDialogAssets.map((asset, idx) => {
                  const target = asset.target;
                  const publishPlatform: "facebook" | "instagram" | "instagram_story" | null =
                    target === "facebook_post"
                      ? "facebook"
                      : target === "instagram_post"
                        ? "instagram"
                        : target === "instagram_story"
                          ? "instagram_story"
                          : null;
                  const publishLabel =
                    publishPlatform === "facebook"
                      ? "Publish Facebook Post"
                      : publishPlatform === "instagram"
                        ? "Publish Instagram Post"
                        : publishPlatform === "instagram_story"
                          ? "Publish Instagram Story"
                          : "Unsupported post asset";
                  const captionEnabled = publishPlatform !== "instagram_story";
                  const captionValue =
                    String(campaignQueuePublishCaptionByTarget[target] ?? "").trim() ||
                    campaignAutoPublishCaption(campaignQueuePublishDialogEntry);
                  const socialOptions = campaignNormalizeSocialPublishOptions(
                    campaignQueuePublishOptionsByTarget[target]
                  );
                  const busyKey = publishPlatform
                    ? `post:${campaignQueuePublishDialogEntry.id}:${target}:${publishPlatform}`
                    : "";
                  const isBusy = busyKey ? campaignQueueActionBusyKey === busyKey : false;
                  return (
                    <div
                      key={`queue-publish-asset-${target}-${idx}`}
                      className="border rounded-lg bg-white p-3 space-y-3 flex flex-col"
                    >
                      <div className="text-xs font-semibold text-gray-700">{campaignAssetDisplayLabel(asset)}</div>
                      <a
                        href={asset.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block border rounded overflow-hidden bg-gray-50"
                      >
                        <img
                          src={asset.url}
                          alt={campaignAssetDisplayLabel(asset)}
                          className="w-full max-h-[340px] object-contain bg-white"
                          loading="lazy"
                        />
                      </a>
                      {captionEnabled ? (
                        <label className="block text-xs text-gray-600">
                          Caption
                          <textarea
                            className="mt-1 w-full border rounded px-3 py-2 text-sm min-h-[88px]"
                            value={captionValue}
                            onChange={e => {
                              const next = e.target.value;
                              setCampaignQueuePublishCaptionByTarget(prev => ({ ...prev, [target]: next }));
                            }}
                          />
                        </label>
                      ) : (
                        <div className="text-[11px] text-gray-500 border rounded bg-gray-50 p-2">
                          Stories publish without captions. Use notes below for manual story overlays.
                        </div>
                      )}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <label className="block text-xs text-gray-600">
                          Link URL
                          <input
                            className="mt-1 w-full border rounded px-2 py-2 text-sm"
                            placeholder="https://..."
                            value={String(socialOptions.linkUrl ?? "")}
                            onChange={e => {
                              const next = campaignNormalizeSocialPublishOptions({
                                ...socialOptions,
                                linkUrl: e.target.value
                              });
                              setCampaignQueuePublishOptionsByTarget(prev => ({ ...prev, [target]: next }));
                            }}
                          />
                        </label>
                        <label className="block text-xs text-gray-600">
                          Mentions
                          <input
                            className="mt-1 w-full border rounded px-2 py-2 text-sm"
                            placeholder="@americanharley @rider"
                            value={String(socialOptions.mentionHandles ?? "")}
                            onChange={e => {
                              const next = campaignNormalizeSocialPublishOptions({
                                ...socialOptions,
                                mentionHandles: e.target.value
                              });
                              setCampaignQueuePublishOptionsByTarget(prev => ({ ...prev, [target]: next }));
                            }}
                          />
                        </label>
                        <label className="block text-xs text-gray-600">
                          Location
                          <input
                            className="mt-1 w-full border rounded px-2 py-2 text-sm"
                            placeholder="Virginia Beach, VA"
                            value={String(socialOptions.locationName ?? "")}
                            onChange={e => {
                              const next = campaignNormalizeSocialPublishOptions({
                                ...socialOptions,
                                locationName: e.target.value
                              });
                              setCampaignQueuePublishOptionsByTarget(prev => ({ ...prev, [target]: next }));
                            }}
                          />
                        </label>
                        <label className="block text-xs text-gray-600">
                          GIF URL
                          <input
                            className="mt-1 w-full border rounded px-2 py-2 text-sm"
                            placeholder="https://..."
                            value={String(socialOptions.gifUrl ?? "")}
                            onChange={e => {
                              const next = campaignNormalizeSocialPublishOptions({
                                ...socialOptions,
                                gifUrl: e.target.value
                              });
                              setCampaignQueuePublishOptionsByTarget(prev => ({ ...prev, [target]: next }));
                            }}
                          />
                        </label>
                        <label className="block text-xs text-gray-600">
                          Music Cue
                          <input
                            className="mt-1 w-full border rounded px-2 py-2 text-sm"
                            placeholder="Song/artist idea"
                            value={String(socialOptions.musicCue ?? "")}
                            onChange={e => {
                              const next = campaignNormalizeSocialPublishOptions({
                                ...socialOptions,
                                musicCue: e.target.value
                              });
                              setCampaignQueuePublishOptionsByTarget(prev => ({ ...prev, [target]: next }));
                            }}
                          />
                        </label>
                        <label className="block text-xs text-gray-600">
                          Sticker Note
                          <input
                            className="mt-1 w-full border rounded px-2 py-2 text-sm"
                            placeholder="Poll, emoji, countdown, etc."
                            value={String(socialOptions.stickerText ?? "")}
                            onChange={e => {
                              const next = campaignNormalizeSocialPublishOptions({
                                ...socialOptions,
                                stickerText: e.target.value
                              });
                              setCampaignQueuePublishOptionsByTarget(prev => ({ ...prev, [target]: next }));
                            }}
                          />
                        </label>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-auto">
                        <button
                          className="px-3 py-2 border rounded text-xs bg-[var(--accent)] text-white border-[var(--accent)] hover:brightness-95 disabled:opacity-60"
                          disabled={!metaStatus?.connected || Boolean(campaignQueueActionBusyKey) || !publishPlatform}
                          onClick={() => {
                            if (!publishPlatform) return;
                            void publishQueuedCampaignAssetNow(campaignQueuePublishDialogEntry, target, publishPlatform);
                          }}
                        >
                          {isBusy ? "Publishing..." : publishLabel}
                        </button>
                      </div>
                      {isBusy ? (
                        <div className="text-[11px] text-gray-500">Publishing selected asset…</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {watchEditOpen ? (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-3 sm:p-4 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-lg bg-white shadow-lg border p-4 max-h-[94dvh] overflow-y-auto">
            <div className="text-sm font-semibold">Edit vehicle watch</div>
            <div className="mt-3 space-y-3">
              {watchEditItems.map((item, idx) => {
                const modelOptions = getWatchModelChoices(item);
                const filteredModelOptions = filterWatchModelChoices(modelOptions, item.modelSearch);
                const groupModels = getItemModels(item);

                const makeOptionsLower = new Set(watchMakeOptions.map(o => o.toLowerCase()));
                const makeInOptions = makeOptionsLower.has((item.make ?? "").toLowerCase());
                const makeSelectValue = makeInOptions ? item.make : "__custom__";
                const showCustomMakeInput = watchMakeOptions.length === 0 || !makeInOptions;
                return (
                <div key={`watch-edit-${idx}`} className="border rounded p-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Condition</div>
                      <select
                        className="border rounded px-2 py-2 text-sm w-full"
                        value={item.condition}
                        onChange={e => updateWatchEditItem(idx, { condition: e.target.value })}
                      >
                        <option value="">Any</option>
                        <option value="new">New</option>
                        <option value="used">Pre-owned</option>
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Year</div>
                      <input
                        className="border rounded px-2 py-2 text-sm w-full"
                        placeholder="2026 or 2018-2021"
                        value={item.year}
                        onChange={e =>
                          updateWatchEditItem(idx, {
                            year: e.target.value,
                            model: "",
                            models: [],
                            customModel: "",
                            modelSearch: ""
                          })
                        }
                      />
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Make</div>
                      <select
                        className="border rounded px-2 py-2 text-sm w-full"
                        value={makeSelectValue}
                        onChange={e => {
                          const value = e.target.value;
                          if (value === "__custom__") {
                            updateWatchEditItem(idx, {
                              make: makeInOptions ? "" : item.make,
                              model: "",
                              models: [],
                              customModel: "",
                              modelSearch: ""
                            });
                            return;
                          }
                          updateWatchEditItem(idx, {
                            make: value,
                            model: "",
                            models: [],
                            customModel: "",
                            modelSearch: ""
                          });
                        }}
                      >
                        <option value="">Select make</option>
                        {watchMakeOptions.map(option => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                        <option value="__custom__">Other (type manually)</option>
                      </select>
                      {showCustomMakeInput ? (
                        <input
                          className="border rounded px-2 py-2 text-sm w-full mt-2"
                          placeholder="Type make"
                          value={item.make}
                          onChange={e => updateWatchEditItem(idx, { make: e.target.value })}
                        />
                      ) : null}
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Model</div>
                      {modelOptions.length ? (
                        <div className="border rounded p-2 max-h-48 overflow-auto">
                          <input
                            className="border rounded px-2 py-1 text-xs w-full mb-2"
                            placeholder="Search models..."
                            value={item.modelSearch ?? ""}
                            onChange={e => updateWatchEditItem(idx, { modelSearch: e.target.value })}
                          />
                          {filteredModelOptions.length ? filteredModelOptions.map(option => {
                            const checked = isWatchModelOptionChecked(groupModels, option);
                            return (
                              <label
                                key={`${option}-edit-multi`}
                                className="flex items-center gap-2 text-xs py-1"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={e => {
                                    const next = new Set(groupModels);
                                    if (e.target.checked) next.add(option);
                                    else next.delete(option);
                                    const list = Array.from(next);
                                    updateWatchEditItem(idx, {
                                      model: list[0] ?? "",
                                      models: list
                                    });
                                  }}
                                />
                                <span>{option}</span>
                              </label>
                            );
                          }) : (
                            <div className="text-xs text-gray-500">No models match search.</div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-500">No models for that year.</div>
                      )}
                      <div className="mt-2">
                        <div className="text-xs text-gray-500 mb-1">Other model (optional)</div>
                        <div className="flex gap-2">
                          <input
                            className="border rounded px-2 py-2 text-sm w-full"
                            placeholder="Type model"
                            value={item.customModel ?? ""}
                            onChange={e => updateWatchEditItem(idx, { customModel: e.target.value })}
                          />
                          <button
                            type="button"
                            className="px-3 py-2 border rounded text-sm"
                            onClick={() => {
                              const value = (item.customModel ?? "").trim();
                              if (!value) return;
                              const next = new Set(groupModels);
                              next.add(value);
                              const list = Array.from(next);
                              updateWatchEditItem(idx, {
                                model: list[0] ?? "",
                                models: list,
                                customModel: ""
                              });
                            }}
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Trim/Finish</div>
                      <input
                        className="border rounded px-2 py-2 text-sm w-full"
                        placeholder="Special, ST, Chrome trim…"
                        value={item.trim}
                        onChange={e => updateWatchEditItem(idx, { trim: e.target.value })}
                      />
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Color</div>
                      <input
                        className="border rounded px-2 py-2 text-sm w-full"
                        placeholder="Vivid Black"
                        value={item.color}
                        onChange={e => updateWatchEditItem(idx, { color: e.target.value })}
                      />
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Min Price (optional)</div>
                      <input
                        className="border rounded px-2 py-2 text-sm w-full"
                        placeholder="$4,000"
                        value={item.minPrice}
                        onChange={e => updateWatchEditItem(idx, { minPrice: e.target.value })}
                      />
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Max Price (optional)</div>
                      <input
                        className="border rounded px-2 py-2 text-sm w-full"
                        placeholder="$5,000"
                        value={item.maxPrice}
                        onChange={e => updateWatchEditItem(idx, { maxPrice: e.target.value })}
                      />
                    </div>
                  </div>
                  {watchEditItems.length > 1 ? (
                    <div className="mt-2 text-right">
                      <button
                        className="text-xs text-red-600"
                        onClick={() => removeWatchEditItem(idx)}
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                </div>
                );
              })}
              <button className="px-3 py-2 border rounded text-sm" onClick={addWatchEditItem}>
                Add another model
              </button>
              <div>
                <div className="text-xs text-gray-500 mb-1">Note (optional)</div>
                <textarea
                  className="border rounded px-3 py-2 text-sm w-full"
                  rows={2}
                  value={watchEditNote}
                  onChange={e => setWatchEditNote(e.target.value)}
                />
              </div>
            </div>

            {watchEditError ? (
              <div className="text-xs text-red-600 mt-2">{watchEditError}</div>
            ) : null}

            <div className="mt-4 flex justify-end gap-2 sticky bottom-0 bg-white pt-3 border-t -mx-4 px-4">
              <button
                className="px-3 py-2 border rounded text-sm"
                onClick={() => setWatchEditOpen(false)}
                disabled={watchEditSaving}
              >
                Cancel
              </button>
              <button
                className="px-3 py-2 border rounded text-sm text-red-600 border-red-200 hover:bg-red-50"
                onClick={async () => {
                  if (!watchEditConvId) return;
                  await deleteWatchForConv(watchEditConvId);
                  setWatchEditOpen(false);
                }}
                disabled={watchEditSaving}
              >
                Delete watch
              </button>
              <button
                className="px-3 py-2 border rounded text-sm"
                onClick={saveWatchEdit}
                disabled={watchEditSaving}
              >
                {watchEditSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>

    </main>
  );
}
