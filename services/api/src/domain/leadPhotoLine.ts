/**
 * THE "here's a photo of one we have in stock" LINE — say which colour it actually is.
 *
 * THE DEFECT (customer-facing, +17165481952 Michael Hooker, 2026-08-07). Michael configured a
 * **2026 Low Rider S in Aurora Blue Denim** on Harley's own build tool and sent us the link. We
 * replied: *"Here's a photo of a 2026 Low Rider S in White Onyx Pearl Black Trim we have in
 * stock."* — no acknowledgement that it is a different bike from the one he built. Verified
 * against the live feed: there is no Aurora Blue Denim Low Rider S in stock (the 2026 units are
 * White Onyx Pearl Black Trim and Vivid Black Black Trim), so the PICK was right. Only the
 * sentence was wrong. To a customer who just chose a colour, it reads as if nobody looked.
 *
 * THE SECOND DEFECT, latent and worse. The old line sourced its colour as
 * `pick.color ?? conv.lead.vehicle.color`. When the matched inventory unit carries NO colour, that
 * fallback prints the colour the CUSTOMER asked for onto a unit we never verified — claiming
 * *"here's a photo of a 2026 Low Rider S in Aurora Blue Denim we have in stock"* for a bike we do
 * not have. 21 of the 24 photo lines in the live store went to leads with no configured colour, so
 * this had not fired yet; it is removed here rather than left armed. A colour we cannot read off
 * the unit is simply not stated.
 *
 * SAME PREDICATE AS THE PICKER. The colour comparison mirrors the scorer in
 * `routes/sendgridInbound.ts` exactly — normalise both sides, then `unit.includes(requested)` — so
 * the sentence and the pick can never disagree about whether a colour matched. (That containment
 * direction is deliberate: the feed appends trim to the colour, so a requested "Vivid Black" is a
 * match for a unit's "Vivid Black Black Trim".)
 *
 * DETERMINISTIC ON PURPOSE, and allowed to be. This compares two STRUCTURED fields already on the
 * record — the colour on the lead and the colour on the inventory unit — and picks copy.
 * Structured extraction, AGENTS.md's carve-out. Nothing here reads customer prose.
 *
 * NO PROMISE. The mismatch line deliberately does NOT offer to watch for the colour: an offer with
 * no side effect behind it is the `conditional-dealer-promise-mints-no-task` class. It states what
 * we have and stops.
 *
 * FAIL DIRECTION: toward saying LESS. Missing label => no line at all (today's behaviour); missing
 * unit colour => the line without a colour; unreadable input => no line.
 *
 * Pinned by scripts/lead_photo_line_eval.ts (ci:eval).
 */

export type LeadPhotoLineDecision = {
  /** The sentence to append, or null when there is nothing safe to say. */
  line: string | null;
  /** The colour we actually showed, once verified off the unit. */
  colorShown: string | null;
  /** The colour the customer configured on the lead. */
  colorRequested: string | null;
  /** True only when BOTH colours are known and they do not match. */
  colorDiffers: boolean;
  why: string;
};

/** Same normalisation the inventory picker uses: case- and punctuation-insensitive. */
function normalizeColor(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function decideLeadPhotoLine(input: {
  /** "2026 Low Rider S" — year + model, already assembled by the caller. */
  label: string | null | undefined;
  /** Colour read off the matched inventory unit. Unknown => we say no colour at all. */
  unitColor?: string | null;
  /** Colour the customer configured on the lead. */
  requestedColor?: string | null;
}): LeadPhotoLineDecision {
  const label = String(input?.label ?? "").trim();
  const unitColor = String(input?.unitColor ?? "").trim();
  const requestedColor = String(input?.requestedColor ?? "").trim();
  const base: LeadPhotoLineDecision = {
    line: null,
    colorShown: unitColor || null,
    colorRequested: requestedColor || null,
    colorDiffers: false,
    why: "no model label — nothing safe to say"
  };
  if (!label) return base;

  // A colour we cannot read off the UNIT is never stated. Borrowing the lead's colour here is how
  // we would claim stock we do not have.
  if (!unitColor) {
    return {
      ...base,
      line: `Here’s a photo of a ${label} we have in stock.`,
      colorShown: null,
      why: "unit colour unknown — state the bike, never a colour we did not verify"
    };
  }

  const unitNorm = normalizeColor(unitColor);
  const requestedNorm = normalizeColor(requestedColor);
  const differs = !!requestedNorm && !unitNorm.includes(requestedNorm);

  if (differs) {
    return {
      ...base,
      line:
        `Here’s a photo of a ${label} we have in stock — it’s ${unitColor} ` +
        `rather than the ${requestedColor} you were looking at.`,
      colorDiffers: true,
      why: "the unit on the floor is a different colour from the one they configured — say so"
    };
  }

  return {
    ...base,
    line: `Here’s a photo of a ${label} in ${unitColor} we have in stock.`,
    why: requestedNorm
      ? "the unit matches the colour they asked for"
      : "no colour requested — state the unit's colour as before"
  };
}
