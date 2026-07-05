/**
 * Build the committed golden corpus fixture from the raw full-sweep dump — hardens PII redaction
 * (greeting names, staff intros, self-identification, re-applies email/phone) and wraps it with
 * provenance metadata. Read-only on the source; writes the fixture.
 *
 *   IN=/tmp/gold_corpus.json OUT=scripts/fixtures/genuine_error_gold_corpus.json npx tsx scripts/build_gold_corpus_fixture.ts
 */
import fs from "node:fs";
import path from "node:path";

const IN = process.env.IN || "/tmp/gold_corpus.json";
const OUT = process.env.OUT || "scripts/fixtures/genuine_error_gold_corpus.json";

// Recurring dealer staff first names (appear in intros/sign-offs) — redact for good hygiene.
const STAFF = ["alexandra", "scott", "joe", "stone", "giovanni", "gio", "rob", "stephanie", "dave", "mike", "joey"];

// Capitalized words that are NOT names — never redact these even after a vocative.
const STOP = new Set([
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday","mon","tue","tues","wed","thu","thur","thurs","fri","sat","sun",
  "january","february","march","april","may","june","july","august","september","october","november","december","jan","feb","mar","apr","jun","jul","aug","sep","sept","oct","nov","dec",
  "today","tomorrow","tonight","yes","no","sure","ok","okay","thanks","thank","harley","davidson","the","i","i'm","road","street","glide","fat","bob","boy","sportster","heritage","breakout","king","tri","cvo","ultra","classic","special","limited","american"
]);
const NAME_REPL = (lead: string, name: string) => (STOP.has(name.toLowerCase()) ? `${lead} ${name}` : `${lead} [NAME]`);

function hardenScrub(s: string): string {
  let t = String(s ?? "");
  // belt-and-suspenders: emails + phones again
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]");
  t = t.replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[PHONE]").replace(/\b\d{10,}\b/g, "[PHONE]");
  // vocative/greeting + name (incl. "Thanks Curtis", "No rush, Carmel", "Hi Sean") -> "[lead] [NAME]"
  const VOCATIVE = /\b(hi|hey|hello|dear|hiya|thanks|thank you|no rush|sounds good|ok|okay|congrats|congratulations|welcome|got it|will do|great|perfect|awesome|cheers|appreciate it)\b[\s,]+([A-Z][a-zA-Z'’.-]+)/gi;
  t = t.replace(VOCATIVE, (_m, lead, name) => NAME_REPL(lead, name));
  // staff/rep intros + sign-offs
  t = t.replace(/\bthis is\s+([A-Z][a-zA-Z'’.-]+)/gi, (_m, name) => NAME_REPL("this is", name).replace(/^this is /, "this is "));
  t = t.replace(/\b([A-Z][a-z]+)\s+here\b(?=\s+(from|at|with))/g, (_m, name) => (STOP.has(name.toLowerCase()) ? `${name} here` : "[NAME] here"));
  // self-identification ("I'm Sean", "it's Marcus")
  t = t.replace(/\b(i'?m|i am|it'?s)\s+([A-Z][a-z]+)\b/g, (_m, lead, name) => NAME_REPL(lead, name));
  // trailing comma-vocative name ("ok, Michael" / "see you, Jen") — redact a lone Capitalized word
  // after a comma/semicolon unless it's a known non-name (day/month/model/common word).
  t = t.replace(/([,;])\s+([A-Z][a-z]{2,})\b(?!\s+[A-Za-z])/g, (m, punc, name) => (STOP.has(name.toLowerCase()) ? m : `${punc} [NAME]`));
  // explicit staff first names anywhere (word-boundary, case-insensitive)
  for (const n of STAFF) t = t.replace(new RegExp(`\\b${n}\\b`, "gi"), "[NAME]");
  return t.trim();
}

const raw = JSON.parse(fs.readFileSync(IN, "utf8")) as any[];
const pairs = raw.map(p => ({
  ...p,
  customer: hardenScrub(p.customer),
  agentWrong: hardenScrub(p.agentWrong),
  humanRight: hardenScrub(p.humanRight),
  anchorModel: String(p.anchorModel ?? ""),
  convId: undefined // drop the (phone-derived) conv id entirely; re-index instead
})).map((p, i) => ({ id: `ge_${String(i + 1).padStart(3, "0")}`, ...p }));

// provenance + summary
const byMech: Record<string, number> = {}, byFrame: Record<string, number> = {};
for (const p of pairs) { byMech[p.mechanism] = (byMech[p.mechanism] ?? 0) + 1; byFrame[p.frame] = (byFrame[p.frame] ?? 0) + 1; }

const out = {
  meta: {
    description: "Golden corpus: confirmed genuine agent errors (human took over + the context-fidelity scorer agreed out_of_context) paired with the human's actual reply. The measurement corpus + golden-set seed + drift baseline for the answer-don't-deflect / context-fidelity work.",
    source: "scripts/genuine_error_full_sweep.ts over all americanharley conversations (2026-06-22)",
    totalPairs: pairs.length,
    genuineErrorRate: "42.4% of takeovers (219/517)",
    pii: "Best-effort redaction: emails, phones, ADF name/email/phone fields, greeting names, staff intros/sign-offs, self-identification, and known staff first names. Conversation ids dropped + re-indexed. Free-text names may still residually appear — do not treat as fully anonymized.",
    byMechanism: byMech,
    byFrame: byFrame,
    fields: "id, mechanism, frame, severity, pr1Fixable, anchorModel, customer (the turn), agentWrong (the bad draft), humanRight (the human's reply), steering"
  },
  pairs
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

// residual PII scan
const text = pairs.map(p => `${p.customer} ${p.agentWrong} ${p.humanRight}`).join("\n");
const resEmail = (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).length;
const resPhone = (text.match(/\b\d{7,}\b/g) || []).length;
const resGreetName = (text.match(/\b(hi|hey|hello|dear)\b[\s,]+[A-Z][a-z]+/gi) || []);
console.log(`Wrote ${pairs.length} pairs -> ${OUT}`);
console.log(`Residual scan: emails ${resEmail}, phone-like digit runs ${resPhone}, greeting+Name ${resGreetName.length}`);
if (resGreetName.length) console.log(`  greeting residuals (sample):`, resGreetName.slice(0, 8));
console.log(`byMechanism:`, byMech);
