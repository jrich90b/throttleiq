import { promises as fs } from "node:fs";
import { dataPath } from "./dataDir.js";

export type InventoryNoteItem = {
  id: string;
  label?: string;
  note: string;
  updatedAt: string;
  expiresAt?: string;
};

type InventoryNoteEntry = {
  notes: InventoryNoteItem[];
  updatedAt: string;
};

type InventoryNotesStore = {
  notes: Record<string, InventoryNoteEntry>;
  savedAt?: string;
};

const FILE_NAME = "inventory_notes.json";

function normalizeKey(stockId?: string | null, vin?: string | null): string | null {
  const stock = (stockId ?? "").trim();
  if (stock) return stock.toLowerCase();
  const v = (vin ?? "").trim();
  if (v) return v.toLowerCase();
  return null;
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  // Treat date-only strings as inclusive through that day.
  const today = new Date().toISOString().slice(0, 10);
  return expiresAt < today;
}

async function loadStore(): Promise<InventoryNotesStore> {
  const filePath = dataPath(FILE_NAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      notes: parsed?.notes ?? {},
      savedAt: parsed?.savedAt
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { notes: {} };
    throw err;
  }
}

export function isInventoryNoteExpired(expiresAt?: string): boolean {
  return isExpired(expiresAt);
}

/**
 * Model/year-scope guard for surfacing a unit's inventory note in customer copy (Joe ruling
 * 2026-07-27). An inventory note (e.g. the "$1,000 trade-in credit" that lives on the 2025
 * Breakout stock) belongs to the UNIT it is listed under — it must only be narrated for that same
 * model+year, never borrowed onto another year's unit when the inventory lookup was broadened
 * across years (findInventoryMatches({year:null}) fallback). A note whose unit year differs from
 * the year we are narrating (the model-label year) is cross-year misattribution and must be
 * dropped. Returns true (surface it) only when the unit's year matches the narrated year, or when
 * no specific year is being claimed. Fail direction: DROP the note (a generic touch) rather than
 * attach a wrong-year offer.
 */
export function inventoryNoteMatchesNarratedYear(
  unitYear: string | null | undefined,
  narratedYear: string | null | undefined
): boolean {
  const narrated = String(narratedYear ?? "").trim();
  if (!narrated) return true; // no year claimed → not a cross-year misattribution
  const unit = String(unitYear ?? "").trim();
  return unit === narrated;
}

/**
 * Which unit a note belongs to, when the message narrates NO year (Joe report 2026-08-01,
 * +17736151296, Mark Walsh).
 *
 * `inventoryNoteMatchesNarratedYear` above closes the cross-year case, but it returns true
 * whenever no year is claimed — and the early-cadence promotion builder deliberately narrates no
 * year for a USED lead (`resolveCadencePreferredModelContext` nulls the year to stop stale
 * lead-year bleed). "No year claimed" is NOT "no unit claimed": the customer reads "the Breakout"
 * as THEIR Breakout, so the year guard is a no-op in exactly the case where borrowing is most
 * misleading — the model name is identical and only the year/condition differ.
 *
 * The production miss: Mark asked about a 2017 USED Breakout (stock U590-17). The
 * "2025 Promotion — Save $4,000 off list price" note lives on the NEW 2025 Breakouts
 * (S9-25/S13-25), the year-broadened lookup matched them, and the draft read "quick update on the
 * Breakout: Save $4,000 off list price." — a $4,000 discount the customer's bike does not get.
 * Joe corrected it by hand to "...on a new 2025 Breakout" and his steering was explicit: "state
 * the model year when mentioning discounts".
 *
 * So a note from a unit we cannot prove is the LEAD's unit gets ATTRIBUTED to the unit it actually
 * lives on, rather than dropped — the promo is real and worth sending, it just has to say which
 * bike it is on. Only when the source unit cannot be described (no year on the feed row) is the
 * note dropped, because an undescribable borrowed discount is the misstatement we started with.
 *
 * Deterministic by AGENTS.md: structured extraction over feed fields plus an invariant guard on a
 * pricing claim — no customer text is read here. Fail direction: attribute (honest, slightly more
 * verbose) or drop; never narrate another unit's discount as the customer's own.
 */
export type InventoryNoteAttribution =
  | { kind: "plain" }
  | { kind: "attribute"; phrase: string }
  | { kind: "drop" };

function normalizeUnitCondition(value: string | null | undefined): "new" | "used" | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (text === "new" || text === "new_model_interest") return "new";
  if (/used|pre-?owned|certified/.test(text)) return "used";
  return null;
}

export function decideInventoryNoteUnitAttribution(args: {
  unitYear?: string | null;
  unitCondition?: string | null;
  unitModel?: string | null;
  leadYear?: string | null;
  leadCondition?: string | null;
}): InventoryNoteAttribution {
  const unitYear = String(args.unitYear ?? "").trim();
  const leadYear = String(args.leadYear ?? "").trim();
  const unitCondition = normalizeUnitCondition(args.unitCondition);
  const leadCondition = normalizeUnitCondition(args.leadCondition);

  // Provably the SAME unit as the one the message names: same year, and no condition conflict.
  // Only this case keeps the bare copy, so an unknown lead year can never round up to "same unit".
  const sameYear = Boolean(unitYear) && Boolean(leadYear) && unitYear === leadYear;
  const conditionConflicts =
    Boolean(unitCondition) && Boolean(leadCondition) && unitCondition !== leadCondition;
  if (sameYear && !conditionConflicts) return { kind: "plain" };

  // A borrowed note must name its own unit. Without a year we cannot describe which bike it is.
  if (!unitYear) return { kind: "drop" };

  const model = String(args.unitModel ?? "").trim();
  const conditionWord = unitCondition ? `${unitCondition} ` : "";
  const phrase = `a ${conditionWord}${unitYear}${model ? ` ${model}` : ""}`.replace(/\s+/g, " ").trim();
  return { kind: "attribute", phrase };
}

/**
 * Collect the inventory notes the early-cadence promotion builder may narrate, applying BOTH
 * unit-scope rulings in one place (it also owns the per-unit note read, so index.ts stays a
 * caller rather than a second home for this policy):
 *  - Joe 2026-07-27 (+15854890786): when a YEAR is narrated, a note from another year's unit is
 *    dropped outright — never borrow one year's credit onto another year's unit.
 *  - Joe 2026-08-01 (+17736151296): when NO year is narrated, the customer reads the bare model
 *    label as their own bike, so a note from a unit that is not provably theirs is attributed to
 *    the unit it lives on ("... on a new 2025 Breakout"), or dropped if it cannot be described.
 * Returns at most `max` distinct note strings, in feed order.
 */
export async function collectCadenceInventoryNotes(args: {
  items: Array<{
    stockId?: string | null;
    vin?: string | null;
    year?: string | null;
    condition?: string | null;
  }>;
  narratedYear: string | null;
  model: string | null;
  leadYear: string | null;
  leadCondition: string | null;
  max?: number;
}): Promise<string[]> {
  const max = Number.isFinite(args.max) ? Number(args.max) : 2;
  const noteSet = new Set<string>();
  for (const item of args.items ?? []) {
    if (!inventoryNoteMatchesNarratedYear(item?.year ?? null, args.narratedYear)) continue;
    const note = await getInventoryNote(item?.stockId ?? null, item?.vin ?? null);
    const cleaned = String(note ?? "").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    if (String(args.narratedYear ?? "").trim()) {
      // A year IS narrated, so the guard above already proved this unit is the one being named.
      noteSet.add(cleaned);
    } else {
      const attribution = decideInventoryNoteUnitAttribution({
        unitYear: item?.year ?? null,
        unitCondition: item?.condition ?? null,
        unitModel: args.model,
        leadYear: args.leadYear,
        leadCondition: args.leadCondition
      });
      if (attribution.kind === "drop") continue;
      noteSet.add(attribution.kind === "attribute" ? `${cleaned} on ${attribution.phrase}` : cleaned);
    }
    if (noteSet.size >= max) break;
  }
  return Array.from(noteSet);
}

async function saveStore(store: InventoryNotesStore): Promise<void> {
  const filePath = dataPath(FILE_NAME);
  const payload = {
    notes: store.notes ?? {},
    savedAt: new Date().toISOString()
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

export async function getInventoryNote(stockId?: string | null, vin?: string | null): Promise<string | null> {
  const key = normalizeKey(stockId, vin);
  if (!key) return null;
  const store = await loadStore();
  const entry = store.notes?.[key];
  if (!entry?.notes?.length) return null;
  const active = entry.notes.filter(n => !isExpired(n.expiresAt) && n.note?.trim());
  if (!active.length) return null;
  const top = active.slice(0, 2).map(n => n.note.trim());
  if (top.length === 1) return top[0];
  return `${top[0]} and ${top[1]}`;
}

export async function listInventoryNotes(): Promise<Record<string, InventoryNoteEntry>> {
  const store = await loadStore();
  return store.notes ?? {};
}

export async function setInventoryNote(opts: {
  stockId?: string | null;
  vin?: string | null;
  notes: InventoryNoteItem[];
}): Promise<void> {
  const key = normalizeKey(opts.stockId, opts.vin);
  if (!key) return;
  const store = await loadStore();
  const cleaned = (opts.notes ?? [])
    .map(n => ({
      id: n.id,
      label: n.label?.trim() || undefined,
      note: String(n.note ?? "").trim(),
      updatedAt: n.updatedAt || new Date().toISOString(),
      expiresAt: n.expiresAt ? String(n.expiresAt).trim() : undefined
    }))
    .filter(n => n.note);

  if (!cleaned.length) {
    delete store.notes[key];
    await saveStore(store);
    return;
  }
  store.notes[key] = { notes: cleaned, updatedAt: new Date().toISOString() };
  await saveStore(store);
}
