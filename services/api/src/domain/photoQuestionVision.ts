import type { PhotoQuestionVisionRead } from "./llmDraft.js";

/**
 * Customer-facing copy for the photo-question vision feature (Joe 2026-07-28; Tim Williams asked why a
 * light was off in a photo we sent — with the other lights ON, so the bike was powered). Pure builders;
 * the decision (decidePhotoQuestionTurn) and the vision read (answerPhotoQuestionWithLLM) live elsewhere.
 *
 * Governance (the crux): the DESCRIBE/HANDOFF reply states only what's VISIBLE + the scene context and
 * hands the mechanical verification to a tech — it NEVER claims a part works, is broken, or why. A
 * belt-and-suspenders guard (stripFunctionalClaims) scrubs any working/broken/cause wording the vision
 * might have leaked into a functional-question answer. Pinned by photo_question_vision:eval.
 */

const greet = (firstName?: string | null): string => {
  const n = String(firstName ?? "").trim();
  return n ? `Hey ${n}` : "Hey";
};

// Words that assert FUNCTION / CONDITION — never allowed in a describe-and-handoff reply (we can't know
// from a still). Belt-and-suspenders on top of the vision prompt's hard rule.
const FUNCTIONAL_CLAIM_RE =
  /\b(works?|working|functional|operational|broken|burnt?\s*out|burned\s*out|blown|dead|faulty|defective|malfunction\w*|needs?\s+(?:to\s+be\s+)?(?:replac\w*|fix\w*|repair\w*)|is\s+fine|are\s+fine|all\s+good|nothing\s+wrong)\b/i;

/** True when text makes a function/condition claim we must not send from a photo. */
export function assertsFunctionalClaim(text: string | null | undefined): boolean {
  return FUNCTIONAL_CLAIM_RE.test(String(text ?? ""));
}

/** Benign VISUAL answer (part id / color / feature present) — the vision's own answer, when confident. */
export function buildPhotoQuestionVisualReply(args: {
  firstName?: string | null;
  read: Pick<PhotoQuestionVisionRead, "answer">;
}): string | null {
  const answer = String(args.read?.answer ?? "").trim();
  if (!answer) return null;
  // The vision answer is already customer-facing; just ensure a warm opener if it doesn't have one.
  if (/^(hey|hi|hello|good|sure|yep|yes|great|that|the|it|you)/i.test(answer)) return answer;
  return `${greet(args.firstName)} — ${answer}`;
}

/**
 * FUNCTIONAL / condition question: describe what's VISIBLE + the scene context, then hand to a tech.
 * Never a working/broken/cause claim — any leaked functional wording is scrubbed to the neutral read.
 */
export function buildPhotoQuestionHandoffReply(args: {
  firstName?: string | null;
  read: Pick<PhotoQuestionVisionRead, "observation" | "sceneState">;
}): string {
  const obs = assertsFunctionalClaim(args.read?.observation) ? "" : String(args.read?.observation ?? "").trim();
  const scene = assertsFunctionalClaim(args.read?.sceneState) ? "" : String(args.read?.sceneState ?? "").trim();
  const visible = [scene, obs].filter(Boolean).join(", ");
  const lead = visible
    ? `${greet(args.firstName)} — good eye. From the photo, ${visible}.`
    : `${greet(args.firstName)} — good eye.`;
  return `${lead} I don't want to guess on that from a picture, so I'll have one of our techs take a look and confirm, then follow up.`;
}

/** We couldn't read the photo confidently → offer a closer look (a human). */
export function buildPhotoQuestionCloserLookReply(args: { firstName?: string | null }): string {
  return `${greet(args.firstName)} — let me have someone take a closer look at that in the photo and get right back to you.`;
}

/** The tech-check task (owned by the lead owner, Joe ruling 2026-07-28). */
export function buildPhotoQuestionTaskSummary(args: { focus?: string | null; question?: string | null }): string {
  const focus = String(args.focus ?? "").trim();
  const focusPart = focus && focus !== "general" ? ` (the ${focus})` : "";
  const q = String(args.question ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  const qPart = q ? ` Customer asked: "${q}"` : "";
  return `Customer asked about something in the photo we sent${focusPart} — verify/confirm and follow up.${qPart}`;
}
